import test from 'node:test';
import assert from 'node:assert/strict';
import { modelSaveConfig, mergeScanDraft, addMembership } from '../web/pool-state.js';

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
