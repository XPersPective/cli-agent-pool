import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { configSchema, allowedWorkspace, overlaps, redact, configView, saveConfig } from '../src/config.js';
import { writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { Store } from '../src/store.js';
import { Pool } from '../src/pool.js';
import { runProcess, childEnvironment } from '../src/process.js';
import { buildArguments, checkAuth, execute, quota } from '../src/adapters.js';

function fixture(t, dependencies = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'pool-test-'));
  const config = configSchema.parse({ workspaceRoots: [root], routes: [{ id: 'test', adapter: 'codex', executable: process.execPath, enabled: true, billing: 'subscription', models: [{ id: 'test-model', alias: 'Test', group: 'manual', efforts: ['low'], kinds: ['read', 'write', 'text'] }] }] });
  const store = new Store(path.join(root, 'pool.sqlite'));
  const pool = new Pool(config, store, { checkAuth: async () => {}, execute: () => ({ cancel() {}, done: Promise.resolve({ result: 'ok' }) }), ...dependencies });
  t.after(async () => { await pool.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const request = { prompt: 'test', workspace: root, kind: 'read', idempotencyKey: 'test-key-123' };
  return { root, config, store, pool, request };
}

async function terminal(pool, id) {
  for (let i = 0; i < 200; i++) { const task = pool.get(id); if (!['queued', 'starting', 'running', 'cancelling'].includes(task.state)) return task; await delay(10); }
  throw new Error('Task did not settle');
}

test('canonical workspace containment rejects siblings, traversal and symlink escape', t => {
  const { root } = fixture(t);
  const outside = mkdtempSync(path.join(tmpdir(), 'pool-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const child = path.join(root, 'child'); mkdirSync(child);
  assert.equal(allowedWorkspace(child, [root]), child);
  assert.throws(() => allowedWorkspace(outside, [root]), { code: 'WORKSPACE_DENIED' });
  assert.throws(() => allowedWorkspace(path.dirname(root), [root]), { code: 'WORKSPACE_DENIED' });
  symlinkSync(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => allowedWorkspace(path.join(root, 'escape'), [root]), { code: 'WORKSPACE_DENIED' });
  assert.ok(overlaps(root, child)); assert.ok(!overlaps(root, outside));
});

test('lost response and concurrent same-key submissions create one durable task', async t => {
  const { pool, request, root, store } = fixture(t);
  const submissions = await Promise.all(Array.from({ length: 20 }, () => Promise.resolve().then(() => pool.submit(request))));
  assert.equal(new Set(submissions.map(task => task.id)).size, 1);
  const id = submissions[0].id;
  assert.equal((await terminal(pool, id)).result, 'ok');
  assert.equal(pool.submit(request).id, id);
  assert.throws(() => pool.submit({ ...request, prompt: 'different' }), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.equal(store.list().length, 1);
  assert.throws(() => new Store(path.join(root, 'pool.sqlite')), /POOL_ALREADY_RUNNING/);
});

test('manual group, explicit route and effort are hard filters', t => {
  const { pool, request } = fixture(t);
  assert.equal(pool.select({ kind: 'read', group: 'manual', effort: 'low' }).selected.id, 'test-model');
  assert.throws(() => pool.submit({ ...request, effort: 'invented' }), { code: 'NO_ROUTE' });
  assert.throws(() => pool.select({ kind: 'read', routeId: 'unknown' }), { code: 'NO_ROUTE' });
  pool.config.routes[0].enabled = false;
  assert.throws(() => pool.submit(request), { code: 'NO_ROUTE' });
});

test('overlapping workspace stays reserved until cancellation cleanup finishes', async t => {
  let release;
  let cancelled = false;
  let starts = 0;
  const { pool, request } = fixture(t, { execute: () => { starts++; return { cancel: () => { cancelled = true; }, done: new Promise(resolve => { const timer = setTimeout(() => resolve({ error: 'TEST_TIMEOUT' }), 5000); release = value => { clearTimeout(timer); resolve(value); }; }) }; } });
  pool.config.concurrency = 2; pool.config.routes[0].maxConcurrent = 2;
  const first = pool.submit(request);
  const second = pool.submit({ ...request, idempotencyKey: 'second-key-123' });
  await delay(30);
  assert.equal(starts, 1);
  pool.cancel(first.id);
  assert.ok(cancelled); assert.equal(pool.get(second.id).state, 'queued');
  release({ error: 'CANCELLED' });
  assert.equal((await terminal(pool, first.id)).state, 'cancelled');
  await delay(30); assert.equal(starts, 2);
  pool.cancel(second.id); release({ error: 'CANCELLED' });
});

test('write failure quarantines the workspace and never retries', async t => {
  let starts = 0;
  const { pool, request } = fixture(t, { execute: () => { starts++; return { cancel() {}, done: Promise.resolve({ error: 'CLI_FAILED' }) }; } });
  const first = pool.submit({ ...request, kind: 'write' });
  assert.equal((await terminal(pool, first.id)).state, 'needs_review');
  const second = pool.submit({ ...request, idempotencyKey: 'second-key-123' });
  await delay(30);
  assert.equal(pool.get(second.id).state, 'queued'); assert.equal(starts, 1);
});

test('restart preserves completed results and quarantines interrupted tasks', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'pool-restart-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const filename = path.join(root, 'pool.sqlite');
  let store = new Store(filename);
  store.insert({ id: '1', key: 'key1', fingerprint: 'fp', workspace: root, request: {} });
  store.insert({ id: '2', key: 'key2', fingerprint: 'fp', workspace: root, request: {} });
  store.update('1', 'succeeded', 'saved'); store.update('2', 'running'); store.close();
  store = new Store(filename);
  try { assert.equal(store.get('1').result, 'saved'); assert.equal(store.get('2').state, 'needs_review'); }
  finally { store.close(); }
});

test('storage failure prevents a successful admission', t => {
  const { pool, request, store } = fixture(t);
  store.insert = () => { throw new Error('disk full'); };
  assert.throws(() => pool.submit(request), /disk full/);
  assert.equal(pool.list().length, 0);
});

test('known account quota gates model selection and expires without fabricated percentages', t => {
  const { pool, store } = fixture(t);
  store.saveQuota('test', { status: 'rate_limited', windows: [{ remainingPercent: 0 }], observedAt: new Date().toISOString() });
  assert.throws(() => pool.select({ kind: 'read' }), { code: 'NO_ROUTE' });
  store.saveQuota('test', { status: 'rate_limited', windows: [], observedAt: new Date(Date.now() - 61_000).toISOString() });
  assert.equal(pool.select({ kind: 'read' }).selected.routeId, 'test');
  pool.config.routes[0].minRemainingPercent = 20;
  store.saveQuota('test', { status: 'available', windows: [{ remainingPercent: 15 }], observedAt: new Date().toISOString() });
  assert.throws(() => pool.select({ kind: 'read' }), { code: 'NO_ROUTE' });
});

test('atomic configuration updates preserve manual groups and reject stale or invalid saves', t => {
  const { root, config } = fixture(t);
  const filename = path.join(root, 'config.json');
  writeFileSync(filename, JSON.stringify(config));
  const first = configView(root);
  const edited = structuredClone(first.config); edited.routes[0].models[0].group = 'my-group';
  saveConfig(root, edited, first.revision);
  assert.equal(configView(root).config.routes[0].models[0].group, 'my-group');
  assert.throws(() => saveConfig(root, first.config, first.revision), { code: 'CONFIG_CONFLICT' });
  const before = readFileSync(filename, 'utf8');
  assert.throws(() => saveConfig(root, { ...edited, apiKey: 'not-allowed' }, configView(root).revision));
  assert.equal(readFileSync(filename, 'utf8'), before);
});

test('no inherited API secrets and shell-free Codex/Claude arguments', t => {
  const previous = process.env.POOL_TEST_API_KEY; process.env.POOL_TEST_API_KEY = 'hidden';
  try { assert.equal(childEnvironment().POOL_TEST_API_KEY, undefined); }
  finally { if (previous === undefined) delete process.env.POOL_TEST_API_KEY; else process.env.POOL_TEST_API_KEY = previous; }
  const { config, request } = fixture(t);
  const argv = buildArguments(config.routes[0], config.routes[0].models[0], { ...request, effort: 'low' });
  assert.ok(argv.includes('--ignore-user-config')); assert.ok(argv.includes('read-only'));
  assert.ok(!argv.includes(request.prompt));
  assert.ok(!argv.some(a => a.includes('dangerously')));
  assert.equal(redact('Bearer ' + 'a'.repeat(30)), 'Bearer [REDACTED]');
});

const py = process.platform === 'win32' ? 'python' : 'python3';
test('auth checks fail closed on third-party Claude endpoints, missing mmx plans and removed Gemini routes', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'pool-auth-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fake = (name, body) => { const file = path.join(root, `${name}.js`); writeFileSync(file, `const a=process.argv.slice(2).join(' ');${body}`); return file; };
  const claude = (authMethod, baseURL) => ({ id: 'c', adapter: 'claude', billing: 'subscription', trustedSettings: true, executable: fake(`claude-${authMethod}-${Boolean(baseURL)}`,
    `if(a==='auth status --json')console.log(JSON.stringify({loggedIn:true,authMethod:${JSON.stringify(authMethod)},apiProvider:'firstParty'}));else if(a==='auth status --text')console.log(${JSON.stringify(baseURL ? `Auth token: ANTHROPIC_AUTH_TOKEN\nAnthropic base URL: ${baseURL}` : 'Login method: Claude Max account')});else process.exit(2)`) });
  // Installed Claude 2.1 reports oauth_token + firstParty even when settings.json redirects to another vendor.
  await assert.rejects(checkAuth(claude('oauth_token', 'https://example.invalid/anthropic'), root, py), { code: 'AUTH_REQUIRED' });
  await assert.rejects(checkAuth(claude('claude.ai', 'https://example.invalid/anthropic'), root, py), { code: 'THIRD_PARTY_ENDPOINT' });
  await checkAuth(claude('claude.ai'), root, py);
  const mmx = (name, body) => ({ id: 'm', adapter: 'mmx', billing: 'subscription', trustedSettings: true, executable: fake(name, body) });
  const missing = mmx('mmx-none', `process.stderr.write(JSON.stringify({error:{code:1,message:'API error: no active token plan subscription (HTTP 200)'}}));process.exit(1)`);
  await assert.rejects(checkAuth(missing, root, py), { code: 'SUBSCRIPTION_REQUIRED' });
  assert.equal((await quota(missing, root, py)).subscription, 'none');
  const drift = mmx('mmx-drift', `console.log('not json')`);
  assert.equal((await quota(drift, root, py)).subscription, 'unknown');
  await assert.rejects(checkAuth(drift, root, py), { code: 'SUBSCRIPTION_REQUIRED' });
  const active = mmx('mmx-active', `console.log(JSON.stringify({data:{plan:'active'}}))`);
  await checkAuth(active, root, py);
  assert.equal((await quota(active, root, py)).subscription, 'active');
  assert.throws(() => configSchema.parse({ workspaceRoots: [], routes: [{ id: 'g', adapter: 'gemini', executable: process.execPath, models: [] }] }));
});

test('Qwen stream-json result envelope is parsed, errors fail and writes stay disabled', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'pool-qwen-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const script = (name, events) => { const file = path.join(root, `${name}.js`); writeFileSync(file, `let p='';process.stdin.on('data',c=>p+=c).on('end',()=>{for(const e of ${events})console.log(JSON.stringify(e))})`); return file; };
  const run = executable => execute({ id: 'q', adapter: 'qwen', executable }, { id: 'qwen-model' }, { prompt: 'say ok', workspace: root, kind: 'read', timeoutSeconds: 10 }, py, () => {}).done;
  const ok = script('ok', `[{type:'system',subtype:'init'},{type:'assistant',message:{role:'assistant',content:[{type:'text',text:p}]}},{type:'result',subtype:'success',is_error:false,result:'echo:'+p}]`);
  assert.deepEqual(await run(ok), { result: 'echo:say ok' });
  const failed = script('failed', `[{type:'result',subtype:'error_during_execution',is_error:true,error:{message:'x'}}]`);
  assert.deepEqual(await run(failed), { error: 'CLI_FAILED' });
  assert.throws(() => buildArguments({ adapter: 'qwen', executable: ok }, { id: 'm' }, { kind: 'write' }), { code: 'WRITE_NOT_SUPPORTED' });
});

test('a fresh snapshot stating no active plan removes the route from selection', t => {
  const { pool, store } = fixture(t);
  store.saveQuota('test', { connection: 'test', status: 'unknown', subscription: 'none', windows: [], observedAt: new Date().toISOString() });
  assert.throws(() => pool.select({ kind: 'read' }), { code: 'NO_ROUTE' });
  store.saveQuota('test', { connection: 'test', status: 'unknown', subscription: 'none', windows: [], observedAt: new Date(Date.now() - 61_000).toISOString() });
  assert.equal(pool.select({ kind: 'read' }).selected.id, 'test-model');
});

test('supervisor preserves Unicode and literal prompt data', async () => {
  const result = await runProcess({ argv: [process.execPath, '-e', 'process.stdin.pipe(process.stdout)'], cwd: process.cwd(), input: 'İstanbul $() & | " ` test', timeoutMs: 5000 }).done;
  assert.equal(result.code, 0); assert.equal(result.output, 'İstanbul $() & | " ` test');
});

test('timeout kills a grandchild process tree before reporting completion', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'pool-process-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pidFile = path.join(root, 'pid');
  const code = `const {spawn}=require('node:child_process'); const fs=require('node:fs'); const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); fs.writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setInterval(()=>{},1000)`;
  const result = await runProcess({ argv: [process.execPath, '-e', code], cwd: root, timeoutMs: 1500 }).done;
  assert.equal(result.stopReason, 'TIMEOUT');
  const pid = Number(readFileSync(pidFile, 'utf8'));
  for (let i = 0; i < 100; i++) { try { process.kill(pid, 0); } catch { return; } await delay(20); }
  assert.fail('Grandchild survived cancellation');
});

