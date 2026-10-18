import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { configSchema } from '../src/config.js';
import { Store } from '../src/store.js';
import { Pool } from '../src/pool.js';
import { createServer } from '../src/server.js';

async function application(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'pool-mcp-'));
  const executable = path.join(root, 'fake-codex.js');
  writeFileSync(executable, `if(process.argv.includes('login')){console.log('Logged in using ChatGPT')}else{process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'verified result'}}));console.log(JSON.stringify({type:'turn.completed'}))})}`);
  const config = configSchema.parse({ workspaceRoots: [root], routes: [{ id: 'test', adapter: 'codex', executable, enabled: true, billing: 'subscription', models: [{ id: 'test-model', alias: 'Test', group: 'default', kinds: ['read'] }] }] });
  const store = new Store(path.join(root, 'pool.sqlite'));
  const pool = new Pool(config, store);
  const token = randomBytes(32).toString('hex');
  const managementToken = randomBytes(32).toString('hex');
  writeFileSync(path.join(root, 'config.json'), JSON.stringify(config));
  const app = createServer(pool, token, 0, { directory: root, token: managementToken });
  const address = await app.listen();
  t.after(async () => { app.server.close(); app.server.closeAllConnections(); await pool.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, pool, token, managementToken, app, url: new URL(`http://127.0.0.1:${address.port}/mcp`) };
}

test('HTTP boundary rejects missing/wrong auth, foreign Host and browser Origin', async t => {
  const { url, token } = await application(t);
  const base = { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } };
  assert.equal((await fetch(url, base)).status, 401);
  assert.equal((await fetch(url, { ...base, headers: { ...base.headers, Authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await fetch(url, { ...base, headers: { ...base.headers, Authorization: `Bearer ${token}`, Origin: 'https://attacker.invalid' } })).status, 403);
  const foreignHost = await new Promise((resolve, reject) => {
    const request = http.request(url, { method: 'POST', headers: { ...base.headers, Authorization: `Bearer ${token}`, Host: 'attacker.invalid' } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject); request.end('{}');
  });
  assert.equal(foreignHost, 403);
  assert.equal((await fetch(url, { ...base, headers: { ...base.headers, Authorization: `Bearer ${token}` }, body: '{' })).status, 400);
  assert.equal((await fetch(url, { ...base, headers: { ...base.headers, Authorization: `Bearer ${token}` }, body: ' '.repeat(262_145) })).status, 413);
});

test('agent token cannot manage policy; admin updates are revision-bound', async t => {
  const { url, token, managementToken, pool } = await application(t);
  const managementURL = new URL('/manage', url);
  const post = (bearer, body) => fetch(managementURL, { method: 'POST', headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post(token, { operation: 'get' })).status, 401);
  const initial = await (await post(managementToken, { operation: 'get' })).json();
  initial.config.routes[0].enabled = false;
  const saved = await post(managementToken, { operation: 'save', ...initial });
  assert.equal(saved.status, 200); assert.equal(pool.config.routes[0].enabled, false);
  const conflict = await post(managementToken, { operation: 'save', ...initial });
  assert.equal(conflict.status, 409);
  assert.equal(pool.config.routes[0].enabled, false);
});

test('real MCP client discovers tools and executes shell-free fake CLI through persistent task pool', async t => {
  const { root, url, token, pool } = await application(t);
  const client = new Client({ name: 'pool-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  t.after(() => client.close());
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 9);
  const input = { prompt: 'Read only', workspace: root, kind: 'read', idempotencyKey: 'mcp-request-123' };
  const first = await client.callTool({ name: 'pool_submit', arguments: input });
  assert.ok(!first.isError);
  const task = first.structuredContent.data;
  const second = await client.callTool({ name: 'pool_submit', arguments: input });
  assert.equal(second.structuredContent.data.id, task.id);
  let result;
  for (let i = 0; i < 150; i++) {
    result = await client.callTool({ name: 'pool_get_task', arguments: { taskId: task.id } });
    if (result.structuredContent.data.state === 'succeeded') break;
    await delay(30);
  }
  assert.equal(result.structuredContent.data.result, 'verified result');
  assert.equal(pool.list().length, 1);
  assert.equal(pool.list()[0].result, undefined);
  const conflict = await client.callTool({ name: 'pool_submit', arguments: { ...input, prompt: 'different' } });
  assert.ok(conflict.isError); assert.match(conflict.content[0].text, /IDEMPOTENCY_CONFLICT/);
  const denied = await client.callTool({ name: 'pool_submit', arguments: { ...input, workspace: tmpdir(), idempotencyKey: 'denied-request-123' } });
  assert.ok(denied.isError); assert.match(denied.content[0].text, /WORKSPACE_DENIED/);
});
