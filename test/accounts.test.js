import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { configSchema } from '../src/config.js';
import { routeCommand, commandArgv, buildArguments, accountLoggedIn } from '../src/adapters.js';
import { mirrorAgyPermissions, windowsToWsl, wslToWindows, wslUriToWindows, wslExecutable, profileEnvironment, profileHome } from '../src/profiles.js';
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
  assert.equal(parse([native('agy', { profile: 'acc2' })]).success, true);
  assert.match(messages(parse([native('opencode', { profile: 'acc2' })])), /hesap profili desteklenmez/);
  assert.equal(parse([native('zcode', { profile: 'acc2', billing: 'token_plan' })]).success, true);
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
  const agyNative = nextAccountRoute({ routes: [native('agy')] }, 'agy-local');
  assert.equal(agyNative.route.id, 'agy-acc2');
  assert.equal(agyNative.route.profile, 'acc2');
  assert.equal(agyNative.route.runtime, undefined);
  assert.equal(configSchema.safeParse(agyNative.config).success, true);
  assert.throws(() => nextAccountRoute({ routes: [native('agy')] }, 'agy-local', null), { code: 'WSL_UNAVAILABLE' });
  const agy = nextAccountRoute({ routes: [native('agy')] }, 'agy-local', { distro: 'Ubuntu', home: '/home/u', executable: '/home/u/.local/bin/agy' });
  assert.deepEqual({ runtime: agy.route.runtime, wsl: agy.route.wsl, executable: agy.route.executable, profile: agy.route.profile }, { runtime: 'wsl', wsl: { distro: 'Ubuntu', home: '/home/u' }, executable: '/home/u/.local/bin/agy', profile: 'acc2' });
  assert.equal(configSchema.safeParse(agy.config).success, true);
  assert.throws(() => nextAccountRoute({ routes: [native('opencode')] }, 'opencode-local'), { code: 'ACCOUNT_UNSUPPORTED' });
  assert.throws(() => nextAccountRoute({ routes: [] }, 'missing'), { code: 'NOT_FOUND' });
});

