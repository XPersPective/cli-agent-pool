import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { configSchema, saveConfig } from '../src/config.js';
import { profileEnvironment, profileDirectory, clearProfileAuth, clearProfileDirectory } from '../src/profiles.js';
import { isolatedLoginRoute } from '../src/accounts.js';
import { extractAntigravityEmail, antigravityQuota } from '../src/quotas.js';
import { executableArgv, quota } from '../src/adapters.js';
import { browserUI } from '../src/web.js';
import { Store } from '../src/store.js';
import { Pool } from '../src/pool.js';

const temp = t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pool-multi-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return dir;
};

const makeJwt = payload => {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.sig`;
};

test('codex profiles enforce file credential store without copying credentials', t => {
  const directory = temp(t);
  const env = profileEnvironment({ adapter: 'codex', profile: 'acc1' }, directory, true);
  assert.deepEqual(env, { CODEX_HOME: path.join(directory, 'profiles', 'codex', 'acc1') });
  const cfg = readFileSync(path.join(env.CODEX_HOME, 'config.toml'), 'utf8');
  assert.match(cfg, /cli_auth_credentials_store\s*=\s*"file"/);
  assert.equal(existsSync(path.join(env.CODEX_HOME, 'auth.json')), false);
});

test('isolatedLoginRoute selects acc1 first and skips already used profiles', () => {
  const config = {
    routes: [
      { id: 'codex-local', adapter: 'codex', executable: process.execPath, enabled: true, billing: 'subscription', trustedSettings: true, models: [] },
      { id: 'codex-acc2', adapter: 'codex', executable: process.execPath, profile: 'acc2', enabled: true, billing: 'subscription', trustedSettings: true, models: [] },
    ],
  };
  const staged = isolatedLoginRoute(config, 'codex-local');
  assert.equal(staged.id, 'codex-local');
  assert.equal(staged.profile, 'acc1');
  const second = isolatedLoginRoute(config, 'codex-local', ['acc1']);
  assert.equal(second.profile, 'acc3');
});

test('extractAntigravityEmail reads id_token_email or JWT email without credential files', async t => {
  const dir = temp(t);
  assert.equal(extractAntigravityEmail({ id_token: makeJwt({ email: 'jwt@example.com' }) }), 'jwt@example.com');
  const tokenFile = path.join(dir, 'token.json');
  writeFileSync(tokenFile, JSON.stringify({ id_token: makeJwt({ email: 'cred@example.com' }), token: {} }));
  const res = await antigravityQuota(dir, { tokenFile, credentialStore: false });
  assert.equal(res.status, 'auth_required');
  assert.equal(res.email, 'cred@example.com');
});

test('clearProfileAuth removes only that profile login files while preserving others', t => {
  const directory = temp(t);
  const codexAcc1 = { adapter: 'codex', profile: 'acc1' };
  const codexAcc2 = { adapter: 'codex', profile: 'acc2' };
  const d1 = profileDirectory(codexAcc1, directory);
  const d2 = profileDirectory(codexAcc2, directory);
  mkdirSync(d1, { recursive: true });
  mkdirSync(d2, { recursive: true });
  writeFileSync(path.join(d1, 'auth.json'), '{"tokens":{}}');
  writeFileSync(path.join(d2, 'auth.json'), '{"tokens":{}}');
  clearProfileAuth(codexAcc1, directory);
  assert.equal(existsSync(path.join(d1, 'auth.json')), false);
  assert.equal(existsSync(path.join(d2, 'auth.json')), true);
  clearProfileDirectory(codexAcc1, directory);
  assert.equal(existsSync(d1), false);
  assert.equal(existsSync(d2), true);
});

test('agy quota skips /usage subprocess when auth is missing', async t => {
  const dir = temp(t);
  const marker = path.join(dir, 'agy-called');
  const fakeAgy = path.join(dir, 'agy.cjs');
  writeFileSync(fakeAgy, `require('fs').writeFileSync(${JSON.stringify(marker)}, '1');`);
  const route = { id: 'agy-acc2', adapter: 'agy', profile: 'acc2', executable: fakeAgy, billing: 'subscription' };
  const snap = await quota(route, dir, process.platform === 'win32' ? 'python' : 'python3', dir);
  assert.equal(snap.status, 'auth_required');
  assert.equal(existsSync(marker), false);
});

test('executableArgv resolves Windows codex.js wrapper directly to codex.exe when present', t => {
  const dir = temp(t);
  const binDir = path.join(dir, 'bin');
  const archPkg = process.arch === 'arm64' ? 'codex-win32-arm64' : 'codex-win32-x64';
  const triple = process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
  const nativeDir = path.join(dir, 'node_modules', '@openai', archPkg, 'vendor', triple, 'bin');
  mkdirSync(binDir, { recursive: true });
  mkdirSync(nativeDir, { recursive: true });
  const jsEntry = path.join(binDir, 'codex.js');
  const exeEntry = path.join(nativeDir, 'codex.exe');
  writeFileSync(jsEntry, '');
  writeFileSync(exeEntry, '');
  const argv = executableArgv(jsEntry);
  if (process.platform === 'win32') {
    assert.deepEqual(argv, [exeEntry]);
  } else {
    assert.deepEqual(argv, [process.execPath, jsEntry]);
  }
});

test('browserUI finish_switch isolates unprofiled routes, rejects duplicates and logout_route clears only isolated auth', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pool-ui-multi-'));
  const fakeAgy = path.join(dir, 'fake-agy.cjs');
  writeFileSync(fakeAgy, 'process.exit(0);');
  const initialConfig = configSchema.parse({
    routes: [
      { id: 'agy-local', adapter: 'agy', executable: fakeAgy, enabled: true, billing: 'subscription', trustedSettings: true, models: [] },
      { id: 'agy-acc2', adapter: 'agy', executable: fakeAgy, profile: 'acc2', enabled: true, billing: 'subscription', trustedSettings: true, models: [] },
    ],
  });
  const acc2TokenDir = path.join(dir, 'profiles', 'agy', 'acc2', '.gemini', 'antigravity-cli');
  mkdirSync(acc2TokenDir, { recursive: true });
  writeFileSync(path.join(acc2TokenDir, 'antigravity-oauth-token'), JSON.stringify({ id_token_email: 'second@example.com', token: { refresh_token: 'r2' } }));

  const configPath = path.join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify({ workspaceRoots: [], routes: [] }));
  const rev = createHash('sha256').update(readFileSync(configPath, 'utf8')).digest('hex');
  const saved = saveConfig(dir, initialConfig, rev);
  const store = new Store(':memory:');
  const pool = new Pool(saved, store, { directory: dir, settleMs: 0 });
  t.after(async () => {
    await pool.close();
    store.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const openedRoutes = [];
  const ui = browserUI(pool, { directory: dir, token: 'a'.repeat(64) }, {
    openLogin: async route => { openedRoutes.push(route); return { opened: true, message: 'opened' }; },
  });

  // Logout on unprofiled route is rejected; on isolated acc2 it clears only acc2 token
  await assert.rejects(ui.operation({ operation: 'logout_route', payload: { routeId: 'agy-local' } }), { code: 'LOGOUT_UNSUPPORTED' });
  await ui.operation({ operation: 'logout_route', payload: { routeId: 'agy-acc2' } });
  assert.equal(existsSync(path.join(acc2TokenDir, 'antigravity-oauth-token')), false);

  // Restore acc2 token, then test add_account duplicate detection + profile cleanup
  writeFileSync(path.join(acc2TokenDir, 'antigravity-oauth-token'), JSON.stringify({ id_token_email: 'second@example.com', token: { refresh_token: 'r2' } }));
  const addStarted = await ui.operation({ operation: 'add_account', payload: { routeId: 'agy-local' } });
  assert.equal(addStarted.pending, 'agy-acc3');
  const acc3TokenDir = path.join(dir, 'profiles', 'agy', 'acc3', '.gemini', 'antigravity-cli');
  mkdirSync(acc3TokenDir, { recursive: true });
  writeFileSync(path.join(acc3TokenDir, 'antigravity-oauth-token'), JSON.stringify({ id_token_email: 'second@example.com', token: { refresh_token: 'r-dup' } }));
  await assert.rejects(ui.operation({ operation: 'finish_account', payload: { routeId: 'agy-local' } }), { code: 'DUPLICATE_ACCOUNT' });
  assert.equal(existsSync(path.join(dir, 'profiles', 'agy', 'acc3')), false, 'duplicate candidate directory must be cleaned up');

  // Test isolated switch on agy-local -> acc1, and verify retrying reuses acc1 without jumping profiles
  const sw = await ui.operation({ operation: 'login', payload: { routeId: 'agy-local', isolated: true } });
  assert.equal(sw.profile, 'acc1');
  const markerFile = path.join(dir, 'profiles', 'agy', 'acc1', 'pending-marker.txt');
  writeFileSync(markerFile, 'keep');
  const swRetry = await ui.operation({ operation: 'login', payload: { routeId: 'agy-local', isolated: true } });
  assert.equal(swRetry.profile, 'acc1');
  assert.equal(existsSync(markerFile), true, 'retrying isolated login must not wipe the active pending profile');
  assert.equal((await ui.operation({ operation: 'finish_switch', payload: { routeId: 'agy-local' } })).pending, 'agy-local');

  // Retrying add_account for the same route also reuses the same pending profile instead of leaking acc4/acc5
  const add1 = await ui.operation({ operation: 'add_account', payload: { routeId: 'agy-local' } });
  const add2 = await ui.operation({ operation: 'add_account', payload: { routeId: 'agy-local' } });
  assert.equal(add1.pending, 'agy-acc3');
  assert.equal(add2.pending, 'agy-acc3');
  const acc1TokenDir = path.join(dir, 'profiles', 'agy', 'acc1', '.gemini', 'antigravity-cli');
  mkdirSync(acc1TokenDir, { recursive: true });
  writeFileSync(path.join(acc1TokenDir, 'antigravity-oauth-token'), JSON.stringify({ id_token_email: 'first@example.com', token: { refresh_token: 'r1' } }));
  const swDone = await ui.operation({ operation: 'finish_switch', payload: { routeId: 'agy-local' } });
  assert.equal(swDone.switchedRoute, 'agy-local');
  assert.equal(swDone.profile, 'acc1');
  assert.equal(swDone.email, 'first@example.com');
  assert.equal(pool.config.routes.find(r => r.id === 'agy-local').profile, 'acc1');

  // Deleting agy-acc2 removes its profile folder from disk
  await ui.operation({ operation: 'delete_route', payload: { routeId: 'agy-acc2' } });
  assert.equal(existsSync(path.join(dir, 'profiles', 'agy', 'acc2')), false);
  assert.deepEqual(openedRoutes.map(r => r.profile), ['acc3', 'acc1', 'acc1', 'acc3', 'acc3']);

  // Background quotas with includeDisabled:false skips disabled routes while snapshot caches cleanly
  const disabledConfig = structuredClone(pool.config);
  disabledConfig.routes.push({ id: 'agy-off', adapter: 'agy', executable: fakeAgy, enabled: false, billing: 'subscription', trustedSettings: true, models: [] });
  pool.config = disabledConfig;
  const queried = [];
  pool.getQuota = async routeId => { queried.push(routeId); return { connection: routeId, status: 'available', windows: [], observedAt: new Date().toISOString() }; };
  await ui.operation({ operation: 'quotas', payload: { includeDisabled: false, force: false } });
  assert.deepEqual(queried, ['agy-local']);
  await ui.operation({ operation: 'quotas', payload: { routeId: 'agy-off', force: true } });
  assert.deepEqual(queried, ['agy-local', 'agy-off']);
});
