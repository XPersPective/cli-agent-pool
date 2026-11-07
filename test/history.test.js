import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { browserUI } from '../src/web.js';

const insert = (store, id, state) => {
  store.insert({id, key: id, fingerprint: id, workspace: 'project', request: {prompt: 'request'}});
  store.update(id, state, 'result');
};

test('history stays within 500 completed records and purges old events and keys', () => {
  const store = new Store(':memory:');
  try {
    for (let i = 0; i < 510; i++) insert(store, `task-${i}`, 'succeeded');
    assert.equal(store.list(1000).length, 500);
    assert.equal(store.byKey('task-0'), undefined);
    assert.equal(store.events('task-0').length, 0);
    store.db.prepare('UPDATE tasks SET updated=? WHERE id=?').run('2000-01-01', 'task-509');
    assert.equal(store.pruneHistory().removed, 1);
    assert.equal(store.get('task-509'), undefined);
    assert.equal(store.get('task-508').result, 'result');
  } finally { store.close(); }
});

test('UI history cleanup removes every terminal state and preserves queued, running and review tasks', async () => {
  const store = new Store(':memory:');
  try {
    for (const state of ['succeeded','failed','timed_out','cancelled','queued','starting','running','cancelling','needs_review']) insert(store, state, state);
    const ui = browserUI({store, resolve: async id => { store.update(id, 'failed', 'dismissed'); return {}; }}, {directory: '.', token: 'a'.repeat(64)});
    assert.deepEqual(await ui.operation({operation: 'clear_history'}), {removed: 4});
    assert.deepEqual(store.list().map(t => t.state).sort(), ['queued','starting','running','cancelling','needs_review'].sort());
    assert.equal(store.events('running').length, 1);
    assert.deepEqual(store.clearHistory(), {removed: 0});
    assert.deepEqual(await ui.operation({operation: 'clear_history', payload: {includeReview: true}}), {removed: 1});
    assert.equal(store.get('needs_review'), undefined);
    insert(store, 'single-failed', 'failed');
    assert.deepEqual(await ui.operation({operation: 'delete_task', payload: {taskId: 'single-failed'}}), {removed: 1});
    assert.equal(store.get('single-failed'), undefined);
  } finally { store.close(); }
});