test('native Windows Antigravity profile isolates token storage via WSL_DISTRO_NAME and mirrors permissions', t => {
  const directory = temp(t);
  const agyAcc = native('agy', { id: 'agy-acc2', profile: 'acc2' });
  const target = path.join(directory, 'profiles', 'agy', 'acc2');
  assert.deepEqual(routeCommand(agyAcc, directory).env, { USERPROFILE: target, HOME: target, WSL_DISTRO_NAME: 'cli-agent-pool' });
  assert.equal(profileHome(agyAcc, directory, 'C:/real'), target);
  const home = temp(t);
  const projects = path.join(home, '.gemini', 'config', 'projects');
  mkdirSync(projects, { recursive: true });
  mkdirSync(path.join(home, '.gemini', 'antigravity-cli'), { recursive: true });
  writeFileSync(path.join(projects, 'p1.json'), JSON.stringify({ id: 'p1', projectResources: { resources: [{ gitFolder: { folderUri: 'file:///d%3A/repositories/my%20repo' } }] }, settings: { fileAccessPolicy: 'AGENT_SETTING_POLICY_ALLOW' } }));
  writeFileSync(path.join(home, '.gemini', 'config', 'config.json'), JSON.stringify({ userSettings: { cascadeCommandsAutoExecution: 3 } }));
  writeFileSync(path.join(home, '.gemini', 'config', 'mcp_config.json'), JSON.stringify({ mcpServers: { 'cli-agent-pool': { command: 'node' } } }));
  writeFileSync(path.join(home, '.gemini', 'config', '.migrated'), '');
  writeFileSync(path.join(home, '.gemini', 'trustedFolders.json'), JSON.stringify({ 'D:\\repositories': 'TRUST_FOLDER' }));
  writeFileSync(path.join(home, '.gemini', 'antigravity-cli', 'settings.json'), JSON.stringify({ permissions: { allow: ['read_file(D:/repositories/a)', 'command(*)'] }, trustedWorkspaces: ['D:\\repositories\\a'] }));
  const summary = mirrorAgyPermissions(path.join(target, '.gemini'), home, false);
  assert.deepEqual(summary, { projects: 1, grants: 2, trusted: 1 });
  assert.equal(existsSync(path.join(target, '.gemini', 'config', 'config.json')), true);
  assert.equal(existsSync(path.join(target, '.gemini', 'config', 'mcp_config.json')), true);
  assert.equal(existsSync(path.join(target, '.gemini', 'config', '.migrated')), true);
  assert.deepEqual(JSON.parse(readFileSync(path.join(target, '.gemini', 'trustedFolders.json'), 'utf8')), { 'D:\\repositories': 'TRUST_FOLDER' });
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
  const written = [];
  await prepareWslProfile(wslRoute(), 'python', '.', async argv => { prepared.push(argv); return { code: 0 }; }, target => { mirrored = target; return {}; }, (file, content) => written.push([file, content]));
  assert.deepEqual(prepared[0], [wslExecutable(), '-d', 'Ubuntu', '--exec', '/usr/bin/mkdir', '-p', '/home/u/.cli-agent-pool/profiles/agy/acc2', '/home/u/.cli-agent-pool/bin']);
  assert.deepEqual(prepared[1], [wslExecutable(), '-d', 'Ubuntu', '--exec', '/usr/bin/chmod', '755', '/home/u/.cli-agent-pool/bin/xdg-open']);
  assert.equal(written[0][0], '\\\\wsl.localhost\\Ubuntu\\home\\u\\.cli-agent-pool\\bin\\xdg-open');
  assert.match(written[0][1], /^#!\/bin\/sh\n/);
  assert.match(written[0][1], /https:\/\/\*\)/, 'the browser helper opens only https URLs');
  assert.doesNotMatch(written[0][1], /\r/);
  assert.equal(mirrored, '\\\\wsl.localhost\\Ubuntu\\home\\u\\.cli-agent-pool\\profiles\\agy\\acc2\\.gemini');
  let mirroredAfterFailure = false;
  await prepareWslProfile(wslRoute(), 'python', '.', async () => ({ code: 0 }), () => { mirroredAfterFailure = true; }, () => { throw new Error('read-only'); });
  assert.equal(mirroredAfterFailure, true, 'a missing browser helper does not block permission sync');
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
  const run = async (file, args, options) => { seen.push(JSON.parse(options.env.CLI_AGENT_POOL_LOGIN_ARGV)); seen.at(-1).env = options.env; seen.at(-1).script = args.at(-1); return { stdout: '{"opened":true}' }; };
  await openCliLogin(native('codex', { profile: 'acc2' }), { platform: 'win32', run, directory });
  assert.deepEqual(seen[0].arguments, ['login']);
  assert.equal(seen[0].env.CODEX_HOME, path.join(directory, 'profiles', 'codex', 'acc2'));
  let prepared = false;
  await openCliLogin(wslRoute(), { platform: 'win32', run, directory, prepare: async () => { prepared = true; } });
  assert.equal(prepared, true);
  assert.equal(seen[1].file, wslExecutable());
  assert.deepEqual(seen[1].arguments, ['-d', 'Ubuntu', '--exec', '/usr/bin/env', 'HOME=/home/u/.cli-agent-pool/profiles/agy/acc2', 'PATH=/home/u/.cli-agent-pool/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', '/home/u/.local/bin/agy']);
  // wsl.exe rejects quoted options ("--exec"), which closed the login window at once.
  assert.match(seen[1].script, /if \(\$_ -eq '' -or \$_ -match '\\s'\) \{ '"' \+ \$_ \+ '"' \} else \{ \$_ \}/);
  const manual = await openCliLogin(native('claude', { profile: 'acc2' }), { platform: 'linux', run, directory });
  assert.match(manual.message, /CLAUDE_CONFIG_DIR=".*acc2" claude auth login/);
});

