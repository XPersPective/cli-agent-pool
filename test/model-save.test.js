import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { configSchema, configView, saveConfig, loadConfig } from '../src/config.js';
import { modelSaveConfig, batchModelSaveConfig, mergeScanDraft, addMembership, preferenceSaveConfig } from '../web/pool-state.js';

test('model autosave persists membership and effort without committing unrelated settings', () => {
  const base = { categories: [{id:'low',name:'Low'}], routes: [{ id: 'codex', enabled: false, billing: 'subscription', priority: 100, models: [{ id: 'luna', alias: 'Luna', group: 'unassigned', enabled: true, efforts: ['low', 'high'] }] }] };
  const draft = structuredClone(base), route = draft.routes[0];
  draft.categories[0].name = 'Low renamed'; route.billing = 'paid_api'; route.priority = 9;
  route.models[0].alias = 'Uncommitted alias';
  addMembership(route.models[0], 'low', 'low'); route.enabled = true;
  assert.equal(modelSaveConfig(base, draft, 'codex', 'luna').routes[0].enabled, false);
  const saved = modelSaveConfig(base, draft, 'codex', 'luna', true);
  assert.deepEqual(saved.routes[0].models[0].memberships, [{ group: 'low', effort: 'low' }]);
  assert.equal(saved.routes[0].enabled, true);
  assert.equal(saved.routes[0].billing, 'subscription');
  assert.equal(saved.routes[0].priority, 100);
  assert.equal(saved.categories[0].name, 'Low');
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


test('category autosave persists without committing billing or concurrency drafts', () => {
  const base={categories:[{id:'low',name:'Low'}],concurrency:1,routes:[{id:'codex',billing:'subscription',maxConcurrent:1,models:[]}]};
  const draft=structuredClone(base);draft.categories.push({id:'research',name:'Research'});draft.concurrency=30;draft.routes[0].billing='paid_api';
  const saved=preferenceSaveConfig(base,draft,'categories');assert.equal(saved.categories.length,2);assert.equal(saved.concurrency,1);assert.deepEqual(saved.routes,base.routes);
  assert.equal(mergeScanDraft(saved,base,draft).routes[0].billing,'paid_api');
  assert.throws(()=>preferenceSaveConfig(saved,draft,'concurrency'));
  assert.throws(()=>preferenceSaveConfig(base,draft,'selectionMode'));assert.throws(()=>preferenceSaveConfig(base,draft,'groupingMode'));
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
  draft.categories.find(c=>c.id==='low').name='Light';
  saveConfig(directory, preferenceSaveConfig(saved.config, draft, 'categories'), saved.revision);
  const restarted = loadConfig(directory);
  assert.equal(restarted.categories.find(c=>c.id==='low').name,'Light');assert.equal(restarted.selectionMode,undefined);
  assert.equal(restarted.routes[0].enabled, true);
  assert.deepEqual(restarted.routes[0].models[0].memberships, [{ group: 'low', effort: 'low' }]);
});

test('batchModelSaveConfig saves multiple selected models across routes in one revision', () => {
  const base = {
    categories: [{ id: 'low', name: 'Low' }],
    routes: [
      { id: 'codex-local', enabled: false, billing: 'subscription', models: [{ id: 'm1', alias: 'M1', group: 'unassigned', enabled: false, efforts: ['low'] }, { id: 'm2', alias: 'M2', group: 'unassigned', enabled: false, efforts: ['low'] }] },
      { id: 'agy-local', enabled: false, billing: 'subscription', models: [{ id: 'g1', alias: 'G1', group: 'unassigned', enabled: false, efforts: [] }] },
    ],
  };
  const draft = structuredClone(base);
  addMembership(draft.routes[0].models[0], 'low', 'low'); draft.routes[0].models[0].enabled = true; draft.routes[0].enabled = true;
  addMembership(draft.routes[1].models[0], 'low', ''); draft.routes[1].models[0].enabled = true; draft.routes[1].enabled = true;
  const saved = batchModelSaveConfig(base, draft, [{ routeId: 'codex-local', modelId: 'm1' }, { routeId: 'agy-local', modelId: 'g1' }], true);
  assert.equal(saved.routes[0].enabled, true);
  assert.equal(saved.routes[1].enabled, true);
  assert.deepEqual(saved.routes[0].models[0].memberships, [{ group: 'low', effort: 'low' }]);
  assert.deepEqual(saved.routes[1].models[0].memberships, [{ group: 'low' }]);
  assert.equal(saved.routes[0].models[1].enabled, false);
});
