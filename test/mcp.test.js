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
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
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
  config.port = address.port;
  writeFileSync(path.join(root, 'config.json'), JSON.stringify({ ...config, port: address.port }));
  writeFileSync(path.join(root, 'access-token'), token);
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

test('standalone dashboard uses one-time login, signed HttpOnly cookie and same-origin CSRF checks', async t => {
  const { url, app, token } = await application(t);
  const rootURL = new URL('/', url);
  assert.equal((await fetch(rootURL)).status, 401);
  const pairingURL = app.uiURL();
  const login = await fetch(pairingURL, { redirect: 'manual' });
  assert.equal(login.status, 303);
  const setCookie = login.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/); assert.match(setCookie, /SameSite=Strict/);
  const cookie = setCookie.split(';')[0];
  assert.equal((await fetch(pairingURL, { redirect: 'manual' })).status, 401);
  const page = await fetch(rootURL, { headers: { Cookie: cookie } });
  assert.equal(page.status, 200); assert.match(await page.text(), /CLI Agent Pool/);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const post = (origin, session = cookie) => fetch(new URL('/ui', url), { method: 'POST', headers: { Cookie: session, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ operation: 'snapshot' }) });
  assert.equal((await post('https://attacker.invalid')).status, 403);
  assert.equal((await post(url.origin, cookie.slice(0, -1) + 'x')).status, 403);
  const result = await post(url.origin); assert.equal(result.status, 200);
  const view = await result.json(); assert.deepEqual(view.installed.map(cli => cli.adapter), ['codex', 'claude', 'qwen', 'opencode', 'mmx']);
  assert.ok(!JSON.stringify(view).includes(token));
  assert.equal((await fetch(url, { method: 'POST', headers: { Cookie: cookie, Origin: url.origin, 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
});

test('stdio MCP connector shares the HTTP owner without putting secrets in tool configuration', async t => {
  const { root, pool } = await application(t);
  const client = new Client({ name: 'stdio-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../bin/pool.js', import.meta.url)), 'stdio'], env: { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => ['PATH', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP'].includes(name))), CLI_AGENT_POOL_HOME: root }, stderr: 'pipe' }));
  t.after(() => client.close());
  assert.equal((await client.listTools()).tools.length, 9);
  const response = await client.callTool({ name: 'pool_submit', arguments: { prompt: 'Test through stdio', workspace: root, kind: 'read', idempotencyKey: 'stdio-test-123' } });
  assert.ok(!response.isError);
  assert.equal(pool.list()[0].id, response.structuredContent.data.id);
});

test('browser session remains valid through a service restart on the same private capability', async t => {
  const { url, app, pool, token, root, managementToken } = await application(t);
  const login = await fetch(app.uiURL(), { redirect: 'manual' });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  app.server.closeAllConnections();
  await new Promise(resolve => app.server.close(resolve));
  const replacement = createServer(pool, token, Number(url.port), { directory: root, token: managementToken });
  await replacement.listen();
  t.after(() => { replacement.server.close(); replacement.server.closeAllConnections(); });
  assert.equal((await fetch(new URL('/', url), { headers: { Cookie: cookie } })).status, 200);
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
