import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { configSchema } from '../src/config.js';
import { routeCommand, commandArgv, buildArguments } from '../src/adapters.js';
import { mirrorAgyPermissions, windowsToWsl, wslToWindows, wslUriToWindows, wslExecutable, profileEnvironment } from '../src/profiles.js';
import { agyProjectArguments } from '../src/agy-project.js';
import { nextAccountRoute, detectWslAgy, prepareWslProfile } from '../src/accounts.js';
import { antigravityQuota, claudeQuota } from '../src/quotas.js';
import { openCliLogin } from '../src/web.js';

const temp = t => { const dir = mkdtempSync(path.join(tmpdir(), 'pool-accounts-')); t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })); return dir; };
const model = { id: 'm1', alias: 'M1', group: 'unassigned', memberships: [], enabled: true, efforts: [], kinds: ['text', 'read', 'write'] };
const native = (adapter, extra = {}) => ({ id: `${adapter}-local`, adapter, executable: process.execPath, enabled: true, billing: 'subscription', trustedSettings: true, models: [structuredClone(model)], ...extra });
const wslRoute = (extra = {}) => ({ id: 'agy-acc2', adapter: 'agy', executable: '/home/u/.local/bin/agy', enabled: true, billing: 'subscription', trustedSettings: true, profile: 'acc2', runtime: 'wsl', wsl: { distro: 'Ubuntu', home: '/home/u' }, models: [structuredClone(model)], ...extra });
const parse = routes => configSchema.safeParse({ routes });
const messages = result => result.success ? [] : result.error.issues.map(issue => issue.message).join(' | ');

test('account profiles are accepted only where the official CLI can keep separate logins', () => {
  assert.equal(parse([native('codex'), native('codex', { id: 'codex-acc2', profile: 'acc2' })]).success, true);
  assert.equal(parse([native('claude', { profile: 'work' })]).success, true);
  assert.equal(parse([native('agy'), wslRoute()]).success, true);
  assert.match(messages(parse([native('agy', { profile: 'acc2' })])), /WSL çalışma ortamını seçin/);
  assert.match(messages(parse([native('opencode', { profile: 'acc2' })])), /yalnızca Codex, Claude ve Antigravity/);
  assert.match(messages(parse([native('codex', { runtime: 'wsl', wsl: { distro: 'Ubuntu', home: '/home/u' } })])), /yalnızca Antigravity/);
  assert.match(messages(parse([wslRoute({ wsl: undefined })])), /dağıtımı ve Linux ev klasörü/);
  assert.match(messages(parse([wslRoute({ executable: 'C:\\agy.exe' })])), /mutlak Linux yolu/);
  assert.match(messages(parse([native('codex', { profile: 'acc2' }), native('codex', { id: 'codex-acc2b', profile: 'acc2' })])), /aynı hesap profili/);
  assert.match(messages(parse([native('claude', { profile: 'acc2', api: { protocol: 'anthropic', baseUrl: 'https://example.test' } })])), /API bağlantısı hesap profili kullanmaz/);
});

test('Codex and Claude profiles run with their own native config directory', t => {
  const directory = temp(t);
  const codex = routeCommand(native('codex', { profile: 'acc2' }), directory);
  assert.deepEqual(codex.argv, [process.execPath]);
  assert.deepEqual(codex.env, { CODEX_HOME: path.join(directory, 'profiles', 'codex', 'acc2') });
  assert.equal(existsSync(codex.env.CODEX_HOME), true);
  assert.deepEqual(routeCommand(native('claude', { profile: 'acc2' }), directory).env, { CLAUDE_CONFIG_DIR: path.join(directory, 'profiles', 'claude', 'acc2') });
  assert.deepEqual(routeCommand(native('codex'), directory).env, {}, 'the default account keeps the CLI default home');
  assert.deepEqual(profileEnvironment(native('claude', { profile: 'x', api: { protocol: 'anthropic', baseUrl: 'https://e.test' } }), directory), {});
});

test('a WSL Antigravity account runs shell-free with its own HOME and native task arguments', t => {
  const route = wslRoute();
  const prefix = [wslExecutable(), '-d', 'Ubuntu', '--exec', '/usr/bin/env', 'HOME=/home/u/.cli-agent-pool/profiles/agy/acc2', '/home/u/.local/bin/agy'];
  assert.deepEqual(commandArgv(route), prefix);
  const workspace = temp(t);
  const argv = buildArguments(route, { id: 'gemini-pro', efforts: [] }, { kind: 'write', workspace, prompt: 'x' });
  assert.deepEqual(argv.slice(0, prefix.length), prefix);
  assert.ok(argv.includes('accept-edits') && argv.includes('--output-format'));
  assert.ok(!argv.some(arg => /skip-permissions/.test(arg)), 'native permission checks stay on');
});