test('file-based CLIs get their own home per account profile', t => {
  const directory = temp(t);
  for (const adapter of ['zcode', 'qwen', 'kimi', 'mcode', 'mmx', 'qoder', 'mimo']) {
    const target = path.join(directory, 'profiles', adapter, 'acc2');
    assert.deepEqual(routeCommand(native(adapter, { profile: 'acc2' }), directory).env, { USERPROFILE: target, HOME: target });
    assert.equal(profileHome(native(adapter, { profile: 'acc2' }), directory, 'C:/real'), target);
  }
  assert.equal(profileHome(native('zcode'), directory, 'C:/real'), 'C:/real');
  assert.equal(profileHome(native('codex', { profile: 'acc2' }), directory, 'C:/real'), 'C:/real', 'Codex uses CODEX_HOME, not a home override');
});

test('an account route is added only after that profile reports a login', async t => {
  const directory = temp(t);
  const agy = wslRoute();
  const tokenPath = ['', '', 'wsl.localhost', 'Ubuntu', 'home', 'u', '.cli-agent-pool', 'profiles', 'agy', 'acc2', '.gemini', 'antigravity-cli', 'antigravity-oauth-token'].join('\\');
  const seen = [];
  assert.equal(await accountLoggedIn(agy, '.', 'python', directory, file => { seen.push(file); return {}; }), false);
  assert.equal(seen[0], tokenPath);
  assert.equal(await accountLoggedIn(agy, '.', 'python', directory, () => ({ token: { refresh_token: 'r' } })), true);
  const zcode = native('zcode', { profile: 'acc2' });
  assert.equal(await accountLoggedIn(zcode, '.', 'python', directory), false);
  mkdirSync(path.join(directory, 'profiles', 'zcode', 'acc2', '.zcode', 'v2'), { recursive: true });
  writeFileSync(path.join(directory, 'profiles', 'zcode', 'acc2', '.zcode', 'v2', 'credentials.json'), '{}');
  assert.equal(await accountLoggedIn(zcode, '.', 'python', directory), true);
  const mcode = native('mcode', { profile: 'acc2' });
  assert.equal(await accountLoggedIn(mcode, '.', 'python', directory), false);
  mkdirSync(path.join(directory, 'profiles', 'mcode', 'acc2', '.minimax'), { recursive: true });
  writeFileSync(path.join(directory, 'profiles', 'mcode', 'acc2', '.minimax', 'local-runtime.auth.json'), JSON.stringify({ auth: { accessToken: 'x' } }));
  assert.equal(await accountLoggedIn(mcode, '.', 'python', directory), true);
  const kimiHome = path.join(directory, 'profiles', 'kimi', 'acc2', '.kimi-code');
  assert.equal(await accountLoggedIn(native('kimi', { profile: 'acc2' }), '.', 'python', directory), false);
  mkdirSync(path.join(kimiHome, 'credentials'), { recursive: true });
  writeFileSync(path.join(kimiHome, 'config.toml'), '[providers."managed:kimi-code".oauth]\nkey = "oauth/k1"\n');
  writeFileSync(path.join(kimiHome, 'credentials', 'k1.json'), JSON.stringify({ access_token: 'a' }));
  assert.equal(await accountLoggedIn(native('kimi', { profile: 'acc2' }), '.', 'python', directory), true);
});

test('a retried sign-in reuses the same pending profile instead of adding routes', () => {
  const config = { routes: [native('zcode', { billing: 'token_plan' })] };
  assert.equal(nextAccountRoute(config, 'zcode-local').route.profile, 'acc2');
  assert.equal(nextAccountRoute(config, 'zcode-local').route.profile, 'acc2');
  assert.equal(config.routes.length, 1);
});
