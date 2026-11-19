import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { encodeQrMatrix, qrSvg } from '../remote/qr.js';
import { buildCompactPrompt, RemoteStore } from '../remote/store.js';
import { createRemoteServer, detectTailscaleIp, listDirectoriesSafe } from '../remote/server.js';

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

    // One-time pairing sets HttpOnly SameSite=Strict cookie
    const pairRes = await fetch(info.localUrl, { redirect: 'manual' });
    assert.equal(pairRes.status, 303);
    const setCookie = pairRes.headers.get('set-cookie') || '';
    assert.match(setCookie, /pool_remote=/);
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Strict/i);
    const cookieHeader = setCookie.split(';')[0];

    // Replaying the same one-time pairing link fails with 401
    const replayRes = await fetch(info.localUrl, { redirect: 'manual' });
    assert.equal(replayRes.status, 401);

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

    const secondPair = await fetch(qrData.url, { redirect: 'manual' });
    assert.equal(secondPair.status, 303);
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
