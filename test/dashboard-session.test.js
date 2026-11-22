import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initialize, loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { Pool } from '../src/pool.js';
import { createServer } from '../src/server.js';
import { browserUI } from '../src/web.js';

async function setupServer(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cli-agent-pool-session-'));
  initialize(root);
  const config = loadConfig(root);
  const store = new Store(path.join(root, 'pool.sqlite'));
  const pool = new Pool(config, store, root);
  const token = readFileSync(path.join(root, 'access-token'), 'utf8').trim();
  const managementToken = readFileSync(path.join(root, 'management-token'), 'utf8').trim();
  const app = createServer(pool, token, 0, { directory: root, token: managementToken });
  const address = await app.listen();
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, pool, app, base, port: address.port, managementToken };
}

test('dashboard session uses non-expiring v2 signed cookie, ignores prefetches, strips stale tokens and refreshes on GET /', async t => {
  const { app, base, port } = await setupServer(t);
  const pairingURL = app.uiURL();

  // Prefetch and HEAD must not consume the single-use pairing token
  const headRes = await fetch(pairingURL, { method: 'HEAD', redirect: 'manual' });
  assert.equal(headRes.status, 204);
  const prefetchRes = await fetch(pairingURL, { headers: { 'Sec-Purpose': 'prefetch' }, redirect: 'manual' });
  assert.equal(prefetchRes.status, 204);

  // Real navigation redeems the token for a persistent v2 cookie (1-year sliding Max-Age)
  const login = await fetch(pairingURL, { redirect: 'manual' });
  assert.equal(login.status, 303);
  assert.equal(login.headers.get('location'), '/');
  const setCookie = login.headers.get('set-cookie') || '';
  assert.match(setCookie, new RegExp(`^pool_${port}=v2\\.[a-f0-9]{32}\\.[a-f0-9]{64};`));
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.match(setCookie, /Max-Age=31536000/);

  const cookie = setCookie.split(';')[0];

  // Unauthenticated reuse of pairing token still fails 401
  assert.equal((await fetch(pairingURL, { redirect: 'manual' })).status, 401);

  // Already-authenticated browser hitting a stale /?token=... redirects cleanly to /
  const staleWithCookie = await fetch(pairingURL, { headers: { Cookie: cookie }, redirect: 'manual' });
  assert.equal(staleWithCookie.status, 303);
  assert.equal(staleWithCookie.headers.get('location'), '/');
  assert.match(staleWithCookie.headers.get('set-cookie') || '', /Max-Age=31536000/);

  // GET / succeeds and slides the cookie Max-Age forward
  const home = await fetch(`${base}/`, { headers: { Cookie: cookie } });
  assert.equal(home.status, 200);
  const homeSetCookie = home.headers.get('set-cookie') || '';
  assert.ok(homeSetCookie.startsWith(`${cookie};`), 'GET / should keep same v2 sessionId while sliding Max-Age');
  assert.match(homeSetCookie, /Max-Age=31536000/);
});

test('legacy valid v1 cookie upgrades seamlessly to persistent v2, while expired v1 triggers reauthNeeded until re-paired', async t => {
  const { base, port, managementToken } = await setupServer(t);
  const cookieSecret = createHmac('sha256', Buffer.from(managementToken, 'hex')).update('cli-agent-pool-browser-cookie-v1').digest();
  const sign = payload => createHmac('sha256', cookieSecret).update(payload).digest('hex');

  const future = String(Date.now() + 60_000);
  const validV1 = `pool_${port}=${future}.${sign(`${port}:${future}`)}`;
  const upgradeRes = await fetch(`${base}/ui`, {
    method: 'POST',
    headers: { Cookie: validV1, Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ operation: 'snapshot' }),
  });
  assert.equal(upgradeRes.status, 200);
  const upgradedSetCookie = upgradeRes.headers.get('set-cookie') || '';
  assert.match(upgradedSetCookie, new RegExp(`^pool_${port}=v2\\.[a-f0-9]{32}\\.[a-f0-9]{64};`));
  assert.match(upgradedSetCookie, /Max-Age=31536000/);

  const pairStatus = async () => (await fetch(`${base}/manage`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${managementToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ operation: 'pair_ui' }),
  })).json();

  // Foreign origin 403 must NOT falsely mark reauthNeeded
  assert.equal((await fetch(`${base}/ui`, {
    method: 'POST',
    headers: { Cookie: 'pool_0=bad', Origin: 'https://attacker.invalid', 'Content-Type': 'application/json' },
    body: JSON.stringify({ operation: 'snapshot' }),
  })).status, 403);
  assert.equal((await pairStatus()).reauthNeeded, undefined);

  // Same-origin expired v1 cookie is rejected and signals reauthNeeded to desktop shortcut
  const past = String(Date.now() - 60_000);
  const expiredV1 = `pool_${port}=${past}.${sign(`${port}:${past}`)}`;
  assert.equal((await fetch(`${base}/ui`, {
    method: 'POST',
    headers: { Cookie: expiredV1, Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ operation: 'snapshot' }),
  })).status, 403);
  const paired = await pairStatus();
  assert.equal(paired.reauthNeeded, true);

  // Redeeming the new launch URL clears reauthNeeded
  const relogin = await fetch(paired.dashboard, { redirect: 'manual' });
  assert.equal(relogin.status, 303);
  assert.equal((await pairStatus()).reauthNeeded, undefined);
});

test('browserUI.refreshCookie slides Max-Age periodically during long-running /ui activity', async () => {
  const token = 'b'.repeat(64);
  const ui = browserUI({ config: { routes: [] }, store: { quota: () => null } }, { directory: '.', token }, { refreshIntervalMs: 1 });
  const cookieSecret = createHmac('sha256', Buffer.from(token, 'hex')).update('cli-agent-pool-browser-cookie-v1').digest();
  const sessionId = '1'.repeat(32);
  const mac = createHmac('sha256', cookieSecret).update(`43127:v2:${sessionId}`).digest('hex');
  const req = { headers: { cookie: `pool_43127=v2.${sessionId}.${mac}` } };

  const first = ui.refreshCookie(req, 43127);
  assert.match(first || '', /Max-Age=31536000/);
  await new Promise(resolve => setTimeout(resolve, 10));
  const second = ui.refreshCookie(req, 43127);
  assert.match(second || '', /Max-Age=31536000/);
});
