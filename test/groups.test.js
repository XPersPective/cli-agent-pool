import { rm } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { configSchema, configView, saveConfig } from '../src/config.js';
import { Pool, suggestGroup } from '../src/pool.js';
import { Store } from '../src/store.js';
import { browserUI, pickWindowsFolder } from '../src/web.js';

test('owner categories are revision-bound and removing membership blocks agent selection while retaining owner catalog', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'pool-categories-'));
  const config = configSchema.parse({ selectionMode:'manual', groupingMode:'agent', routes: [{id:'codex',adapter:'codex',executable:process.execPath,billing:'subscription',enabled:true,models:[{id:'astra',alias:'Astra',group:'high',kinds:['text']}]}] });
  writeFileSync(path.join(directory,'config.json'),JSON.stringify(config));
  const store=new Store(':memory:'),pool=new Pool(config,store,{directory});
  t.after(async()=>{await pool.close();store.close();await rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  assert(!('selectionMode' in config));assert(!('groupingMode' in config));
  const view=configView(directory);view.config.categories.push({id:'research',name:'Araştırma'});
  view.config.routes[0].models[0].memberships.push({group:'research'});
  pool.config=saveConfig(directory,view.config,view.revision);
  assert.equal(pool.pools({group:'research'}).models[0].modelId,'astra');
  assert.throws(()=>saveConfig(directory,view.config,view.revision),{code:'CONFIG_CONFLICT'});
  pool.config.routes[0].models[0].memberships=[];
  assert.equal(pool.pools({group:'research'}).total,0);
  assert.equal(pool.catalogModels().some(m => m.id === 'astra'), true);
  assert.throws(()=>pool.select({kind:'text',modelId:'astra'}),{code:'MODEL_NOT_IN_POOL'});
});

test('live group selection skips exhausted routes, respects pins and never retries execution', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'pool-live-'));
  const config = configSchema.parse({ workspaceRoots: [directory], routes: ['first', 'second', 'paid', 'other'].map((id, index) => ({ id, adapter: 'codex', executable: process.execPath, enabled: true, billing: id === 'paid' ? 'paid_api' : 'subscription', priority: index, models: [{ id: 'model', alias: id, group: id === 'other' ? 'high' : 'medium', kinds: ['write', 'text'] }] })) });
  const store = new Store(':memory:'); let executions = 0; const probes = [];
  const pool = new Pool(config, store, { directory, checkAuth: async () => {}, execute: () => { executions++; return { cancel() {}, done: Promise.resolve({ error: 'RATE_LIMIT' }) }; } });
  t.after(async () => { await pool.close(); store.close(); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  pool.getQuota = async id => { probes.push(id); const quota = { status: 'available', windows: [{ remainingPercent: id === 'first' ? 0 : 50 }], observedAt: new Date().toISOString() }; store.saveQuota(id, quota); return quota; };
  const selected = await pool.selectLive({ kind: 'text', group: 'medium' });
  assert.equal(selected.selected.routeId, 'second'); assert.deepEqual(probes, ['first', 'second']);
  await assert.rejects(pool.selectLive({ kind: 'text', group: 'medium', routeId: 'first' }), { code: 'NO_ROUTE' });
  const request = { prompt: 'change', kind: 'write', group: 'medium', workspace: directory, idempotencyKey: 'group-request-123' };
  const task = await pool.submitLive(request);
  for (let i = 0; i < 400 && !['needs_review', 'failed'].includes(pool.get(task.id).state); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(pool.get(task.id).state, 'failed'); assert.equal(executions, 1);
  assert.equal((await pool.submitLive(request)).id, task.id); assert.equal(executions, 1);
});

test('Windows picker uses a shell-free fixed command, validates selected directory and handles cancellation', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'pool-picker-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  let invocation;
  const run = async (file, args, options) => { invocation = { file, args, ...options }; return { stdout: JSON.stringify({ path: directory }) }; };
  const initial = `${directory}'; Write-Output injected`;
  assert.deepEqual(await pickWindowsFolder(initial, { run, platform: 'win32', directory }), { path: directory });
  assert.ok(invocation.file.endsWith('.exe'));
  assert.equal(invocation.windowsHide, false);
  assert.ok(!invocation.args.join(' ').includes(initial));
  assert.equal(invocation.env.CLI_AGENT_POOL_PICKER_START, initial);
  assert.deepEqual(await pickWindowsFolder('', { run: async () => ({ stdout: '{"path":null}' }), platform: 'win32', directory }), { path: null });
  await assert.rejects(pickWindowsFolder('', { run: async () => { throw new Error('failed'); }, platform: 'win32', directory }), { code: 'PICKER_FAILED' });
  await assert.rejects(pickWindowsFolder('', { run, platform: 'linux' }), { code: 'PICKER_UNAVAILABLE' });
});

