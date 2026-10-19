import { rm } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { configSchema } from '../src/config.js';
import { Pool } from '../src/pool.js';
import { Store } from '../src/store.js';
import { claudeCatalog, routeCatalog, claudeQuotaWindows, mergeCatalogModels, execute } from '../src/adapters.js';
import { browserUI } from '../src/web.js';
import { ensureInitialized } from '../src/daemon.js';
import { memberships, mergeScanDraft, addMembership, quotaWindows, effortLabel } from '../web/pool-state.js';

test('adding to an explicit target pool preserves other memberships and validates effort before mutation', () => {
  const model = { group: 'high', defaultEffort: 'high', efforts: ['low', 'medium', 'high'] };
  addMembership(model, 'medium', 'medium');
  assert.deepEqual(model.memberships, [{ group: 'high', effort: 'high' }, { group: 'medium', effort: 'medium' }]);
  assert.equal(model.group, 'high');
  const before = structuredClone(model);
  assert.throws(() => addMembership(model, 'other', 'high'));
  assert.throws(() => addMembership(model, 'low', 'unsupported'));
  assert.deepEqual(model, before);
  addMembership(model, 'medium', '');
  assert.deepEqual(model.memberships, [{ group: 'high', effort: 'high' }, { group: 'medium' }]);
  addMembership(model, 'low', 'low');
  assert.equal(model.memberships.length, 3);
  assert.equal(addMembership(model, 'low', 'low'), false);
  assert.equal(addMembership(model, 'low', 'high'), true);
  assert.equal(model.memberships.length, 3);
});

test('readable quota values preserve model scope and Turkish effort labels preserve protocol values', () => {
  const snapshot = { windows: [{ name: 'shared', remainingPercent: 72 }, { name: 'opus', remainingPercent: 0, models: ['opus'] }, { name: 'unknown', remainingPercent: null }, { name: 'bad', remainingPercent: NaN }, { name: 'bounds', remainingPercent: 120 }] };
  const before = structuredClone(snapshot);
  const sonnet = quotaWindows(snapshot, 'claude-sonnet-5-5');
  assert.deepEqual(sonnet.map(window => [window.name, window.remaining, window.used]), [['shared', 72, 28], ['bounds', 100, 0]]);
  assert.equal(quotaWindows(snapshot, 'claude-opus-5-5')[1].remaining, 0);
  assert.equal(quotaWindows(null).length, 0);
  assert.deepEqual(snapshot, before);
  assert.equal(effortLabel('low'), 'Düşük'); assert.equal(effortLabel('high'), 'Yüksek');
  assert.equal(effortLabel(''), 'CLI varsayılanı'); assert.equal(effortLabel('provider-specific'), 'provider-specific');
});

