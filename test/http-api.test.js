import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { configSchema, initialize } from '../src/config.js';
import { Store } from '../src/store.js';
import { Pool } from '../src/pool.js';
import { createServer } from '../src/server.js';
import { quotaOverview } from '../src/catalog.js';

const runFile = promisify(execFile);
const poolBin = fileURLToPath(new URL('../bin/pool.js', import.meta.url));

async function createHttpApp(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'pool-http-api-'));
  const executable = path.join(root, 'fake-cli.js');
  writeFileSync(executable, `process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'ok'}}));console.log(JSON.stringify({type:'turn.completed'}));});`);
  const config = configSchema.parse({
    categories: [{ id: 'high', name: 'Yüksek' }, { id: 'research', name: 'Araştırma' }],
    routes: [
      {
        id: 'codex-local', adapter: 'codex', executable, enabled: true, billing: 'subscription',
        models: [
          { id: 'gpt-5-codex', alias: 'GPT-5 Codex', group: 'high', kinds: ['text', 'read', 'write'], efforts: ['medium', 'high'], memberships: [{ group: 'high', effort: 'high' }, { group: 'research', effort: 'medium' }] },
          { id: 'hidden-model', alias: 'Hidden', group: 'high', kinds: ['read'] },
        ],
      },
      {
        id: 'free-local', adapter: 'opencode', executable, enabled: true, billing: 'free',
        models: [{ id: 'openrouter/free-flash', alias: 'Free Flash', group: 'free', kinds: ['text', 'read'], memberships: [] }],
      },
      {
        id: 'disabled-route', adapter: 'qoder', executable, enabled: false, billing: 'free_credits',
        models: [{ id: 'qoder-off', alias: 'Off', group: 'high', kinds: ['read'] }],
      },
    ],
    modelFilters: [{ match: 'model', value: 'hidden-model', routeId: 'codex-local' }],
  });
  const store = new Store(path.join(root, 'pool.sqlite'));
  const pool = new Pool(config, store, { directory: root });
  pool.getQuota = async () => { throw new Error('Cached HTTP queries must not invoke live CLI'); };
  store.saveQuota('codex-local', {
    status: 'available',
    email: 'owner@example.invalid',
    observedAt: new Date().toISOString(),
    windows: [
      { name: 'five_hour', remainingPercent: 72, resetsAt: '2026-11-14T18:00:00Z' },
      { name: 'seven_day', remainingPercent: 45, resetsAt: '2026-11-20T00:00:00Z' },
    ],
  });
  const token = randomBytes(32).toString('hex');
  const managementToken = randomBytes(32).toString('hex');
  const app = createServer(pool, token, 0, { directory: root, token: managementToken });
  const address = await app.listen();
  config.port = address.port;
  writeFileSync(path.join(root, 'config.json'), JSON.stringify(config));
  writeFileSync(path.join(root, 'access-token'), token);
  writeFileSync(path.join(root, 'management-token'), managementToken);
  if (process.platform === 'win32') writeFileSync(path.join(root, '.acl-hardened'), 'test\n');
  t.after(async () => {
    app.server.close();
    app.server.closeAllConnections();
    await pool.close();
    store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return { root, pool, token, base: `http://127.0.0.1:${address.port}` };
}

test('HTTP /api serves compact cached catalog, pools, model and quotas without MCP overhead or email leaks', async t => {
  const { token, base, pool } = await createHttpApp(t);

  const indexRes = await fetch(`${base}/api`);
  assert.equal(indexRes.status, 200);
  const index = await indexRes.json();
  assert.ok(index.open['GET /api/catalog']);
  assert.ok(index.open['GET /api/quotas']);

  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(health.status, 'ok');
  assert.equal(health.connections, 2);
  assert.equal(health.models, 2);

  const catalogOverview = await (await fetch(`${base}/api/catalog`)).json();
  assert.equal(catalogOverview.total, 2);
  assert.ok(!('models' in catalogOverview));

  const freeModels = await (await fetch(`${base}/api/catalog?billing=free&q=flash`)).json();
  assert.equal(freeModels.total, 1);
  assert.equal(freeModels.models[0].modelId, 'openrouter/free-flash');

  const hiddenModels = await (await fetch(`${base}/api/catalog?q=hidden`)).json();
  assert.equal(hiddenModels.total, 0);

  const pools = await (await fetch(`${base}/api/pools`)).json();
  assert.ok(pools.categories.some(c => c.id === 'research' && c.count === 1));
  const research = await (await fetch(`${base}/api/pools/research`)).json();
  assert.equal(research.models[0].modelId, 'gpt-5-codex');
  assert.equal(research.models[0].effort, 'medium');

  const model = await (await fetch(`${base}/api/model?route=codex-local&model=gpt-5-codex`)).json();
  assert.equal(model.modelId, 'gpt-5-codex');
  assert.equal(model.quota.remainingPercent, 45);
  assert.equal('email' in model, false);

  const authModel = await (await fetch(`${base}/api/model?route=codex-local&model=gpt-5-codex`, { headers: { Authorization: `Bearer ${token}` } })).json();
  assert.equal(authModel.email, 'owner@example.invalid');

  const quotas = await (await fetch(`${base}/api/quotas`)).json();
  assert.equal(quotas.total, 2);
  const codexQuota = quotas.connections.find(c => c.routeId === 'codex-local');
  assert.equal(codexQuota.remainingPercent, 45);
  assert.equal('email' in codexQuota, false);

  const routeQuota = await (await fetch(`${base}/api/quotas/codex-local`, { headers: { Authorization: `Bearer ${token}` } })).json();
  assert.equal(routeQuota.connections[0].windows.length, 2);
  assert.equal(routeQuota.connections[0].email, 'owner@example.invalid');

  const selected = await (await fetch(`${base}/api/select?kind=write&mode=execute&group=research`)).json();
  assert.equal(selected.selected.modelId, 'gpt-5-codex');

  assert.equal(quotaOverview(pool).connections.length, 2);
});

test('HTTP /api enforces Bearer auth on tasks/tools and blocks browser origins', async t => {
  const { root, token, base } = await createHttpApp(t);

  assert.equal((await fetch(`${base}/api/tasks`)).status, 401);
  assert.equal((await fetch(`${base}/api/tasks`, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await fetch(`${base}/api/catalog`, { headers: { Origin: 'https://evil.invalid' } })).status, 403);
  assert.equal((await fetch(`${base}/api/catalog`, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await fetch(`${base}/api/tools/pool_submit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);

  const submitRes = await fetch(`${base}/api/tasks`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'Read summary', workspace: root, kind: 'read', routeId: 'codex-local', modelId: 'gpt-5-codex', idempotencyKey: 'http-api-task-001' }),
  });
  assert.equal(submitRes.status, 200);
  const submitted = await submitRes.json();
  assert.ok(submitted.id);
  assert.equal('prompt' in submitted, false);

  const taskRes = await fetch(`${base}/api/tasks/${submitted.id}`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(taskRes.status, 200);
  assert.equal((await taskRes.json()).id, submitted.id);
});

test('CLI fast commands (quotas, model, api, catalog) query HTTP /api and initialize caches ACL marker', async t => {
  const { root } = await createHttpApp(t);
  const env = { ...process.env, CLI_AGENT_POOL_HOME: root };

  const quotasOut = JSON.parse((await runFile(process.execPath, [poolBin, 'quotas'], { env, timeout: 10000 })).stdout);
  assert.equal(quotasOut.total, 2);
  assert.equal(quotasOut.connections.find(c => c.routeId === 'codex-local').email, 'owner@example.invalid');

  const modelOut = JSON.parse((await runFile(process.execPath, [poolBin, 'model', '--route', 'codex-local', '--model', 'gpt-5-codex'], { env, timeout: 10000 })).stdout);
  assert.equal(modelOut.modelId, 'gpt-5-codex');

  const apiOut = JSON.parse((await runFile(process.execPath, [poolBin, 'api'], { env, timeout: 10000 })).stdout);
  assert.ok(apiOut.open['GET /api/pools']);

  const fresh = mkdtempSync(path.join(tmpdir(), 'pool-acl-init-'));
  t.after(() => rm(fresh, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  initialize(fresh);
  if (process.platform === 'win32') {
    assert.equal(existsSync(path.join(fresh, '.acl-hardened')), true);
    assert.match(readFileSync(path.join(fresh, '.acl-hardened'), 'utf8'), /^S-1-/);
  }
  initialize(fresh);
});
