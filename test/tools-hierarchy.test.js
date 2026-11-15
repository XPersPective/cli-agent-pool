import test from 'node:test';
import assert from 'node:assert/strict';
import { filterHierarchy } from '../web/pool-state.js';

const adapterLabels = { codex: 'Codex', claude: 'Claude', agy: 'Antigravity' };
const emails = { 'codex-local': 'dev@example.com', 'claude-acc2': 'other@example.com' };

const entries = [
  { route: { id: 'codex-local', adapter: 'codex', enabled: true }, model: { id: 'gpt-5' } },
  { route: { id: 'codex-local', adapter: 'codex', enabled: true }, model: { id: 'gpt-5-codex' } },
  { route: { id: 'claude-acc2', adapter: 'claude', enabled: true }, model: { id: 'claude-opus-5' } },
  { route: { id: 'agy-local', adapter: 'agy', enabled: false }, model: { id: 'gemini-4-argon' } },
];

test('Tümü seçiliyken abonelik şeridi tüm araçların aboneliklerini listeler', () => {
  const result = filterHierarchy(entries, { tool: '__all__', routeId: '__all__', family: '__all__' }, emails, adapterLabels);

  assert.equal(result.tool, '__all__');
  assert.equal(result.subscriptions[0].id, '__all__');
  assert.equal(result.subscriptions[0].label, 'Tümü');
  const ids = result.subscriptions.slice(1).map(item => item.id);
  assert.deepEqual(ids.sort(), ['agy-local', 'claude-acc2', 'codex-local']);
  // Araç etiketi, farklı araçların aboneliklerini birbirinden ayırır.
  const labels = result.subscriptions.slice(1).map(item => item.label);
  assert.ok(labels.some(label => label.startsWith('Codex · ')));
  assert.ok(labels.some(label => label.startsWith('Claude · ')));
  assert.ok(labels.some(label => label.startsWith('Antigravity · ')));
  assert.equal(result.filtered.length, entries.length);
});

test('Bir abonelik seçildiğinde yalnız o aboneliğin modelleri kalır', () => {
  const result = filterHierarchy(entries, { tool: '__all__', routeId: 'codex-local', family: '__all__' }, emails, adapterLabels);

  assert.equal(result.routeId, 'codex-local');
  assert.deepEqual(result.filtered.map(item => item.model.id), ['gpt-5', 'gpt-5-codex']);
});

test('Araç seçilince yalnız o aracın abonelikleri ve modelleri listelenir', () => {
  const result = filterHierarchy(entries, { tool: 'codex', routeId: '__all__', family: '__all__' }, emails, adapterLabels);

  assert.equal(result.tool, 'codex');
  assert.deepEqual(result.subscriptions.map(item => item.id), ['__all__', 'codex-local']);
  assert.equal(result.subscriptions[1].label, 'dev@example.com');
  assert.equal(result.filtered.length, 2);
});

test('Kapalı abonelik şeritte işaretlenir ve seçili araç dışı abonelik reddedilir', () => {
  const result = filterHierarchy(entries, { tool: '__all__', routeId: 'agy-local', family: '__all__' }, emails, adapterLabels);
  assert.equal(result.routeId, 'agy-local');

  const closed = result.subscriptions.find(item => item.id === 'agy-local');
  assert.equal(closed.enabled, false);

  const invalid = filterHierarchy(entries, { tool: '__all__', routeId: 'bilinmeyen', family: '__all__' }, emails, adapterLabels);
  assert.equal(invalid.routeId, '__all__');
});