test('Windows and WSL paths translate both ways', () => {
  assert.equal(windowsToWsl('D:\\repositories\\x'), '/mnt/d/repositories/x');
  assert.equal(windowsToWsl('C:/Users/u/'), '/mnt/c/Users/u');
  assert.equal(windowsToWsl('D:\\'), '/mnt/d');
  assert.equal(windowsToWsl('\\\\server\\share'), null);
  assert.equal(wslToWindows('/mnt/d/repositories/x'), 'D:\\repositories\\x');
  assert.equal(wslToWindows('/home/u'), null);
  assert.equal(wslUriToWindows('file:///mnt/d/my%20repo'), 'D:\\my repo');
  assert.equal(wslUriToWindows('file:///home/u'), null);
});

test('owner Antigravity permissions mirror into a WSL profile without credentials', t => {
  const home = temp(t), target = path.join(temp(t), '.gemini');
  const projects = path.join(home, '.gemini', 'config', 'projects');
  mkdirSync(projects, { recursive: true });
  mkdirSync(path.join(home, '.gemini', 'antigravity-cli'), { recursive: true });
  writeFileSync(path.join(projects, 'p1.json'), JSON.stringify({ id: 'p1', projectResources: { resources: [{ gitFolder: { folderUri: 'file:///d%3A/repositories/my%20repo' } }] }, settings: { fileAccessPolicy: 'AGENT_SETTING_POLICY_ALLOW' } }));
  writeFileSync(path.join(projects, 'p2.json'), JSON.stringify({ id: 'p2', projectResources: { resources: [{ folderUri: 'file:///C:/work' }] } }));
  writeFileSync(path.join(projects, 'remote.json'), JSON.stringify({ id: 'remote', projectResources: { resources: [{ folderUri: 'https://example.test/x' }] } }));
  writeFileSync(path.join(home, '.gemini', 'antigravity-cli', 'settings.json'), JSON.stringify({ model: 'x', permissions: { allow: ['read_file(D:/repositories/a)', 'write_file(D:/repositories/a)', 'command(regex:^git status$)', 'read_file(\\\\server\\x)'] }, trustedWorkspaces: ['D:\\repositories\\a', '\\\\server\\x'] }));
  writeFileSync(path.join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'), '{"token":"must-not-move"}');
  const summary = mirrorAgyPermissions(target, home);
  assert.deepEqual(summary, { projects: 2, grants: 3, trusted: 1 });
  const p1 = JSON.parse(readFileSync(path.join(target, 'config', 'projects', 'p1.json'), 'utf8'));
  assert.equal(p1.projectResources.resources[0].gitFolder.folderUri, 'file:///mnt/d/repositories/my%20repo');
  assert.deepEqual(p1.settings, { fileAccessPolicy: 'AGENT_SETTING_POLICY_ALLOW' });
  assert.equal(JSON.parse(readFileSync(path.join(target, 'config', 'projects', 'p2.json'), 'utf8')).projectResources.resources[0].folderUri, 'file:///mnt/c/work');
  assert.equal(existsSync(path.join(target, 'config', 'projects', 'remote.json')), false);
  const settingsFile = path.join(target, 'antigravity-cli', 'settings.json');
  const settings = JSON.parse(readFileSync(settingsFile, 'utf8'));
  assert.deepEqual(settings.permissions.allow, ['read_file(/mnt/d/repositories/a)', 'write_file(/mnt/d/repositories/a)', 'command(regex:^git status$)']);
  assert.deepEqual(settings.trustedWorkspaces, ['/mnt/d/repositories/a']);
  assert.equal(existsSync(path.join(target, 'antigravity-cli', 'antigravity-oauth-token')), false, 'credentials are never mirrored');
  writeFileSync(settingsFile, JSON.stringify({ ...settings, model: 'profile-choice', permissions: { allow: [...settings.permissions.allow, 'command(regex:^ls$)'] } }));
  mirrorAgyPermissions(target, home);
  const again = JSON.parse(readFileSync(settingsFile, 'utf8'));
  assert.equal(again.model, 'profile-choice', 'profile settings survive a later sync');
  assert.equal(again.permissions.allow.filter(item => item === 'read_file(/mnt/d/repositories/a)').length, 1);
  assert.ok(again.permissions.allow.includes('command(regex:^ls$)'));
});

test('mirrored WSL projects select the native project for a Windows workspace', { skip: process.platform !== 'win32' }, t => {
  const home = temp(t), workspace = temp(t);
  const projects = path.join(home, '.gemini', 'config', 'projects');
  mkdirSync(projects, { recursive: true });
  writeFileSync(path.join(projects, 'p.json'), JSON.stringify({ id: 'p', projectResources: { resources: [{ folderUri: `file://${windowsToWsl(workspace).split('/').map(encodeURIComponent).join('/')}` }] } }));
  assert.deepEqual(agyProjectArguments(workspace, home, wslUriToWindows), ['--project', 'p']);
  assert.deepEqual(agyProjectArguments(workspace, home), [], 'Windows resolution ignores /mnt URIs');
});

test('adding an account creates a separate disabled route with copied model memberships', () => {
  const codex = native('codex');
  codex.models[0].memberships = [{ group: 'high' }];
  const config = { categories: [{ id: 'high', name: 'Yüksek' }], routes: [codex] };
  const first = nextAccountRoute(config, 'codex-local');
  assert.equal(first.route.id, 'codex-acc2');
  assert.equal(first.route.profile, 'acc2');
  assert.equal(first.route.enabled, false);
  assert.deepEqual(first.route.models[0].memberships, [{ group: 'high' }]);
  assert.notEqual(first.route.models, codex.models);
  assert.equal(nextAccountRoute(first.config, 'codex-local').route.id, 'codex-acc3');
  assert.equal(configSchema.safeParse(first.config).success, true);
  assert.throws(() => nextAccountRoute({ routes: [native('agy')] }, 'agy-local'), { code: 'WSL_UNAVAILABLE' });
  const agy = nextAccountRoute({ routes: [native('agy')] }, 'agy-local', { distro: 'Ubuntu', home: '/home/u', executable: '/home/u/.local/bin/agy' });
  assert.deepEqual({ runtime: agy.route.runtime, wsl: agy.route.wsl, executable: agy.route.executable, profile: agy.route.profile }, { runtime: 'wsl', wsl: { distro: 'Ubuntu', home: '/home/u' }, executable: '/home/u/.local/bin/agy', profile: 'acc2' });
  assert.equal(configSchema.safeParse(agy.config).success, true);
  assert.throws(() => nextAccountRoute({ routes: [native('opencode')] }, 'opencode-local'), { code: 'ACCOUNT_UNSUPPORTED' });
  assert.throws(() => nextAccountRoute({ routes: [] }, 'missing'), { code: 'NOT_FOUND' });
});

test('WSL detection and profile preparation use fixed shell-free commands', async () => {
  const calls = [];
  const run = async argv => { calls.push(argv); return argv.includes('/usr/bin/printenv') ? { code: 0, output: 'Ubuntu\n/home/u\n' } : { code: 0, output: '' }; };
  assert.deepEqual(await detectWslAgy('python', '.', run), { distro: 'Ubuntu', home: '/home/u', executable: '/home/u/.local/bin/agy' });
  assert.deepEqual(calls[1], [wslExecutable(), '-d', 'Ubuntu', '--exec', '/usr/bin/test', '-x', '/home/u/.local/bin/agy']);
  await assert.rejects(detectWslAgy('python', '.', async argv => argv.includes('/usr/bin/printenv') ? { code: 0, output: 'Ubuntu\n/home/u\n' } : { code: 1, output: '' }), { code: 'WSL_AGY_MISSING' });
  await assert.rejects(detectWslAgy('python', '.', async () => ({ code: 1, output: '' })), { code: 'WSL_UNAVAILABLE' });
  let mirrored;
  const prepared = [];
  await prepareWslProfile(wslRoute(), 'python', '.', async argv => { prepared.push(argv); return { code: 0 }; }, target => { mirrored = target; return {}; });
  assert.deepEqual(prepared[0], [wslExecutable(), '-d', 'Ubuntu', '--exec', '/usr/bin/mkdir', '-p', '/home/u/.cli-agent-pool/profiles/agy/acc2']);
  assert.equal(mirrored, '\\\\wsl.localhost\\Ubuntu\\home\\u\\.cli-agent-pool\\profiles\\agy\\acc2\\.gemini');
});

test('profile quotas read only that profile login and never fall back to the default account', async t => {
  const dir = temp(t);
  const missing = await antigravityQuota(undefined, { tokenFile: path.join(dir, 'none'), credentialStore: false });
  assert.equal(missing.status, 'auth_required');
  writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ cachedUsageUtilization: { fetchedAtMs: Date.now(), utilization: { five_hour: { utilization: 40, resets_at: null } } } }));
  const claude = await claudeQuota(path.join(dir, 'unused-home'), dir);
  assert.equal(claude.source, 'claude-code-cache');
  assert.equal(claude.windows[0].remainingPercent, 60);
});

