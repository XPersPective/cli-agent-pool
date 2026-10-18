import { rm } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { configSchema, configView } from '../src/config.js';
import { Pool, suggestGroup } from '../src/pool.js';
import { Store } from '../src/store.js';
import { browserUI, pickWindowsFolder } from '../src/web.js';

test('agent grouping is owner-enabled, revision-bound, atomic and limited to model groups', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'pool-groups-'));
  const config = configSchema.parse({ workspaceRoots: [directory], routes: [{ id: 'codex', adapter: 'codex', executable: process.execPath, billing: 'subscription', models: [{ id: 'astra', alias: 'Astra', group: 'manual', kinds: ['text'] }] }] });
  writeFileSync(path.join(directory, 'config.json'), JSON.stringify(config));
  const store = new Store(':memory:'); const pool = new Pool(config, store, { directory });
  t.after(async () => { await pool.close(); store.close(); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const assignment = { routeId: 'codex', modelId: 'astra', group: 'high' };
  assert.throws(() => pool.assignGroups({ revision: configView(directory).revision, assignments: [assignment] }), { code: 'GROUPING_DENIED' });
  config.groupingMode = 'agent'; writeFileSync(path.join(directory, 'config.json'), JSON.stringify(config));
  const revision = configView(directory).revision;
  assert.throws(() => pool.assignGroups({ revision, assignments: [assignment, { ...assignment, modelId: 'missing' }] }), { code: 'NOT_FOUND' });
  assert.equal(configView(directory).config.routes[0].models[0].group, 'manual');
  assert.throws(() => pool.assignGroups({ revision, assignments: [{ ...assignment, billing: 'paid_api' }] }));
  const saved = pool.assignGroups({ revision, assignments: [assignment] });
  assert.equal(saved.updated, 1); assert.equal(pool.models()[0].group, 'high');
  assert.equal(pool.config.routes[0].billing, 'subscription');
  assert.throws(() => pool.assignGroups({ revision, assignments: [{ ...assignment, group: 'low' }] }), { code: 'CONFIG_CONFLICT' });
  assert.equal(configView(directory).config.routes[0].models[0].group, 'high');
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
  for (let i = 0; i < 20 && pool.get(task.id).state !== 'needs_review'; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(pool.get(task.id).state, 'needs_review'); assert.equal(executions, 1);
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