test('manual pools enforce membership and per-pool effort at selection and execution', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'pool-members-'));
  const config = configSchema.parse({ selectionMode: 'manual', workspaceRoots: [root], routes: [{ id: 'codex', adapter: 'codex', executable: process.execPath, billing: 'subscription', enabled: true, models: [{ id: 'gpt-version', alias: 'GPT', group: 'unassigned', efforts: ['low', 'medium', 'high'], defaultEffort: 'high', kinds: ['text'], memberships: [{ group: 'high', effort: 'high' }, { group: 'medium', effort: 'medium' }, { group: 'low' }] }, { id: 'outside', alias: 'Outside', group: 'unassigned', efforts: [], kinds: ['text'], memberships: [] }] }] });
  const store = new Store(':memory:'); let used;
  const pool = new Pool(config, store, { directory: root, checkAuth: async () => {}, execute: (route, model, request, python, progress) => { used = request; progress('model:resolved-gpt-version'); return { cancel() {}, done: Promise.resolve({ result: 'ok' }) }; } });
  t.after(async () => { await pool.close(); store.close(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  assert.throws(() => pool.select({ kind: 'text', routeId: 'codex', modelId: 'outside' }), { code: 'POOL_REQUIRED' });
  assert.throws(() => pool.select({ kind: 'text', group: 'high', modelId: 'outside' }), { code: 'NO_ROUTE' });
  assert.throws(() => pool.select({ kind: 'text', group: 'high', effort: 'low' }), { code: 'NO_ROUTE' });
  assert.equal(pool.select({ kind: 'text', group: 'medium' }).selected.fixedEffort, 'medium');
  store.saveQuota('codex', { status: 'available', observedAt: new Date().toISOString(), windows: [{ remainingPercent: 15 }] });
  assert.throws(() => pool.select({ kind: 'text', group: 'medium', minRemainingPercent: 25 }), { code: 'NO_ROUTE' });
  assert.equal(pool.select({ kind: 'text', group: 'medium', minRemainingPercent: 10 }).selected.id, 'gpt-version');
  config.routes[0].minRemainingPercent = 20;
  assert.throws(() => pool.select({ kind: 'text', group: 'medium', minRemainingPercent: 0 }), { code: 'NO_ROUTE' });
  config.routes[0].minRemainingPercent = 0;
  assert.equal(pool.select({ kind: 'text', group: 'low' }).selected.defaultEffort, undefined);
  const task = pool.submit({ kind: 'text', group: 'medium', prompt: 'test', workspace: root, idempotencyKey: 'member-task-123' });
  for (let i = 0; i < 40 && pool.get(task.id).state !== 'succeeded'; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(used.effort, 'medium'); assert.equal(used.group, 'medium');
  assert.equal(pool.get(task.id).reportedModel, 'resolved-gpt-version');
  assert.equal(pool.get(task.id).effort, 'medium');
  assert.equal(pool.pools().pools[1].members[0].fixedEffort, 'medium');
  pool.config.selectionMode = 'auto';
  assert.equal(pool.select({ kind: 'text', modelId: 'outside' }).selected.id, 'outside');
  const invalid = structuredClone(config); invalid.routes[0].models[0].memberships.push({ group: 'high' });
  assert.throws(() => configSchema.parse(invalid));
  invalid.routes[0].models[0].memberships = [{ group: 'high', effort: 'unsupported' }];
  assert.throws(() => configSchema.parse(invalid));
});

test('Claude control catalog imports resolved versions without a user prompt and preserves pool rules', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'claude-catalog-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const executable = path.join(root, 'claude.mjs');
  writeFileSync(executable, `import{createInterface}from'node:readline';if(process.argv.includes('--input-format')){createInterface({input:process.stdin}).on('line',line=>{const message=JSON.parse(line);if(message.type!=='control_request')process.exit(9);console.log(JSON.stringify({type:'control_response',response:{request_id:message.request_id,response:{models:[{value:'default',resolvedModel:'claude-opus-9-1',supportedEffortLevels:['low','high']},{value:'opus',resolvedModel:'claude-opus-9-1',supportedEffortLevels:['low','high']}]}}}));});}else{process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'system',model:'claude-opus-9-1'}));console.log(JSON.stringify({type:'result',result:'done'}));});}`);
  const route = { id: 'claude', adapter: 'claude', executable, billing: 'subscription', models: [{ id: 'opus', alias: 'Opus', group: 'high', efforts: ['low', 'high'], enabled: false, kinds: ['text'], memberships: [{ group: 'high', effort: 'high' }] }] };
  const catalog = await claudeCatalog(route, root, process.platform === 'win32' ? 'python' : 'python3');
  assert.equal(catalog.models.length, 1); assert.equal(catalog.models[0].id, 'claude-opus-9-1');
  assert.deepEqual(catalog.models[0].aliases, ['default', 'opus']);
  mergeCatalogModels(route, catalog);
  assert.equal(route.models.length, 1); assert.equal(route.models[0].id, 'claude-opus-9-1');
  assert.deepEqual(route.models[0].memberships, [{ group: 'high', effort: 'high' }]);
  assert.equal(route.models[0].enabled, false);
  const events = [];
  assert.deepEqual(await execute(route, route.models[0], { kind: 'text', prompt: 'test', workspace: root, timeoutSeconds: 5 }, process.platform === 'win32' ? 'python' : 'python3', event => events.push(event), root).done, { result: 'done' });
  assert.ok(events.includes('model:claude-opus-9-1'));
});

test('scan merges new versioned models without saving or discarding unrelated draft edits', () => {
  const before = { selectionMode: 'auto', groupingMode: 'manual', workspaceRoots: ['original'], routes: [{ id: 'claude', enabled: false, models: [{ id: 'opus', alias: 'Opus', group: 'claude', efforts: ['high'], memberships: [] }] }] };
  const draft = structuredClone(before); draft.selectionMode = 'manual'; draft.routes[0].enabled = true;
  draft.routes[0].models[0].memberships = [{ group: 'high', effort: 'high' }];
  draft.routes[0].models.push({ id: 'custom-v2', alias: 'Custom', group: 'low' });
  const scanned = structuredClone(before); scanned.routes[0].models[0].id = 'claude-opus-9-1'; scanned.routes[0].models[0].alias = 'claude-opus-9-1';
  scanned.routes[0].models.push({ id: 'claude-sonnet-9-1', group: 'unassigned', memberships: [] });
  scanned.routes.push({ id: 'qwen', models: [] });
  const result = mergeScanDraft(scanned, before, draft);
  assert.equal(result.selectionMode, 'manual'); assert.equal(result.routes[0].enabled, true);
  assert.deepEqual(result.routes[0].models[0].memberships, [{ group: 'high', effort: 'high' }]);
  assert.equal(result.routes[0].models[0].id, 'claude-opus-9-1');
  assert.equal(result.routes[0].models[0].alias, 'claude-opus-9-1');
  assert.equal(result.routes[0].models.length, 3); assert.equal(result.routes.length, 2);
  assert.equal(scanned.routes[0].enabled, false);
  assert.deepEqual(memberships({ group: 'medium', defaultEffort: 'high' }), [{ group: 'medium', effort: 'high' }]);
  assert.deepEqual(memberships({ group: 'medium', memberships: [] }), []);
});

test('quota percentages are validated and model-specific limits do not block sibling models', async t => {
  const windows = claudeQuotaWindows({ five_hour: { used: '20.0%', remaining: '80%' }, seven_day: { used: '10%' }, opus: { used: '100%' }, invalid: {} });
  assert.equal(windows[0].remainingPercent, 80); assert.equal(windows[1].remainingPercent, 90);
  assert.deepEqual(windows[2].models, ['opus']);
  assert.deepEqual(claudeQuotaWindows({ five_hour: { used: 'not numeric' } }), []);
  const root = mkdtempSync(path.join(tmpdir(), 'pool-quota-ui-'));
  const config = configSchema.parse({ routes: [{ id: 'claude', adapter: 'claude', executable: process.execPath, billing: 'subscription', enabled: true, models: ['opus', 'sonnet'].map(family => ({ id: `claude-${family}-9-1`, alias: family, group: 'high', kinds: ['text'], efforts: [] })) }], workspaceRoots: [root] });
  writeFileSync(path.join(root, 'config.json'), JSON.stringify(config));
  const store = new Store(':memory:'); const pool = new Pool(config, store, { directory: root });
  t.after(async () => { await pool.close(); store.close(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  store.saveQuota('claude', { status: 'available', windows, observedAt: new Date().toISOString() });
  assert.equal(pool.select({ kind: 'text', group: 'high' }).selected.id, 'claude-sonnet-9-1');
  config.routes[0].enabled = false;
  pool.getQuota = async () => store.quota('claude');
  const result = await browserUI(pool, { directory: root, token: 'a'.repeat(64) }).operation({ operation: 'quotas' });
  assert.equal(result.quotas.claude.windows[0].remainingPercent, 80);
});


test('local model catalogs preserve actual model keys and tags instead of a fabricated default', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'local-catalog-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const executable = path.join(root, 'models.mjs');
  writeFileSync(executable, `if(process.argv.includes('--json'))console.log(JSON.stringify([{modelKey:'qwen3-8b-v2'}]));else console.log('NAME ID SIZE MODIFIED\\nqwen3:8b abc123 5GB today');`);
  const python = process.platform === 'win32' ? 'python' : 'python3';
  assert.equal((await routeCatalog({ id: 'local', adapter: 'lmstudio', executable }, root, python)).models[0].id, 'qwen3-8b-v2');
  const ollama = await routeCatalog({ id: 'local', adapter: 'ollama', executable }, root, python);
  assert.equal(ollama.models[0].id, 'qwen3:8b'); assert.equal(ollama.models[0].name, 'qwen3:8b · abc123');
});


test('agent auto-start preserves owner-disabled routes and never grants trust implicitly', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'pool-owner-policy-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const config = configSchema.parse({ workspaceRoots: [root], selectionMode: 'manual', routes: [{ id: 'owner-disabled', adapter: 'custom', executable: process.execPath, argsTemplate: ['--version'], billing: 'free', enabled: false, trustedSettings: false, models: [] }] });
  writeFileSync(path.join(root, 'config.json'), JSON.stringify(config));
  const loaded = ensureInitialized(root);
  assert.equal(loaded.selectionMode, 'manual');
  assert.equal(loaded.routes.find(route => route.id === 'owner-disabled').enabled, false);
  assert.equal(loaded.routes.find(route => route.id === 'owner-disabled').trustedSettings, false);
});
