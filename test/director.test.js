// Director profile, preflight, change-aware review locks and the relay watchdog.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { configSchema } from '../src/config.js';
import { Store } from '../src/store.js';
import { Pool } from '../src/pool.js';
import { createServer, mcpServer } from '../src/server.js';
import { workspaceFingerprint, workspaceUnchanged } from '../src/workspace-state.js';
import { buildArguments } from '../src/adapters.js';
import { taskPrompt } from '../src/task-protocol.js';
import { evaluateShellEvidence, validateReadPaths } from '../src/preflight.js';
import { preflightScope, savePreflight } from '../src/director.js';

const report = JSON.stringify({ status: 'completed', summary: 'ok', files: [], checks: [], research: [], blockers: [] });
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
const poolBin = fileURLToPath(new URL('../bin/pool.js', import.meta.url));

function repository(root, name = 'repo') {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(dir, 'a.txt'), 'alpha\n');
  writeFileSync(path.join(dir, '.gitignore'), '.claude/\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

async function until(check, label, attempts = 600) {
  for (let i = 0; i < attempts; i++) { const value = await check(); if (value) return value; await delay(10); }
  assert.fail(`timed out waiting for ${label}`);
}

function setup(t, { execute, routes, readRoot } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'pool-director-'));
  const config = configSchema.parse({
    directorReadRoots: readRoot ? [readRoot(root)] : [path.join(root, 'skills')],
    routes: routes || [
      { id: 'claude-a', adapter: 'claude', executable: process.execPath, enabled: true, billing: 'subscription', trustedSettings: true, models: [{ id: 'model-a', alias: 'A', group: 'high', kinds: ['write'] }] },
      { id: 'codex-b', adapter: 'codex', executable: process.execPath, enabled: true, billing: 'subscription', models: [{ id: 'model-b', alias: 'B', group: 'high', kinds: ['write'] }] },
      { id: 'paid', adapter: 'codex', executable: process.execPath, enabled: true, billing: 'paid_api', autoSelect: true, profile: 'paidacc', models: [{ id: 'model-p', alias: 'P', group: 'high', kinds: ['write'] }] },
    ],
  });
  const store = new Store(':memory:');
  const pool = new Pool(config, store, { directory: root, checkAuth: async () => {}, execute, settleMs: 0 });
  for (const route of config.routes) store.saveQuota(route.id, { status: 'available', windows: [], observedAt: new Date().toISOString() });
  pool.getQuota = async id => store.quota(id);
  t.after(async () => { pool.relayWatchdog?.close(); await pool.close(); store.close(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  return { root, config, store, pool };
}

async function markReady(pool, routeId, modelId, workspace, extra = {}) {
  const scope = await preflightScope(pool, { routeId, modelId, workspace, ...extra });
  pool.store.savePreflight(scope.scope, { key: scope.key, status: 'ready', capabilities: {}, observedAt: new Date().toISOString() });
  return scope;
}

test('workspace fingerprint sees same-size edits, ignored settings, hidden index flags and hooks; unknown never matches', { timeout: 90000 }, async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'pool-fp-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const repo = repository(root);
  const settings = path.join(repo, '.claude', 'settings.local.json');
  const files = [settings];
  const base = await workspaceFingerprint(repo, undefined, files);
  assert.match(base, /^git:/);
  assert.equal(await workspaceFingerprint(repo, undefined, files), base, 'stable when nothing changes');
  writeFileSync(path.join(repo, 'a.txt'), 'alpha\nbeta\n');
  const dirty = await workspaceFingerprint(repo, undefined, files);
  assert.notEqual(dirty, base);
  // Second edit of an already-dirty file with identical size and mtime.
  const before = statSync(path.join(repo, 'a.txt'));
  writeFileSync(path.join(repo, 'a.txt'), 'alpha\nBETA\n');
  utimesSync(path.join(repo, 'a.txt'), before.atime, before.mtime);
  assert.notEqual(await workspaceFingerprint(repo, undefined, files), dirty);
  git(repo, 'checkout', '--', 'a.txt');
  assert.equal(await workspaceFingerprint(repo, undefined, files), base);
  mkdirSync(path.dirname(settings), { recursive: true });
  writeFileSync(settings, '{"permissions":{"allow":["Bash(*)"]}}');
  assert.equal(git(repo, 'status', '--porcelain').trim(), '', 'the settings file is gitignored');
  const withSettings = await workspaceFingerprint(repo, undefined, files);
  assert.notEqual(withSettings, base, 'ignored native settings still count');
  git(repo, 'update-index', '--skip-worktree', 'a.txt');
  const hidden = await workspaceFingerprint(repo, undefined, files);
  assert.notEqual(hidden, withSettings, 'skip-worktree flags count');
  writeFileSync(path.join(repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho planted\n');
  assert.notEqual(await workspaceFingerprint(repo, undefined, files), hidden, 'a planted hook counts');
  assert.equal(workspaceUnchanged('unknown', 'unknown'), false);
  assert.equal(workspaceUnchanged(null, 'git:x'), false);
  const plain = path.join(root, 'plain');
  mkdirSync(path.join(plain, 'node_modules', 'pkg'), { recursive: true });
  const walked = await workspaceFingerprint(plain);
  assert.match(walked, /^walk:/);
  writeFileSync(path.join(plain, 'node_modules', 'pkg', 'x.js'), '1');
  assert.notEqual(await workspaceFingerprint(plain), walked, 'non-git walk skips nothing');
});

test('a write that fails without changes is released; one that changed files keeps its review lock; restart reconciles', { timeout: 90000 }, async t => {
  let mode = 'none';
  const { root, pool, store } = setup(t, { execute: (route, model, task) => {
    if (mode === 'change') writeFileSync(path.join(task.workspace, 'new.txt'), 'x');
    return { cancel() {}, done: Promise.resolve({ error: 'PERMISSION_REQUIRED', detail: 'denied' }) };
  } });
  const repo = repository(root);
  const submit = key => pool.submit({ prompt: 'p', workspace: repo, kind: 'write', mode: 'execute', routeId: 'codex-b', idempotencyKey: key });
  const clean = submit('clean-failure-1');
  const done = await until(() => ['failed', 'needs_review'].includes(pool.get(clean.id).state) && pool.get(clean.id), 'clean failure');
  assert.equal(done.state, 'failed');
  assert.equal(done.error, 'PERMISSION_REQUIRED');
  assert.ok(done.events.some(event => event.kind === 'no_workspace_changes'));
  mode = 'change';
  const dirty = submit('dirty-failure-1');
  assert.equal((await until(() => ['failed', 'needs_review'].includes(pool.get(dirty.id).state) && pool.get(dirty.id), 'dirty failure')).state, 'needs_review');
  // Restart: an interrupted task whose snapshot still matches is released; a changed one is kept.
  const snapshot = await pool.workspaceState({ workspace: repo, routeId: 'codex-b' });
  const insert = (id, workspace) => { store.insert({ id, key: `k-${id}`, fingerprint: 'f', workspace, request: { prompt: 'p', workspace, kind: 'write', routeId: 'codex-b' } }); store.update(id, 'needs_review', null, 'INTERRUPTED'); store.event(id, 'workspace_snapshot', snapshot); };
  const other = mkdtempSync(path.join(root, 'other-'));
  insert('00000000-0000-4000-8000-000000000001', repo);
  insert('00000000-0000-4000-8000-000000000002', other);
  await pool.reconcileInterrupted(0);
  assert.equal(store.get('00000000-0000-4000-8000-000000000001').state, 'failed');
  assert.equal(store.get('00000000-0000-4000-8000-000000000002').state, 'needs_review');
});

test('WSL routes always keep the review lock after a failed write', { timeout: 90000 }, async t => {
  const { root, pool } = setup(t, { routes: [{ id: 'agy-wsl', adapter: 'agy', runtime: 'wsl', wsl: { distro: 'Ubuntu', home: '/home/u' }, executable: '/home/u/.local/bin/agy', profile: 'acc2', enabled: true, billing: 'subscription', trustedSettings: true, models: [{ id: 'm', alias: 'M', group: 'high', kinds: ['write'] }] }],
    execute: () => ({ cancel() {}, done: Promise.resolve({ error: 'CLI_FAILED' }) }) });
  const task = pool.submit({ prompt: 'p', workspace: root, kind: 'write', routeId: 'agy-wsl', idempotencyKey: 'wsl-failure-1' });
  assert.equal((await until(() => ['failed', 'needs_review'].includes(pool.get(task.id).state) && pool.get(task.id), 'wsl failure')).state, 'needs_review');
});

test('director wiring: pool MCP and read rule for claude, MCP and opt-in network for codex; workers unchanged; lease stays out of stored records', () => {
  const claude = { id: 'c', adapter: 'claude', executable: process.execPath, billing: 'subscription' };
  const codex = { id: 'x', adapter: 'codex', executable: process.execPath, billing: 'subscription', sandboxNetwork: true };
  const task = { prompt: 'Direct the relay.', workspace: 'D:\\repo', kind: 'write', mode: 'execute' };
  const context = { profile: 'director', directory: 'C:\\data', readPaths: ['C:\\Users\\u\\.skills-manager\\skills'], token: 'f'.repeat(64), relay: { id: 'r1', generation: 2, lease: 'a'.repeat(64), staleSeconds: 1800 } };
  const worker = buildArguments(claude, { id: 'm' }, task);
  assert.equal(worker[worker.indexOf('--mcp-config') + 1], '{"mcpServers":{}}');
  const directed = buildArguments(claude, { id: 'm' }, task, context);
  const mcp = JSON.parse(directed[directed.indexOf('--mcp-config') + 1]);
  assert.deepEqual(Object.keys(mcp.mcpServers), ['cli-agent-pool']);
  assert.equal(mcp.mcpServers['cli-agent-pool'].env.CLI_AGENT_POOL_HOME, 'C:\\data');
  assert.ok(!JSON.stringify(directed).includes('f'.repeat(64)), 'the task token never appears in argv');
  assert.ok(directed.includes('--strict-mcp-config'));
  assert.ok(directed.includes('Read(//c/Users/u/.skills-manager/skills/**)'));
  assert.ok(!directed.some(arg => /dangerously|bypass/i.test(arg)));
  const codexArgs = buildArguments(codex, { id: 'm' }, task, context).join(' ');
  assert.match(codexArgs, /mcp_servers\.cli-agent-pool\.command=/);
  assert.match(codexArgs, /sandbox_workspace_write\.network_access=true/);
  assert.match(codexArgs, /--sandbox workspace-write/);
  assert.doesNotMatch(buildArguments(codex, { id: 'm' }, task).join(' '), /mcp_servers|network_access/);
  const prompt = taskPrompt(task, context);
  assert.match(prompt, /director protocol v1/);
  assert.doesNotMatch(prompt, /pool_relay_heartbeat/);
  assert.ok(!prompt.includes('a'.repeat(64)), 'Pool does not own relay leases');
  assert.doesNotMatch(taskPrompt(task), /director protocol/);
});

test('MCP and worker processes cannot create directors; read paths must stay under owner roots', { timeout: 90000 }, async t => {
  const { root, pool } = setup(t, { execute: () => ({ cancel() {}, done: Promise.resolve({ error: 'CLI_FAILED' }) }) });
  const repo = repository(root);
  await assert.rejects(pool.submitLive({ prompt: 'p', workspace: repo, kind: 'write', mode: 'execute', profile: 'director', routeId: 'claude-a', idempotencyKey: 'mcp-director-1' }), { code: 'OWNER_ONLY' });
  assert.throws(() => pool.submit({ prompt: 'p', workspace: repo, kind: 'write', mode: 'execute', profile: 'director', routeId: 'claude-a', idempotencyKey: 'mcp-director-2' }), { code: 'OWNER_ONLY' });
  assert.throws(() => validateReadPaths([root], [path.join(root, 'skills')]), { code: 'READ_PATH_DENIED' });
  mkdirSync(path.join(root, 'skills', 'one'), { recursive: true });
  assert.deepEqual(validateReadPaths([path.join(root, 'skills', 'one')], [path.join(root, 'skills')]).length, 1);
  await assert.rejects(pool.submitDirector({ prompt: 'p', workspace: repo, routeId: 'paid', idempotencyKey: 'paid-director-1' }), { code: 'PAID_ROUTE_DENIED' });
  const run = spawnSync(process.execPath, [poolBin, 'preflight', '--route', 'x'], { env: { ...process.env, CLI_AGENT_POOL_HOME: path.join(root, 'cli-home'), CLI_AGENT_POOL_WORKER: '1' }, encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /OWNER_ONLY/);
  const preflightRun = spawnSync(process.execPath, [poolBin, 'preflight', '--route', 'claude-a'], { env: { ...process.env, CLI_AGENT_POOL_HOME: path.join(root, 'cli-home'), CLI_AGENT_POOL_WORKER: '1' }, encoding: 'utf8' });
  assert.match(preflightRun.stderr, /OWNER_ONLY/);
});

test('preflight runs verifiable probes, caches by key, and gates director admission with exact fixes', { timeout: 90000 }, async t => {
  let behave = 'good';
  let lastContext;
  const { root, pool, store, config } = setup(t, { execute: (route, model, task, python, progress, directory, context) => {
    lastContext = context;
    const prompt = context.promptOverride;
    const script = /node "([^"]+probe\.mjs)"/.exec(prompt)[1];
    const done = (async () => { if (behave === 'good' || behave === 'split') {
      // Async: the service probe calls back into this process's HTTP server.
      for (const step of ['shell-a', 'shell-b', 'shell-c', 'commit', 'remote', 'service']) await execFileAsync(process.execPath, [script, step], { cwd: task.workspace });
      context.watch.events.push(...(behave === 'split' ? [['shell-a'], ['shell-b', 'shell-c']] : [['shell-a', 'shell-b', 'shell-c']]));
      pool.preflightAck(/"nonce":"([a-f0-9]{64})"/.exec(prompt)[1], context.token);
      const read = /file-read tool, read (.+?)\. Write line (\d+) of it exactly, with no other text, into (.+?) using/.exec(prompt);
      writeFileSync(read[3], readFileSync(read[1], 'utf8').split(/\r?\n/)[Number(read[2]) - 1]);
      for (const item of context.watch.reads) item.nativeRead = true;
    } return { result: report }; })();
    return { cancel() {}, done };
  } });
  const token = randomBytes(32).toString('hex');
  const app = createServer(pool, token, 0, { directory: root, token: randomBytes(32).toString('hex') });
  config.port = (await app.listen()).port;
  t.after(() => { app.server.close(); app.server.closeAllConnections(); });
  const repo = repository(root);
  const bare = path.join(root, 'origin.git');
  git(root, 'init', '-q', '--bare', bare);
  git(repo, 'remote', 'add', 'origin', bare);
  git(repo, 'push', '-q', 'origin', 'main');
  const skills = path.join(root, 'skills', 'project-brain');
  mkdirSync(skills, { recursive: true });
  writeFileSync(path.join(skills, 'SKILL.md'), '---\nname: x\n---\n# Project Brain skill heading\nUse the director contract carefully.\n');
  const input = { routeId: 'claude-a', workspace: repo, readPaths: [skills] };
  // Unready route: admission fails in seconds with the exact command.
  await assert.rejects(pool.submitDirector({ prompt: 'direct', workspace: repo, routeId: 'claude-a', readPaths: [skills], idempotencyKey: 'director-early-1' }), error => error.code === 'PREFLIGHT_REQUIRED' && error.message.includes('cli-agent-pool preflight --route claude-a'));
  const started = await pool.preflight(input);
  assert.ok(started.taskId);
  const probeDir = path.join(repo, `.cli-agent-pool-preflight-${started.taskId.slice(0, 8)}`);
  const finished = await until(() => ['succeeded', 'failed', 'needs_review'].includes(pool.get(started.taskId).state) && pool.get(started.taskId), 'preflight task');
  assert.equal(finished.state, 'succeeded', JSON.stringify({ error: finished.error, detail: finished.errorDetail, events: finished.events.map(e => e.kind + ':' + e.detail.slice(0, 120)) }));
  assert.ok(!existsSync(probeDir), 'probe directory is removed');
  assert.ok(!JSON.stringify(finished).includes(lastContext.token), 'task token is not stored');
  const status = await pool.preflightStatus(input);
  assert.equal(status.ready, true, JSON.stringify(status));
  assert.equal(status.singleInvocation, 'verified');
  assert.equal(status.taskToken, 'verified');
  for (const name of ['shell', 'poolMcp', 'readOutside', 'gitCommit', 'gitRemote', 'poolService']) assert.equal(status.capabilities[name].status, 'passed', name);
  assert.equal((await pool.preflight(input)).cached, true, 'a current ready result is reused');
  const director = await pool.submitDirector({ prompt: 'direct', workspace: repo, routeId: 'claude-a', readPaths: [skills], idempotencyKey: 'director-ok-1' });
  assert.equal(JSON.parse(store.get(director.id).request).profile, 'director');
  await until(() => !['queued', 'starting', 'running'].includes(pool.get(director.id).state), 'director');
  // A native settings change invalidates the key.
  mkdirSync(path.join(repo, '.claude'), { recursive: true });
  writeFileSync(path.join(repo, '.claude', 'settings.local.json'), '{"permissions":{"deny":["Bash(*)"]}}');
  await assert.rejects(pool.submitDirector({ prompt: 'direct', workspace: repo, routeId: 'claude-a', readPaths: [skills], idempotencyKey: 'director-changed-1' }), { code: 'PREFLIGHT_REQUIRED' });
  // A model that splits the compound command, or does nothing, fails with fixes.
  behave = 'split';
  const split = await pool.preflight({ ...input, force: true });
  await until(() => !['queued', 'starting', 'running'].includes(pool.get(split.taskId).state), 'split preflight');
  const splitStatus = await pool.preflightStatus(input);
  assert.equal(splitStatus.capabilities.shell.status, 'failed');
  assert.match(splitStatus.capabilities.shell.fix, /settings\.local\.json/);
  behave = 'idle';
  const idle = await pool.preflight({ ...input, force: true });
  await until(() => !['queued', 'starting', 'running'].includes(pool.get(idle.taskId).state), 'idle preflight');
  await assert.rejects(pool.submitDirector({ prompt: 'direct', workspace: repo, routeId: 'claude-a', readPaths: [skills], idempotencyKey: 'director-failed-1' }), error => error.code === 'PREFLIGHT_FAILED' && /poolMcp/.test(error.message) && /gitCommit/.test(error.message));
  // The unauthenticated probe endpoint accepts only a live nonce plus its secret.
  const response = await fetch(`http://127.0.0.1:${config.port}/preflight/${'0'.repeat(64)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"secret":"x"}' });
  assert.equal(response.status, 404);
  assert.equal(evaluateShellEvidence([]), 'unverified');
});
