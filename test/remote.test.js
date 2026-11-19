import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { encodeQrMatrix, qrSvg } from '../remote/qr.js';
import { buildCompactPrompt, RemoteStore } from '../remote/store.js';
import { createRemoteServer, detectTailscaleIp, listDirectoriesSafe } from '../remote/server.js';
import { windowsConsoleHostStatus, applyWindowsConsoleHostFix } from '../src/daemon.js';
import { buildArguments } from '../src/adapters.js';

function makeTempDir(prefix = 'pool-remote-test-') {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

test('qr.js encodes pairing URLs into valid square QR matrix and SVG', () => {
  const url = 'http://100.88.12.34:43128/?pair=0123456789abcdef0123456789abcdef';
  const matrix = encodeQrMatrix(url);
  assert.ok(Array.isArray(matrix) && matrix.length >= 29);
  assert.equal(matrix.length, matrix[0].length);
  // Top-left 7x7 finder pattern corners are dark
  assert.equal(matrix[0][0], 1);
  assert.equal(matrix[0][6], 1);
  assert.equal(matrix[6][0], 1);
  assert.equal(matrix[6][6], 1);

  const svg = qrSvg(url);
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /<path d="M/);
  assert.match(svg, /<\/svg>$/);
});

test('RemoteStore manages device cookies, revocation, folders, and compact context', () => {
  const dir = makeTempDir();
  try {
    const store = new RemoteStore(dir);
    const paired = store.pairDevice('Pixel 9');
    assert.ok(paired.cookieValue.includes('.'));
    const verified = store.verifyCookie(paired.cookieValue);
    assert.equal(verified?.id, paired.id);
    assert.equal(verified?.label, 'Pixel 9');

    // Tampered cookie rejected
    assert.equal(store.verifyCookie(`${paired.cookieValue}x`), null);

    // Revocation invalidates cookie immediately
    assert.equal(store.revokeDevice(paired.id), true);
    assert.equal(store.verifyCookie(paired.cookieValue), null);

    // Folders
    store.toggleFavoriteFolder('/repo/alpha');
    assert.deepEqual(store.state.favoriteFolders, ['/repo/alpha']);
    store.toggleFavoriteFolder('/repo/alpha');
    assert.deepEqual(store.state.favoriteFolders, []);

    // Chats + buildCompactPrompt
    const chat = store.createChat({ title: 'Test', workspace: dir });
    for (let i = 1; i <= 5; i++) {
      store.appendMessage(chat.id, { role: 'user', text: `Soru ${i}: uzun detay ${'x'.repeat(200)}` });
      store.appendMessage(chat.id, {
        role: 'assistant',
        taskId: `t-${i}`,
        state: 'succeeded',
        result: `Yanıt ${i}: özet sonuç ${'y'.repeat(200)}`,
        report: { summary: `Rapor ${i}`, files: [{ path: `src/file${i}.js`, status: 'M' }] },
      });
    }
    const fresh = store.getChat(chat.id);
    assert.equal(buildCompactPrompt(fresh, 'Yeni görev', false), 'Yeni görev');

    const withContext = buildCompactPrompt(fresh, 'Yeni görev', true);
    assert.ok(withContext.includes('[Önceki konuşma özeti'));
    assert.ok(withContext.includes('Soru 5'));
    assert.ok(!withContext.includes('Soru 1')); // Sliding window keeps only last 3 turns
    assert.ok(withContext.includes('src/file5.js'));
    assert.ok(withContext.endsWith('[Güncel istek]\nYeni görev'));
    assert.ok(withContext.length <= 3400);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('detectTailscaleIp and listDirectoriesSafe enforce network and workspace boundaries', () => {
  assert.equal(detectTailscaleIp({
    lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    eth0: [{ address: '192.168.1.50', family: 'IPv4', internal: false }],
    Tailscale: [{ address: '100.101.42.7', family: 'IPv4', internal: false }],
  }), '100.101.42.7');

  assert.equal(detectTailscaleIp({
    eth0: [{ address: '100.63.1.1', family: 'IPv4', internal: false }],
  }), null);

  const root = makeTempDir('pool-ws-root-');
  const outside = makeTempDir('pool-ws-out-');
  try {
    const repoA = path.join(root, 'repo-a');
    mkdirSync(path.join(repoA, '.git'), { recursive: true });
    mkdirSync(path.join(root, 'plain-dir'), { recursive: true });

    const top = listDirectoriesSafe('', [root]);
    assert.equal(top.restricted, true);
    assert.equal(top.entries.length, 1);

    const inside = listDirectoriesSafe(root, [root]);
    assert.equal(inside.entries[0].name, 'repo-a');
    assert.equal(inside.entries[0].isGit, true);
    assert.equal(inside.entries[1].name, 'plain-dir');
    assert.equal(inside.entries[1].isGit, false);

    assert.throws(
      () => listDirectoriesSafe(outside, [root]),
      err => err?.code === 'WORKSPACE_DENIED',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('Remote server enforces one-time pairing, cookie auth, chat send, SSE streaming, lifecycle, and revocation', async () => {
  const dir = makeTempDir('pool-remote-srv-');
  const workspace = makeTempDir('pool-remote-ws-');
  mkdirSync(path.join(workspace, '.git'), { recursive: true });

  const submittedPayloads = [];
  let taskPollCount = 0;
  let poolRunning = true;

  const mockPool = {
    getConfig: () => ({ port: 43127, workspaceRoots: [workspace] }),
    health: async () => poolRunning
      ? { status: 'ok', version: '2.20.0', connections: 1, models: 2, active: 0 }
      : { status: 'stopped', version: null, connections: 0, models: 0, active: 0 },
    pools: async () => ({ categories: [{ id: 'high', label: 'Yüksek', count: 1 }] }),
    poolModels: async group => ({
      category: { id: group, label: 'Yüksek' },
      models: [{
        routeId: 'codex-local',
        modelId: 'gpt-5.4',
        name: 'GPT-5.4',
        category: group,
        effort: 'high',
        efforts: ['low', 'medium', 'high'],
        kinds: ['text', 'read', 'write'],
        billing: 'subscription',
        quota: { status: 'ok', remainingPercent: 85 },
      }],
    }),
    catalogModels: async () => [{
      routeId: 'codex-local',
      modelId: 'gpt-5.4',
      name: 'GPT-5.4',
      categories: ['high'],
      effort: 'high',
      efforts: ['low', 'medium', 'high'],
      kinds: ['text', 'read', 'write'],
      billing: 'subscription',
      quota: { status: 'ok', remainingPercent: 85 },
    }],
    quotas: async () => ({ total: 1, connections: [{ routeId: 'codex-local', adapter: 'codex', billing: 'subscription', models: 1, status: 'ok', remainingPercent: 85 }] }),
    connections: async () => [{ id: 'codex-local', adapter: 'codex', billing: 'subscription' }],
    tasks: async () => ({ tasks: [] }),
    task: async id => {
      taskPollCount++;
      if (taskPollCount === 1) {
        return {
          id,
          state: 'running',
          updated: '2026-11-19T10:00:01Z',
          routeId: 'codex-local',
          modelId: 'gpt-5.4',
          events: [{ type: 'step', message: 'Dosyalar okunuyor' }],
          result: '',
        };
      }
      return {
        id,
        state: 'succeeded',
        updated: '2026-11-19T10:00:02Z',
        routeId: 'codex-local',
        modelId: 'gpt-5.4',
        reportedModel: 'gpt-5.4',
        events: [{ type: 'step', message: 'Tamamlandı' }],
        result: 'Test yanıtı hazır.',
        report: { summary: 'Özet tamam', files: [{ path: 'README.md', status: 'M' }] },
      };
    },
    submit: async payload => {
      submittedPayloads.push(payload);
      return {
        id: '11111111-1111-4111-8111-111111111111',
        state: 'queued',
        routeId: payload.routeId || 'codex-local',
        modelId: payload.modelId || 'gpt-5.4',
        group: payload.group || 'high',
        effort: payload.effort || 'high',
      };
    },
    cancel: async id => ({ id, state: 'cancelled' }),
    startPool: async () => { poolRunning = true; return { started: true }; },
    stopPool: async () => { poolRunning = false; return { stopped: true }; },
    restartPool: async () => ({ restarted: true, scheduled: true }),
    liveQuota: async () => ({ status: 'ok' }),
  };

  const remote = createRemoteServer({ directory: dir, port: 0, host: '127.0.0.1', poolBridge: mockPool });
  try {
    const info = await remote.listen();
    const base = `http://127.0.0.1:${info.port}`;

    // Public manifest & icon work without auth
    const manifestRes = await fetch(`${base}/manifest.webmanifest`);
    assert.equal(manifestRes.status, 200);
    const iconRes = await fetch(`${base}/icon.svg`);
    assert.equal(iconRes.status, 200);

    // Unauthenticated API and root rejected
    assert.equal((await fetch(`${base}/r/state`)).status, 401);
    assert.equal((await fetch(`${base}/`)).status, 401);

    // Prefetch / HEAD preview must NOT consume the single-use pairing code
    assert.equal((await fetch(info.localUrl, { method: 'HEAD' })).status, 204);
    assert.equal((await fetch(info.localUrl, { headers: { 'Sec-Purpose': 'prefetch' } })).status, 204);

    // GET /?pair=<code> serves handoff page without burning the code yet
    const handoffRes = await fetch(info.localUrl);
    assert.equal(handoffRes.status, 200);
    assert.match(await handoffRes.text(), /\/r\/redeem/);

    // Same-origin POST /r/redeem commits HttpOnly SameSite=Lax cookie and burns the code
    const initialCode = new URL(info.localUrl).searchParams.get('pair');
    const pairRes = await fetch(`${base}/r/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: initialCode }),
    });
    assert.equal(pairRes.status, 200);
    const setCookie = pairRes.headers.get('set-cookie') || '';
    assert.match(setCookie, /pool_remote=/);
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Lax/i);
    const cookieHeader = setCookie.split(';')[0];

    // Replaying the same one-time pairing link/code without cookie fails with 401
    assert.equal((await fetch(info.localUrl)).status, 401);
    assert.equal((await fetch(`${base}/r/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: initialCode }),
    })).status, 401);

    // Reloading the QR URL with an already-paired cookie redirects cleanly to /
    const authedQrReload = await fetch(info.localUrl, { headers: { Cookie: cookieHeader }, redirect: 'manual' });
    assert.equal(authedQrReload.status, 303);
    assert.equal(authedQrReload.headers.get('location'), '/');

    // Authenticated GET / and /r/state succeed
    const htmlRes = await fetch(`${base}/`, { headers: { Cookie: cookieHeader } });
    assert.equal(htmlRes.status, 200);
    assert.match(await htmlRes.text(), /CLI Agent Remote/);

    const stateRes = await fetch(`${base}/r/state`, { headers: { Cookie: cookieHeader } });
    assert.equal(stateRes.status, 200);
    const snapshot = await stateRes.json();
    assert.equal(snapshot.poolHealth.status, 'ok');
    assert.equal(snapshot.pools[0].id, 'high');
    assert.equal(snapshot.pools[0].models[0].modelId, 'gpt-5.4');
    assert.equal(snapshot.devices.length, 1);

    // Create chat and send prompt
    const chatRes = await fetch(`${base}/r/chats`, {
      method: 'POST',
      headers: { Cookie: cookieHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace }),
    });
    assert.equal(chatRes.status, 201);
    const { chat } = await chatRes.json();

    const sendRes = await fetch(`${base}/r/chats/${chat.id}/send`, {
      method: 'POST',
      headers: { Cookie: cookieHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: 'Projeyi incele',
        workspace,
        kind: 'read',
        group: 'high',
        routeId: 'codex-local',
        modelId: 'gpt-5.4',
        effort: 'high',
      }),
    });
    assert.equal(sendRes.status, 200);
    const sent = await sendRes.json();
    assert.equal(sent.task.id, '11111111-1111-4111-8111-111111111111');
    assert.equal(submittedPayloads[0].effort, 'high');

    // SSE stream pushes update + done and persists result into store
    const sseRes = await fetch(`${base}/r/stream?taskId=${sent.task.id}&chatId=${chat.id}`, {
      headers: { Cookie: cookieHeader },
    });
    assert.equal(sseRes.status, 200);
    const sseText = await sseRes.text();
    assert.match(sseText, /event: update/);
    assert.match(sseText, /event: done/);
    assert.match(sseText, /Test yanıtı hazır\./);

    const persistedChat = remote.store.getChat(chat.id);
    const assistantMsg = persistedChat.messages.find(m => m.role === 'assistant');
    assert.equal(assistantMsg.state, 'succeeded');
    assert.equal(assistantMsg.result, 'Test yanıtı hazır.');

    // Lifecycle controls
    assert.equal((await fetch(`${base}/r/pool/stop`, {
      method: 'POST',
      headers: { Cookie: cookieHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ force: false }),
    })).status, 200);
    assert.equal(poolRunning, false);

    assert.equal((await fetch(`${base}/r/pool/start`, {
      method: 'POST',
      headers: { Cookie: cookieHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })).status, 200);
    assert.equal(poolRunning, true);

    // Pair second device via QR endpoint & revoke it
    const qrRes = await fetch(`${base}/r/pair`, {
      method: 'POST',
      headers: { Cookie: cookieHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'Telefonum', useTailscale: false }),
    });
    assert.equal(qrRes.status, 200);
    const qrData = await qrRes.json();
    assert.match(qrData.qrSvg, /^<svg /);
    assert.match(qrData.url, /\?pair=/);

    const secondCode = new URL(qrData.url).searchParams.get('pair');
    const secondPair = await fetch(`${base}/r/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: secondCode }),
    });
    assert.equal(secondPair.status, 200);
    const secondCookie = (secondPair.headers.get('set-cookie') || '').split(';')[0];

    const devicesData = await (await fetch(`${base}/r/devices`, { headers: { Cookie: cookieHeader } })).json();
    assert.equal(devicesData.devices.length, 2);
    const otherDevice = devicesData.devices.find(d => d.id !== devicesData.currentDeviceId);

    await fetch(`${base}/r/devices/revoke`, {
      method: 'POST',
      headers: { Cookie: cookieHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: otherDevice.id }),
    });
    assert.equal((await fetch(`${base}/r/state`, { headers: { Cookie: secondCookie } })).status, 401);
  } finally {
    await remote.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('Remote PWA frontend follows modern web guidance & safe DOM rules', () => {
  const html = readFileSync(path.resolve('remote/public/index.html'), 'utf8');
  const css = readFileSync(path.resolve('remote/public/style.css'), 'utf8');
  const js = readFileSync(path.resolve('remote/public/app.js'), 'utf8');

  // Dark default + FOUC prevention + light-dark() tokens
  assert.match(html, /<meta name="color-scheme" content="dark">/);
  assert.match(css, /&:has\(> head > meta\[name="color-scheme"\]\[content="dark"\]\)/);
  assert.match(css, /light-dark\(/);

  // Native light-dismiss dialogs + Safari fallback
  assert.match(html, /<dialog[^>]+closedby="any"/);
  assert.match(js, /'closedBy' in HTMLDialogElement\.prototype/);

  // Auto-sizing textarea
  assert.match(css, /field-sizing:\s*content/);

  // IME-safe Enter submit
  assert.match(js, /event\.isComposing\s*\|\|\s*event\.keyCode === 229/);
  assert.match(js, /requestSubmit\(\)/);

  // Zero innerHTML in app.js (prevents XSS from untrusted model/task text)
  assert.doesNotMatch(js, /\.innerHTML\s*=/);
});

test('Remote /r/manage issues fresh local pairing URLs, rejects bad auth/origin, and stops cleanly', async () => {
  const dir = makeTempDir('pool-remote-mgmt-');
  const mgmtToken = 'a'.repeat(64);
  const remote = createRemoteServer({
    directory: dir,
    port: 0,
    host: '127.0.0.1',
    managementToken: mgmtToken,
    poolBridge: {
      getConfig: () => ({ port: 43127, workspaceRoots: [] }),
      health: async () => ({ status: 'stopped', version: null, connections: 0, models: 0, active: 0 }),
    },
  });
  try {
    const info = await remote.listen();
    const base = `http://127.0.0.1:${info.port}`;

    // Missing token -> 401
    assert.equal((await fetch(`${base}/r/manage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation: 'pair_local' }),
    })).status, 401);

    // Browser Origin header -> 403
    assert.equal((await fetch(`${base}/r/manage`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${mgmtToken}`, Origin: 'http://evil.example', 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation: 'pair_local' }),
    })).status, 403);

    // Valid pair_local -> fresh single-use pairing URL
    const pairRes = await fetch(`${base}/r/manage`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${mgmtToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation: 'pair_local' }),
    });
    assert.equal(pairRes.status, 200);
    const pairData = await pairRes.json();
    assert.match(pairData.dashboard, /^http:\/\/127\.0\.0\.1:\d+\/\?pair=[a-f0-9]+$/);
    assert.equal((await fetch(pairData.dashboard)).status, 200);
    const mgmtCode = new URL(pairData.dashboard).searchParams.get('pair');
    const redeem = await fetch(`${base}/r/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: mgmtCode }),
    });
    assert.equal(redeem.status, 200);
    assert.match(redeem.headers.get('set-cookie') || '', /pool_remote=/);

    // Shutdown operation succeeds
    const stopRes = await fetch(`${base}/r/manage`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${mgmtToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation: 'shutdown' }),
    });
    assert.equal(stopRes.status, 200);
    assert.equal((await stopRes.json()).stopped, true);
  } finally {
    await remote.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('windowsConsoleHostStatus and applyWindowsConsoleHostFix detect and write Console Host GUID', async () => {
  const before = await windowsConsoleHostStatus('python', {
    platform: 'win32',
    runCapture: async () => ({ code: 0, output: '' }),
  });
  assert.equal(before.needsFix, true);
  assert.equal(before.fixed, false);

  const after = await windowsConsoleHostStatus('python', {
    platform: 'win32',
    runCapture: async () => ({
      code: 0,
      output: '    DelegationConsole    REG_SZ    {B23D10C0-E52E-411E-9D5B-209FDF7094FF}\r\n    DelegationTerminal    REG_SZ    {B23D10C0-E52E-411E-9D5B-209FDF7094FF}\r\n',
    }),
  });
  assert.equal(after.needsFix, false);
  assert.equal(after.fixed, true);

  const calls = [];
  const applied = await applyWindowsConsoleHostFix('python', {
    platform: 'win32',
    runCapture: async argv => { calls.push(argv); return { code: 0, output: '' }; },
  });
  assert.equal(applied.applied, true);
  assert.equal(calls.length, 2);
  assert.ok(calls[0].includes('DelegationConsole'));
  assert.ok(calls[1].includes('DelegationTerminal'));

  const cs = readFileSync(path.resolve('src/dashboard.cs'), 'utf8');
  assert.match(cs, /remote-browser/);
  assert.match(cs, /remote-ensure/);
  const poolHtml = readFileSync(path.resolve('web/index.html'), 'utf8');
  assert.match(poolHtml, /id="open-remote"/);
  assert.match(poolHtml, /id="console-fix-banner"/);
});

test('effort "default" is never passed to Codex CLI or forwarded by Remote, and projectless chat works without a folder', async () => {
  // Core adapter test: Codex must omit model_reasoning_effort when effort is "default"
  const codexArgs = buildArguments(
    { id: 'codex-acc2', adapter: 'codex', executable: process.execPath },
    { id: 'gpt-6.2-astra' },
    { workspace: process.cwd(), kind: 'text', mode: 'response', effort: 'default', prompt: 'merhaba' },
  );
  assert.equal(codexArgs.some(a => a.includes('model_reasoning_effort')), false);

  const codexHighArgs = buildArguments(
    { id: 'codex-acc2', adapter: 'codex', executable: process.execPath },
    { id: 'gpt-6.2-astra' },
    { workspace: process.cwd(), kind: 'text', mode: 'response', effort: 'high', prompt: 'merhaba' },
  );
  assert.ok(codexHighArgs.some(a => a.includes('model_reasoning_effort="high"')));

  // Remote server test: projectless chat, stripped effort "default", alphabetical pool models + 5s/7g quotaWindows, shared folders
  const dir = makeTempDir('pool-remote-v222-');
  const sharedDir = makeTempDir('pool-remote-shared-');
  const submitted = [];
  const remote = createRemoteServer({
    directory: dir,
    port: 0,
    host: '127.0.0.1',
    poolBridge: {
      getConfig: () => ({ port: 43127, workspaceRoots: [] }),
      health: async () => ({ status: 'ok', version: '2.22.0', connections: 1, models: 2, active: 0 }),
      pools: async () => ({ categories: [{ id: 'high', label: 'Yüksek', count: 2 }] }),
      poolModels: async () => ({
        models: [
          { routeId: 'codex-acc2', modelId: 'z-model', name: 'Zeta Model', effort: 'default', efforts: ['default', 'low', 'high'], kinds: ['text', 'read', 'write'], billing: 'subscription', quota: { status: 'ok', remainingPercent: 80 } },
          { routeId: 'codex-acc2', modelId: 'a-model', name: 'Alpha Model', effort: 'high', efforts: ['low', 'high'], kinds: ['text', 'read', 'write'], billing: 'subscription', quota: { status: 'ok', remainingPercent: 90 } },
        ],
      }),
      catalogModels: async () => [],
      quotas: async () => ({ connections: [{ routeId: 'codex-acc2', adapter: 'codex', billing: 'subscription', models: 2, status: 'ok', remainingPercent: 80 }] }),
      routeQuota: async () => ({
        connections: [{
          routeId: 'codex-acc2',
          windows: [
            { name: '5h', remainingPercent: 92, resetsAt: null },
            { name: 'weekly', remainingPercent: 80, resetsAt: null },
          ],
        }],
      }),
      connections: async () => [{ id: 'codex-acc2', adapter: 'codex' }],
      tasks: async () => ({ tasks: [] }),
      submit: async payload => {
        submitted.push(payload);
        return { id: '22222222-2222-4222-8222-222222222222', state: 'queued', routeId: 'codex-acc2', modelId: payload.modelId || 'a-model' };
      },
    },
  });

  try {
    const info = await remote.listen();
    const base = `http://127.0.0.1:${info.port}`;
    const code = new URL(info.localUrl).searchParams.get('pair');
    const redeem = await fetch(`${base}/r/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    const cookie = (redeem.headers.get('set-cookie') || '').split(';')[0];

    // Check alphabetical sorting + stripped "default" effort + 5s/7g quotaWindows
    const stateData = await (await fetch(`${base}/r/state`, { headers: { Cookie: cookie } })).json();
    const poolModels = stateData.pools[0].models;
    assert.equal(poolModels[0].name, 'Alpha Model');
    assert.equal(poolModels[1].name, 'Zeta Model');
    assert.equal(poolModels[1].effort, '');
    assert.deepEqual(poolModels[1].efforts, ['low', 'high']);
    assert.deepEqual(poolModels[0].quotaWindows.map(w => `${w.label}:${w.remainingPercent}`), ['5s:92', '7g:80']);

    // Shared folders add & remove
    const addRes = await fetch(`${base}/r/folders/shared`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'add', path: sharedDir }),
    });
    assert.equal(addRes.status, 200);
    assert.equal((await addRes.json()).sharedFolders.length, 1);

    // Projectless chat (workspace = "") succeeds as text/response and never sends effort: "default"
    const { chat } = await (await fetch(`${base}/r/chats`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace: '' }),
    })).json();
    const sendRes = await fetch(`${base}/r/chats/${chat.id}/send`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'Selam nasılsın?', workspace: '', modelId: 'z-model', effort: 'default' }),
    });
    assert.equal(sendRes.status, 200);
    assert.equal(submitted[0].kind, 'text');
    assert.equal(submitted[0].mode, 'response');
    assert.equal('effort' in submitted[0], false);

    // UI contract checks for v2.22.0 layout
    const html = readFileSync(path.resolve('remote/public/index.html'), 'utf8');
    const js = readFileSync(path.resolve('remote/public/app.js'), 'utf8');
    assert.doesNotMatch(html, /data-kind="read"/); // Old 3-way Sohbet/Analiz/Kod Yaz removed
    assert.match(html, /id="picker-view-quotas-btn"/);
    assert.match(html, /data-view="chats"/);
    assert.match(html, /id="topbar-settings-btn"/);
    assert.match(js, /ev\.kind/);
    assert.match(js, /ev\.detail/);
  } finally {
    await remote.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(sharedDir, { recursive: true, force: true });
  }
});

test('v2.23.0: pool membership add/remove, call delete/clear, document attachments, safe /r/file, tool/email metadata & UI contracts', async () => {
  const dir = makeTempDir('pool-remote-v223-');
  const ws = makeTempDir('pool-remote-docws-');
  const outside = makeTempDir('pool-remote-outside-');
  writeFileSync(path.join(ws, 'report.md'), '# Rapor\nHer şey yolunda.', 'utf8');
  writeFileSync(path.join(outside, 'secret.txt'), 'nope', 'utf8');

  let savedConfig = null;
  let cleared = false;
  let deletedTaskId = null;
  const submitted = [];

  const mockConfig = {
    port: 43127,
    workspaceRoots: [],
    categories: [{ id: 'high', label: 'Yüksek' }, { id: 'low', label: 'Hafif' }],
    routes: [{
      id: 'codex-acc2',
      adapter: 'codex',
      enabled: true,
      models: [{ id: 'gpt-6', alias: 'GPT-6', group: 'high', memberships: [{ group: 'high' }], enabled: true }],
    }],
  };

  const remote = createRemoteServer({
    directory: dir,
    port: 0,
    host: '127.0.0.1',
    poolBridge: {
      getConfig: () => mockConfig,
      health: async () => ({ status: 'ok', version: '2.23.0', connections: 1, models: 1, active: 0 }),
      pools: async () => ({ categories: mockConfig.categories }),
      poolModels: async () => ({ models: [{ routeId: 'codex-acc2', modelId: 'gpt-6', name: 'GPT-6', efforts: ['low', 'high'], kinds: ['text', 'read', 'write'], billing: 'subscription', quota: { status: 'ok', remainingPercent: 88 } }] }),
      catalogModels: async () => [{ routeId: 'codex-acc2', modelId: 'gpt-6', name: 'GPT-6', categories: ['high'], efforts: ['low', 'high'], kinds: ['text', 'read', 'write'], billing: 'subscription', quota: { status: 'ok', remainingPercent: 88 } }],
      quotas: async () => ({ connections: [{ routeId: 'codex-acc2', adapter: 'codex', email: 'dev@example.com', billing: 'subscription', models: 1, status: 'ok', remainingPercent: 88 }] }),
      routeQuota: async () => ({ connections: [{ routeId: 'codex-acc2', windows: [{ name: '5h', remainingPercent: 95 }, { name: 'weekly', remainingPercent: 88 }] }] }),
      connections: async () => [{ id: 'codex-acc2', adapter: 'codex', email: 'dev@example.com', account: 'acc2', billing: 'subscription' }],
      tasks: async () => ({ tasks: [{ id: '33333333-3333-4333-8333-333333333333', routeId: 'codex-acc2', modelId: 'gpt-6', state: 'succeeded' }] }),
      submit: async payload => {
        submitted.push(payload);
        return { id: '44444444-4444-4444-8444-444444444444', state: 'queued', routeId: 'codex-acc2', modelId: 'gpt-6' };
      },
      manageGet: async () => ({ config: mockConfig, revision: 1 }),
      manageSave: async cfg => { savedConfig = cfg; return { config: cfg, revision: 2 }; },
      clearHistory: async () => { cleared = true; return { removed: 1 }; },
      deleteTask: async id => { deletedTaskId = id; return { removed: 1 }; },
    },
  });

  try {
    const info = await remote.listen();
    const base = `http://127.0.0.1:${info.port}`;
    const code = new URL(info.localUrl).searchParams.get('pair');
    const redeem = await fetch(`${base}/r/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    const cookie = (redeem.headers.get('set-cookie') || '').split(';')[0];

    // State carries toolLabel & email on models and tasks
    const st = await (await fetch(`${base}/r/state`, { headers: { Cookie: cookie } })).json();
    assert.equal(st.models[0].toolLabel, 'Codex');
    assert.equal(st.models[0].email, 'dev@example.com');
    assert.equal(st.tasks[0].toolLabel, 'Codex');
    assert.equal(st.tasks[0].email, 'dev@example.com');

    // Pool membership add & remove
    const addMem = await fetch(`${base}/r/pool/membership`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ routeId: 'codex-acc2', modelId: 'gpt-6', group: 'low', action: 'add' }),
    });
    assert.equal(addMem.status, 200);
    assert.ok(savedConfig.routes[0].models[0].memberships.some(m => m.group === 'low'));

    // Clear & delete calls
    assert.equal((await fetch(`${base}/r/tasks/33333333-3333-4333-8333-333333333333`, { method: 'DELETE', headers: { Cookie: cookie } })).status, 200);
    assert.equal(deletedTaskId, '33333333-3333-4333-8333-333333333333');
    assert.equal((await fetch(`${base}/r/tasks/clear`, { method: 'POST', headers: { Cookie: cookie } })).status, 200);
    assert.equal(cleared, true);

    // Document attachment in chat send + toolLabel/email persisted on assistant message
    const { chat } = await (await fetch(`${base}/r/chats`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace: ws }),
    })).json();
    const sendRes = await fetch(`${base}/r/chats/${chat.id}/send`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: 'Bu belgeyi özetle',
        workspace: ws,
        attachments: [{ name: 'spec.md', content: '# Mimari\nÖrnek içerik.' }],
      }),
    });
    assert.equal(sendRes.status, 200);
    const sendData = await sendRes.json();
    assert.match(submitted[0].prompt, /\[Eklenen Doküman: spec\.md\]/);
    assert.equal(sendData.assistantMessage.toolLabel, 'Codex');
    assert.equal(sendData.assistantMessage.email, 'dev@example.com');
    assert.equal(sendData.userMessage.attachments[0].name, 'spec.md');

    // Adding a new shared folder outside existing workspaceRoots succeeds and syncs Pool workspaceRoots
    const addRootRes = await fetch(`${base}/r/folders/shared`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'add', path: outside }),
    });
    assert.equal(addRootRes.status, 200);
    assert.ok(savedConfig.workspaceRoots.includes(outside));

    // Safe workspace file read succeeds inside workspace and blocks outside traversal
    const fileOk = await fetch(`${base}/r/file?workspace=${encodeURIComponent(ws)}&file=report.md`, { headers: { Cookie: cookie } });
    assert.equal(fileOk.status, 200);
    assert.match((await fileOk.json()).content, /Her şey yolunda/);

    const fileEscape = await fetch(`${base}/r/file?workspace=${encodeURIComponent(ws)}&file=${encodeURIComponent(path.join(outside, 'secret.txt'))}`, { headers: { Cookie: cookie } });
    assert.equal(fileEscape.status, 403);

    // UI contract checks for v2.23.0
    const html = readFileSync(path.resolve('remote/public/index.html'), 'utf8');
    const js = readFileSync(path.resolve('remote/public/app.js'), 'utf8');
    assert.match(html, /id="picker-selected-summary"/);
    assert.match(html, /id="quotas-dialog"/);
    assert.match(html, /id="doc-dialog"/);
    assert.match(html, /id="topbar-back-btn"/);
    assert.match(html, /id="attach-doc-btn"/);
    assert.match(html, /id="clear-calls-btn"/);
    assert.match(html, /id="add-shared-folder-btn"/);
    assert.doesNotMatch(html, /id="clear-folder-btn"/);
    assert.doesNotMatch(html, /id="folder-chips"/);
    assert.match(html, /data-pool-subtab="catalog"/);
    assert.match(js, /remote-collapsed-pools/);
    assert.doesNotMatch(js, /\.innerHTML\s*=/);
  } finally {
    await remote.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('v2.25.0: project chat runs write without forced execute JSON protocol, no edit-mode toggle, isolated projectless sandbox', async () => {
  const dir = makeTempDir('pool-remote-v225-');
  const ws = makeTempDir('pool-remote-proj-');
  const submitted = [];

  const remote = createRemoteServer({
    directory: dir,
    port: 0,
    host: '127.0.0.1',
    poolBridge: {
      getConfig: () => ({ port: 43127, workspaceRoots: [ws] }),
      health: async () => ({ status: 'ok', version: '2.25.0', connections: 1, models: 1, active: 0 }),
      pools: async () => ({ categories: [{ id: 'low', label: 'Hafif' }] }),
      poolModels: async () => ({ models: [{ routeId: 'opencode-local', modelId: 'mimo-free', name: 'MiMo Free', efforts: [], kinds: ['text', 'read', 'write'], billing: 'free' }] }),
      catalogModels: async () => [{ routeId: 'opencode-local', modelId: 'mimo-free', name: 'MiMo Free', categories: ['low'], efforts: [], kinds: ['text', 'read', 'write'], billing: 'free' }],
      quotas: async () => ({ connections: [] }),
      routeQuota: async () => ({ connections: [] }),
      connections: async () => [{ id: 'opencode-local', adapter: 'opencode', billing: 'free' }],
      tasks: async () => ({ tasks: [] }),
      task: async id => ({ id, state: 'succeeded', workspace: ws, events: [] }),
      submit: async payload => {
        submitted.push(payload);
        return {
          id: '66666666-6666-4666-8666-666666666666',
          state: 'starting',
          routeId: 'opencode-local',
          modelId: 'mimo-free',
        };
      },
    },
  });

  try {
    const info = await remote.listen();
    const base = `http://127.0.0.1:${info.port}`;
    const code = new URL(info.localUrl).searchParams.get('pair');
    const redeem = await fetch(`${base}/r/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    const cookie = (redeem.headers.get('set-cookie') || '').split(';')[0];

    // 1. Project chat uses kind=write WITHOUT forced mode=execute (natural chat + full tools, no WORK_INCOMPLETE)
    const { chat } = await (await fetch(`${base}/r/chats`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace: ws }),
    })).json();
    const projSend = await fetch(`${base}/r/chats/${chat.id}/send`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'slm', workspace: ws }),
    });
    assert.equal(projSend.status, 200);
    assert.equal(submitted[0].kind, 'write');
    assert.equal('mode' in submitted[0], false);

    // 2. Projectless chat ALWAYS uses isolated remote-chat-sandbox even when workspaceRoots is non-empty
    const { chat: freeChat } = await (await fetch(`${base}/r/chats`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace: '' }),
    })).json();
    await fetch(`${base}/r/chats/${freeChat.id}/send`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'Merhaba', workspace: '' }),
    });
    assert.equal(submitted[1].kind, 'text');
    assert.equal(submitted[1].mode, 'response');
    assert.ok(submitted[1].workspace.endsWith('remote-chat-sandbox'));
    assert.notEqual(submitted[1].workspace, ws);

    // 3. UI & cookie contract checks: no edit-mode toggle, no spinning send arrow, 1-year session cookie
    assert.match(redeem.headers.get('set-cookie') || '', /Max-Age=31536000/);
    const html = readFileSync(path.resolve('remote/public/index.html'), 'utf8');
    const js = readFileSync(path.resolve('remote/public/app.js'), 'utf8');
    const css = readFileSync(path.resolve('remote/public/style.css'), 'utf8');
    assert.doesNotMatch(html, /id="edit-mode-toggle-btn"/);
    assert.doesNotMatch(css, /\.send-btn\.sending\s+svg/);
    assert.match(js, /isRawReportJson/);
    assert.match(readFileSync(path.resolve('src/folder-picker.cs'), 'utf8'), /CenterScreen/);
    assert.match(readFileSync(path.resolve('src/folder-picker.cs'), 'utf8'), /AttachThreadInput/);
    const dashCs = readFileSync(path.resolve('src/dashboard.cs'), 'utf8');
    assert.match(dashCs, /AttachThreadInput/);
    assert.match(dashCs, /GetWindowTextLength/);

    // 4. Dynamic Tailscale detection: starts with Tailscale OFF, then connects later -> POST /r/pair auto-detects & binds it
    let simulatedTs = null;
    const dynDir = makeTempDir('pool-remote-dynts-');
    const dynRemote = createRemoteServer({
      directory: dynDir,
      port: 0,
      host: 'tailscale',
      detectTailscale: () => simulatedTs,
      poolBridge: {
        getConfig: () => ({ port: 43127, workspaceRoots: [] }),
        health: async () => ({ status: 'ok', version: '2.25.2', connections: 0, models: 0, active: 0 }),
        pools: async () => ({ categories: [] }),
        poolModels: async () => ({ models: [] }),
        catalogModels: async () => [],
        quotas: async () => ({ connections: [] }),
        connections: async () => [],
        tasks: async () => ({ tasks: [] }),
      },
    });
    try {
      const dynInfo = await dynRemote.listen();
      assert.equal(dynInfo.tailscaleIp, null);
      const dynCode = new URL(dynInfo.localUrl).searchParams.get('pair');
      const dynRedeem = await fetch(`http://127.0.0.1:${dynInfo.port}/r/redeem`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: dynCode }),
      });
      const dynCookie = (dynRedeem.headers.get('set-cookie') || '').split(';')[0];
      const beforePair = await (await fetch(`http://127.0.0.1:${dynInfo.port}/r/pair`, {
        method: 'POST',
        headers: { Cookie: dynCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: 'Telefon', useTailscale: true }),
      })).json();
      assert.equal(beforePair.tailscaleIp, null);
      assert.match(beforePair.url, /^http:\/\/127\.0\.0\.1:/);

      // Now simulate Tailscale connecting (use 127.0.0.2 loopback alias so listen succeeds deterministically on any machine)
      simulatedTs = '127.0.0.2';
      const afterPair = await (await fetch(`http://127.0.0.1:${dynInfo.port}/r/pair`, {
        method: 'POST',
        headers: { Cookie: dynCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: 'Telefon', useTailscale: true }),
      })).json();
      assert.equal(afterPair.tailscaleIp, '127.0.0.2');
      assert.match(afterPair.url, /^http:\/\/127\.0\.0\.2:/);

      // 5. Root directory listing never injects hardcoded C:\repositories or D:\repositories; add & remove shared/favorite works cleanly
      const rootDirs = listDirectoriesSafe('', []);
      assert.equal(rootDirs.entries.some(e => /^[cd]:\\repositories$/i.test(e.path)), false);
      const favAdd = await fetch(`http://127.0.0.1:${dynInfo.port}/r/folders/favorite`, {
        method: 'POST',
        headers: { Cookie: dynCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: ws }),
      });
      assert.equal((await favAdd.json()).favoriteFolders.length, 1);
      const sharedRm = await fetch(`http://127.0.0.1:${dynInfo.port}/r/folders/shared`, {
        method: 'POST',
        headers: { Cookie: dynCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'remove', path: ws.toUpperCase() }),
      });
      const rmData = await sharedRm.json();
      assert.equal(rmData.favoriteFolders.length, 0);
    } finally {
      await dynRemote.close();
      rmSync(dynDir, { recursive: true, force: true });
    }
  } finally {
    await remote.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  }
});