test('login opens the official CLI with the account profile, never with credentials', async t => {
  const directory = temp(t);
  const seen = [];
  const run = async (file, args, options) => { seen.push(JSON.parse(options.env.CLI_AGENT_POOL_LOGIN_ARGV)); seen.at(-1).env = options.env; return { stdout: '{"opened":true}' }; };
  await openCliLogin(native('codex', { profile: 'acc2' }), { platform: 'win32', run, directory });
  assert.deepEqual(seen[0].arguments, ['login']);
  assert.equal(seen[0].env.CODEX_HOME, path.join(directory, 'profiles', 'codex', 'acc2'));
  let prepared = false;
  await openCliLogin(wslRoute(), { platform: 'win32', run, directory, prepare: async () => { prepared = true; } });
  assert.equal(prepared, true);
  assert.equal(seen[1].file, wslExecutable());
  assert.deepEqual(seen[1].arguments, ['-d', 'Ubuntu', '--exec', '/usr/bin/env', 'HOME=/home/u/.cli-agent-pool/profiles/agy/acc2', '/home/u/.local/bin/agy']);
  const manual = await openCliLogin(native('claude', { profile: 'acc2' }), { platform: 'linux', run, directory });
  assert.match(manual.message, /CLAUDE_CONFIG_DIR=".*acc2" claude auth login/);
});
