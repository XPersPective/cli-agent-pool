import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { configSchema, configView, saveConfig, loadConfig } from '../src/config.js';
import { modelSaveConfig, mergeScanDraft, addMembership, preferenceSaveConfig } from '../web/pool-state.js';

test('model autosave persists membership and effort without committing unrelated settings', () => {
  const base = { selectionMode: 'manual', routes: [{ id: 'codex', enabled: false, billing: 'subscription', priority: 100, models: [{ id: 'luna', alias: 'Luna', group: 'unassigned', enabled: true, efforts: ['low', 'high'] }] }] };
  const draft = structuredClone(base), route = draft.routes[0];
  draft.selectionMode = 'auto'; route.billing = 'paid_api'; route.priority = 9;
  route.models[0].alias = 'Uncommitted alias';
  addMembership(route.models[0], 'low', 'low'); route.enabled = true;
  assert.equal(modelSaveConfig(base, draft, 'codex', 'luna').routes[0].enabled, false);
  const saved = modelSaveConfig(base, draft, 'codex', 'luna', true);
  assert.deepEqual(saved.routes[0].models[0].memberships, [{ group: 'low', effort: 'low' }]);
  assert.equal(saved.routes[0].enabled, true);
  assert.equal(saved.routes[0].billing, 'subscription');
  assert.equal(saved.routes[0].priority, 100);
  assert.equal(saved.selectionMode, 'manual');
  assert.equal(saved.routes[0].models[0].alias, 'Luna');
  assert.deepEqual(mergeScanDraft(saved, base, draft), draft);
  assert.equal(base.routes[0].models[0].memberships, undefined);
  addMembership(saved.routes[0].models[0], 'low', 'high');
  const effort = modelSaveConfig(saved, saved, 'codex', 'luna');
  assert.deepEqual(effort.routes[0].models[0].memberships, [{ group: 'low', effort: 'high' }]);
  effort.routes[0].models[0].memberships = [];
  assert.deepEqual(modelSaveConfig(saved, effort, 'codex', 'luna').routes[0].models[0].memberships, []);
});

test('new catalog models are saved independently and unsaved connections are rejected', () => {
  const base = { routes: [{ id: 'codex', enabled: true, billing: 'subscription', models: [] }] };
  const draft = structuredClone(base);
  const model = { id: 'new-version-7', group: 'unassigned', efforts: [], enabled: true };
  draft.routes[0].models.push(model); draft.routes[0].billing = 'paid_api';
  const saved = modelSaveConfig(base, draft, 'codex', model.id);
  assert.deepEqual(saved.routes[0].models, [model]);
  assert.equal(saved.routes[0].billing, 'subscription');
  assert.throws(() => modelSaveConfig(base, draft, 'missing', model.id));
  assert.throws(() => modelSaveConfig(base, draft, 'codex', 'missing'));
});


test('pool policy autosave is durable without committing unrelated drafts', () => {
  const base = { selectionMode: 'auto', groupingMode: 'manual', concurrency: 1, modelFilters: [], routes: [{ id: 'codex', billing: 'subscription', models: [{ id: 'luna', memberships: [{ group: 'low', effort: 'low' }] }] }] };
  const draft = structuredClone(base);
  draft.selectionMode = 'manual'; draft.groupingMode = 'agent';
  draft.concurrency = 2;
  draft.routes[0].billing = 'paid_api';
  const saved = preferenceSaveConfig(base, draft, 'selectionMode');
  assert.equal(saved.selectionMode, 'manual');
  assert.equal(saved.groupingMode, 'manual');
  assert.deepEqual(saved.routes, base.routes);
  assert.deepEqual(mergeScanDraft(saved, base, draft), draft);
  const permissions = preferenceSaveConfig(saved, draft, 'groupingMode');
  assert.equal(permissions.selectionMode, 'manual');
  assert.equal(permissions.groupingMode, 'agent');
  assert.equal(permissions.concurrency, 1);
  const execution = preferenceSaveConfig(permissions, draft, 'concurrency');
  assert.equal(execution.concurrency, 2);
  assert.equal(execution.selectionMode, 'manual');
  assert.deepEqual(permissions.routes, base.routes);
  assert.throws(() => preferenceSaveConfig(base, draft, 'routes'));
  assert.equal(base.selectionMode, 'auto');
});


test('pool selection and membership reload from disk in a fresh session', t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'pool-policy-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const base = configSchema.parse({ workspaceRoots: [], routes: [{ id: 'codex', adapter: 'codex', executable: process.execPath, billing: 'subscription', models: [{ id: 'luna', alias: 'Luna', kinds: ['text'], group: 'unassigned', efforts: ['low'] }] }] });
  writeFileSync(path.join(directory, 'config.json'), JSON.stringify(base));
  const draft = structuredClone(base);
  addMembership(draft.routes[0].models[0], 'low', 'low');
  saveConfig(directory, modelSaveConfig(base, draft, 'codex', 'luna', true), configView(directory).revision);
  const saved = configView(directory);
  draft.selectionMode = 'manual';
  saveConfig(directory, preferenceSaveConfig(saved.config, draft, 'selectionMode'), saved.revision);
  const restarted = loadConfig(directory);
  assert.equal(restarted.selectionMode, 'manual');
  assert.equal(restarted.routes[0].enabled, true);
  assert.deepEqual(restarted.routes[0].models[0].memberships, [{ group: 'low', effort: 'low' }]);
});