test('strength suggestions distinguish named families and leave unknown models unclassified', () => {
  assert.equal(suggestGroup('gpt-6-astra'), 'high');
  assert.equal(suggestGroup('gpt-6.1-sol'), 'medium');
  assert.equal(suggestGroup('gpt-6-luna'), 'low');
  assert.equal(suggestGroup('Claude Opus'), 'high');
  assert.equal(suggestGroup('GLM-5.3-Flash'), 'low');
  assert.equal(suggestGroup('qwen3.8-max'), null);
  assert.equal(suggestGroup('vendor/solar-model'), null);
  assert.equal(suggestGroup('MiniMax-M3'), null);
});

test('submitLive uses valid cached quota immediately without blocking on slow live quota probes', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'pool-fast-submit-'));
  const config = configSchema.parse({ workspaceRoots: [directory], routes: [{ id: 'fast', adapter: 'codex', executable: process.execPath, enabled: true, billing: 'subscription', models: [{ id: 'm1', alias: 'M1', group: 'low', kinds: ['text'] }] }] });
  const store = new Store(':memory:');
  store.saveQuota('fast', { status: 'available', windows: [{ remainingPercent: 80 }], observedAt: new Date(Date.now() - 25_000).toISOString() });
  let slowProbeStarted = 0;
  const pool = new Pool(config, store, { directory, checkAuth: async () => {}, execute: () => ({ cancel() {}, done: Promise.resolve({ result: 'hi' }) }) });
  t.after(async () => { await pool.close(); store.close(); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  pool.getQuota = async () => {
    slowProbeStarted++;
    await new Promise(resolve => { const timer = setTimeout(resolve, 4000); timer.unref?.(); });
    return { status: 'available', windows: [{ remainingPercent: 80 }], observedAt: new Date().toISOString() };
  };
  const startedAt = Date.now();
  const task = await pool.submitLive({ prompt: 'slm', kind: 'text', routeId: 'fast', modelId: 'm1', workspace: directory, idempotencyKey: 'fast-submit-cached-1' });
  assert.ok(Date.now() - startedAt < 500, 'submitLive must not block 4s when cached quota exists');
  assert.equal(slowProbeStarted, 1, 'stale >15s quota still refreshes in background');
  assert.ok(task.id);
});

test('submitLive re-probes stale auth_required immediately and Pool caches verified checkAuth safely', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'pool-auth-refresh-'));
  const config = configSchema.parse({ workspaceRoots: [directory], routes: [{ id: 'claude-test', adapter: 'claude', executable: process.execPath, enabled: true, trustedSettings: true, billing: 'subscription', models: [{ id: 'haiku', alias: 'Haiku', group: 'low', kinds: ['text'] }] }] });
  const store = new Store(':memory:');
  store.saveQuota('claude-test', { status: 'auth_required', windows: [], observedAt: new Date().toISOString() });
  let authCalls = 0;
  let forceProbes = 0;
  const pool = new Pool(config, store, {
    directory,
    authCacheTtlMs: 60_000,
    checkAuth: async () => { authCalls++; },
    execute: () => ({ cancel() {}, done: Promise.resolve({ result: 'selam' }) }),
  });
  t.after(async () => { await pool.close(); store.close(); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  pool.getQuota = async (id, force) => {
    if (force) forceProbes++;
    const fresh = { status: 'available', windows: [{ remainingPercent: 95 }], observedAt: new Date().toISOString() };
    store.saveQuota(id, fresh);
    return fresh;
  };
  const first = await pool.submitLive({ prompt: 'slm', kind: 'text', routeId: 'claude-test', modelId: 'haiku', workspace: directory, idempotencyKey: 'auth-recovered-1' });
  for (let i = 0; i < 100 && pool.get(first.id).state !== 'succeeded'; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(forceProbes, 1, 'auth_required cache must be force re-probed immediately');
  assert.equal(pool.get(first.id).state, 'succeeded');
  assert.equal(authCalls, 1);

  const second = await pool.submitLive({ prompt: 'slm 2', kind: 'text', routeId: 'claude-test', modelId: 'haiku', workspace: directory, idempotencyKey: 'auth-recovered-2' });
  for (let i = 0; i < 100 && pool.get(second.id).state !== 'succeeded'; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(pool.get(second.id).state, 'succeeded');
  assert.equal(authCalls, 1, 'verified checkAuth is cached within TTL to avoid repeated CLI spawns');
});
