import test from 'node:test';
import assert from 'node:assert/strict';
import { visibleRoutes } from '../web/pool-state.js';
import { configSchema } from '../src/config.js';
import { Pool } from '../src/pool.js';
import { Store } from '../src/store.js';
import { callPoolTool } from '../src/daemon.js';

test('disabled routes disappear independently without changing configuration or other route visibility', () => {
  const config = {
    routes: [
      { id: 'disabled', enabled: false, models: [{ id: 'shared', memberships: [{ group: 'high' }] }] },
      { id: 'enabled', enabled: true, models: [{ id: 'shared', memberships: [{ group: 'low' }] }] },
    ],
  };
  const before = structuredClone(config);

  assert.deepEqual(visibleRoutes(config).map(route => route.id), ['enabled']);
  assert.deepEqual(config, before);
  config.routes[0].enabled = true;
  assert.deepEqual(visibleRoutes(config).map(route => route.id), ['disabled', 'enabled']);
  assert.deepEqual(config.routes.map(route => route.models[0].memberships), [[{ group: 'high' }], [{ group: 'low' }]]);
});

test('legacy route selection flags do not restrict an available free model', async t => {
  const config = configSchema.parse({
    selectionMode: 'auto',
    routes: [{
      id: 'owner-route', adapter: 'custom', executable: process.execPath, argsTemplate: ['--version'],
      billing: 'paid_api', enabled: true, autoSelect: false,
      models: [{ id: 'free-model', billing: 'free', alias: 'Free model', group: 'medium', kinds: ['text'], efforts: [] }],
    }],
  });
  const store = new Store(':memory:');
  const pool = new Pool(config, store);
  t.after(async () => { await pool.close(); store.close(); });

  assert.equal(pool.models()[0].billing, 'free');
  assert.equal(pool.models()[0].autoSelect, false);
  assert.equal(pool.select({kind:'text'}).selected.id,'free-model');
  assert.equal(pool.select({ kind: 'text', routeId: 'owner-route', modelId: 'free-model' }).selected.id, 'free-model');
});

test('callPoolTool maps plain text MCP errors and preserves JSON error and success responses', async () => {
  const clientFor = response => ({ callTool: async () => response });

  await assert.rejects(callPoolTool(clientFor({ isError: true, content: [{ type: 'text', text: 'plain text failure' }] }), 'example'), error => {
    assert.equal(error.code, 'TOOL_FAILED');
    assert.notEqual(error.constructor.name, 'SyntaxError');
    return true;
  });
  await assert.rejects(callPoolTool(clientFor({ isError: true, content: [{ type: 'text', text: JSON.stringify({ error: { code: 'OWNER_DENIED', message: 'Owner policy denied' } }) }] }), 'example'), error => {
    assert.equal(error.code, 'OWNER_DENIED');
    assert.equal(error.message, 'Owner policy denied');
    return true;
  });
  assert.deepEqual(await callPoolTool(clientFor({ isError: false, content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] }), 'example'), { ok: true });
});
