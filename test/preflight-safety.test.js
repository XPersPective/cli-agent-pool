import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { workspaceFingerprint } from '../src/workspace-state.js';
import { fileDigest, nativeSettingsFiles } from '../src/native-settings.js';
import { cachedUsable, createProbe, verifyProbe, preflightKey, summarize } from '../src/preflight.js';
import { watchEvent } from '../src/adapters.js';

const python = process.platform === 'win32' ? 'python' : 'python3';
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=Fixture', '-c', 'commit.gpgsign=false', '-C', cwd, ...args], { encoding: 'utf8' });
function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'cap-preflight-safety-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return root;
}
function repository(t) {
  const root = fixture(t);
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(root, 'a.txt'), 'initial\n');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'fixture');
  return root;
}

test('run-level preflight failure cannot become ready through not-applicable probes', async t => {
  const root = fixture(t);
  const probe = createProbe({ taskId: '11111111', workspace: root, port: 1, capabilities: ['readOutside', 'gitCommit', 'gitRemote'], readPaths: [], facts: { repository: false, origin: false } });
  const result = await verifyProbe(probe, { python, outcome: { error: 'AUTH_REQUIRED' } });
  assert.equal(result.runError, 'AUTH_REQUIRED');
  for (const item of Object.values(result.capabilities)) assert.equal(item.status, 'failed');
});

test('MCP readiness requires the running probe token, and malformed cache dates are unusable', async t => {
  const root = fixture(t);
  const probe = createProbe({ taskId: '11111111', workspace: root, port: 1, capabilities: ['poolMcp'], readPaths: [], facts: {} });
  probe.acks.set('poolMcp', { token: false });
  assert.equal((await verifyProbe(probe, { python, outcome: {} })).capabilities.poolMcp.status, 'failed');
  probe.acks.set('poolMcp', { token: true });
  assert.equal((await verifyProbe(probe, { python, outcome: {} })).capabilities.poolMcp.status, 'passed');
  assert.equal(cachedUsable({ key: 'a', observedAt: 'invalid' }, 'a'), null);
  assert.equal(cachedUsable({ key: 'a', observedAt: new Date(Date.now() + 60_000).toISOString() }, 'a'), null);
  assert.deepEqual(summarize({ observedAt: 'time', runError: 'AUTH_REQUIRED', capabilities: {} }).checkedAt, 'time');
});

test('preflight cache separates effort and hashes common git config from worktrees', async t => {
  const root = repository(t);
  const wt = path.join(fixture(t), 'worktree');
  git(root, 'worktree', 'add', '-q', '-b', 'worker', wt);
  const input = { route: { adapter: 'codex', id: 'fixture', executable: process.execPath }, modelId: 'm', workspace: wt, capabilities: [], readPaths: [], directory: root, python };
  const low = await preflightKey({ ...input, effort: 'low' });
  assert.notEqual(low, await preflightKey({ ...input, effort: 'high' }));
  git(root, 'config', 'remote.origin.url', 'https://example.invalid/fixture.git');
  assert.notEqual(low, await preflightKey({ ...input, effort: 'low' }));
  assert.ok(nativeSettingsFiles(input.route, wt, root).includes(path.join(root, '.git', 'config')));
});

test('fingerprints catch hidden tracked edits, staged-only changes and custom hooks', async t => {
  const root = repository(t);
  git(root, 'update-index', '--assume-unchanged', 'a.txt');
  const before = await workspaceFingerprint(root, python);
  writeFileSync(path.join(root, 'a.txt'), 'hidden edit\n');
  assert.equal(git(root, 'status', '--porcelain'), '');
  assert.notEqual(await workspaceFingerprint(root, python), before);
  git(root, 'update-index', '--no-assume-unchanged', 'a.txt');
  git(root, 'add', 'a.txt');
  writeFileSync(path.join(root, 'a.txt'), 'working tree\n');
  const status = git(root, 'status', '--porcelain');
  const stagedBefore = await workspaceFingerprint(root, python);
  const blob = execFileSync('git', ['-C', root, 'hash-object', '-w', '--stdin'], { input: 'other index bytes\n', encoding: 'utf8' }).trim();
  git(root, 'update-index', '--cacheinfo', `100644,${blob},a.txt`);
  assert.equal(git(root, 'status', '--porcelain'), status);
  assert.notEqual(await workspaceFingerprint(root, python), stagedBefore);
  const hooks = path.join(root, 'custom-hooks');
  mkdirSync(hooks); git(root, 'config', 'core.hooksPath', hooks);
  const hook = path.join(hooks, 'pre-commit');
  writeFileSync(hook, '#!/bin/sh\nexit 0\n');
  const hookBefore = await workspaceFingerprint(root, python);
  writeFileSync(hook, '#!/bin/sh\nexit 1\n');
  assert.notEqual(await workspaceFingerprint(root, python), hookBefore);
});

test('uncertain metadata and symlink workspaces keep conservative fingerprints', async t => {
  const root = fixture(t);
  const large = path.join(root, 'large.json');
  writeFileSync(large, Buffer.alloc(4_194_305));
  assert.throws(() => fileDigest(large), /size limit/);
  assert.equal(await workspaceFingerprint(root, python, [large]), 'unknown');
  const target = path.join(root, 'target'); mkdirSync(target);
  const link = path.join(root, 'link');
  try { symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM') { t.skip('symlink creation unavailable'); return; } throw error; }
  assert.throws(() => fileDigest(link), /regular file/);
  assert.equal(await workspaceFingerprint(root, python), 'unknown');
  assert.equal(readFileSync(large).length, 4_194_305);
});

test('only native tool inputs prove compound shell and outside Read capability', async t => {
  const root = fixture(t);
  writeFileSync(path.join(root, 'SKILL.md'), '# A bounded skill fixture line\n');
  const probe = createProbe({ taskId: '11111111', workspace: root, port: 1, capabilities: ['readOutside'], readPaths: [root], facts: {} });
  mkdirSync(probe.dir);
  writeFileSync(path.join(probe.dir, 'read-0.txt'), probe.reads[0].target.text);
  const watch = { scope: 'probe-fixture', markers: ['shell-a', 'shell-c'], events: [], reads: probe.reads };
  const context = { watch };
  watchEvent(context, { type: 'assistant', message: { content: [{ type: 'text', text: 'probe-fixture shell-a shell-c' }] } });
  watchEvent(context, { type: 'item.completed', item: { type: 'agent_message', text: 'probe-fixture shell-a shell-c' } });
  assert.deepEqual(watch.events, []);
  watchEvent(context, { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'probe-fixture shell-a; probe-fixture shell-c' } }] } });
  assert.deepEqual(watch.events, [['shell-a', 'shell-c']]);
  assert.equal((await verifyProbe(probe, { python, outcome: {} })).capabilities.readOutside.status, 'failed', 'correct line alone does not prove native Read access');
  watchEvent(context, { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: probe.reads[0].target.file } }] } });
  const passed = (await verifyProbe(probe, { python, outcome: {} })).capabilities.readOutside;
  assert.equal(passed.status, 'passed');
  assert.equal(passed.nativeRead, 'verified');
  assert.equal((await verifyProbe(probe, { python, outcome: { error: 'PERMISSION_REQUIRED' } })).capabilities.readOutside.status, 'failed');
});