test('a hard parent exit closes the supervisor control pipe and kills the owned CLI', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'pool-parent-exit-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pidFile = path.join(root, 'pid');
  const moduleURL = pathToFileURL(path.resolve('src/process.js')).href;
  const childCode = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`;
  const parentCode = `import {runProcess} from ${JSON.stringify(moduleURL)};import{existsSync}from'node:fs';runProcess({argv:[process.execPath,'-e',${JSON.stringify(childCode)}],cwd:${JSON.stringify(root)},timeoutMs:10000});const timer=setInterval(()=>{if(existsSync(${JSON.stringify(pidFile)})){clearInterval(timer);process.exit(0)}},20)`;
  const parent = spawn(process.execPath, ['--input-type=module', '-e', parentCode], { stdio: 'ignore', windowsHide: true });
  t.after(() => { if (parent.exitCode === null) parent.kill(); });
  await new Promise((resolve, reject) => { parent.once('error', reject); parent.once('exit', code => code === 0 ? resolve() : reject(new Error('Parent failed'))); });
  assert.ok(existsSync(pidFile));
  const pid = Number(readFileSync(pidFile, 'utf8'));
  for (let i = 0; i < 100; i++) { try { process.kill(pid, 0); } catch { return; } await delay(20); }
  assert.fail('Owned CLI survived its parent');
});
