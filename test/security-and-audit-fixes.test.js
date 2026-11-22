import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { configSchema } from '../src/config.js';
import { Store } from '../src/store.js';
import { Pool, taskSchema } from '../src/pool.js';
import { createServer, poolTools, invokeTool } from '../src/server.js';
import { managementOperation } from '../src/web.js';
import { buildArguments, routeEnvironment, extractSessionId, routeCatalog } from '../src/adapters.js';
import { parseExecutionReport } from '../src/task-protocol.js';
import { TaskWatchdog } from '../src/lifecycle.js';
import { childEnvironment } from '../src/process.js';
import { mirrorAgyPermissions } from '../src/profiles.js';
import { parseOpenCodeGoUsage, antigravityModelWindows, kimiLoggedIn } from '../src/quotas.js';
import { encodeQrMatrix } from '../remote/qr.js';
import { createRemoteServer } from '../remote/server.js';
import { RemoteStore } from '../remote/store.js';
import { settingsViewSignature, quotaWindowPercent, quotaMatches } from '../web/pool-state.js';

function httpRequest(port, method, urlPath, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* non-JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (body != null) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

test('sessionId flag injection is rejected across taskSchema, buildArguments, and extractSessionId', () => {
  const malicious = ['--dangerously-skip-permissions', '-y', '--yolo', '--last', 'abc def', '../escape', '-bad'];
  for (const bad of malicious) {
    const parsed = taskSchema.safeParse({ prompt: 'hi', workspace: process.cwd(), kind: 'text', idempotencyKey: 'key-12345678', sessionId: bad });
    assert.equal(parsed.success, false, `taskSchema should reject ${bad}`);
    assert.equal(extractSessionId('claude', { session_id: bad }), '');
    assert.equal(extractSessionId('codex', { thread_id: bad }), '');
  }
  const route = adapter => ({ id: `${adapter}-1`, adapter, executable: process.execPath, enabled: true, billing: 'subscription', models: [{ id: 'm1', alias: 'M1', kinds: ['text', 'read', 'write'] }] });
  const model = { id: 'm1', alias: 'M1', kinds: ['text', 'read', 'write'] };
  for (const adapter of ['claude', 'codex', 'qwen', 'qoder', 'opencode', 'agy']) {
    assert.throws(
      () => buildArguments(route(adapter), model, { prompt: 'hi', workspace: process.cwd(), kind: 'text', sessionId: '--dangerously-skip-permissions' }),
      { code: 'INVALID_REQUEST' },
      `${adapter} must reject malicious sessionId`,
    );
  }
  const codexResume = buildArguments(route('codex'), model, { prompt: 'hi', workspace: process.cwd(), kind: 'text', sessionId: 'sess_123.abc' });
  const sepIndex = codexResume.indexOf('--');
  assert.ok(sepIndex > 0, 'codex exec resume must separate positional sessionId with --');
  assert.equal(codexResume[sepIndex + 1], 'sess_123.abc');
});

test('adapter permission tightening: aider omits --yes-always and opencode denies tools by task kind/mode', () => {
  const aiderRoute = { id: 'aider-1', adapter: 'aider', executable: process.execPath, enabled: true, billing: 'free', models: [{ id: 'm1', alias: 'M1', kinds: ['text', 'read', 'write'] }] };
  const model = { id: 'm1', alias: 'M1', kinds: ['text', 'read', 'write'] };
  const aiderWrite = buildArguments(aiderRoute, model, { prompt: 'edit', workspace: process.cwd(), kind: 'write' });
  assert.equal(aiderWrite.includes('--yes-always'), false);
  const aiderRead = buildArguments(aiderRoute, model, { prompt: 'review', workspace: process.cwd(), kind: 'read' });
  assert.ok(aiderRead.includes('--chat-mode'));
  assert.equal(aiderRead[aiderRead.indexOf('--chat-mode') + 1], 'ask');

  const ocRoute = { id: 'oc-1', adapter: 'opencode', executable: process.execPath, enabled: true, billing: 'free', models: [{ id: 'm1', alias: 'M1', kinds: ['text', 'read', 'write'] }] };
  const textPerms = JSON.parse(routeEnvironment(ocRoute, undefined, 'text').OPENCODE_CONFIG_CONTENT).permission;
  assert.equal(textPerms['*'], 'deny');
  const readPerms = JSON.parse(routeEnvironment(ocRoute, undefined, 'read').OPENCODE_CONFIG_CONTENT).permission;
  assert.equal(readPerms.patch, 'deny');
  assert.equal(readPerms.apply_patch, 'deny');
  assert.equal(readPerms.webfetch, 'deny');
  assert.equal(readPerms.websearch, 'deny');
  const writeNonExecPerms = JSON.parse(routeEnvironment(ocRoute, undefined, 'write', 'response').OPENCODE_CONFIG_CONTENT).permission;
  assert.equal(writeNonExecPerms.bash, 'deny');
  const writeExecPerms = JSON.parse(routeEnvironment(ocRoute, undefined, 'write', 'execute').OPENCODE_CONFIG_CONTENT).permission;
  assert.equal(writeExecPerms.bash, undefined);
});

test('Pool.run does not self-reject a single task at minRemainingPercent + 1 and never leaks paid_api model override into autoSelect', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'pool-audit-run-'));
  const echoCli = path.join(root, 'echo.cjs');
  writeFileSync(echoCli, 'console.log(JSON.stringify({ type: "result", result: "OK" }));');
  const config = configSchema.parse({
    workspaceRoots: [root],
    routes: [
      {
        id: 'claude-edge',
        adapter: 'claude',
        executable: echoCli,
        enabled: true,
        billing: 'subscription',
        minRemainingPercent: 20,
        models: [
          { id: 'free-m', alias: 'FreeM', group: 'medium', kinds: ['text'] },
          { id: 'paid-override', alias: 'PaidM', group: 'high', billing: 'paid_api', kinds: ['text'] },
        ],
      },
    ],
  });
  const store = new Store(':memory:');
  store.saveQuota('claude-edge', { status: 'available', observedAt: new Date().toISOString(), windows: [{ name: '5h', remainingPercent: 21 }] });
  const pool = new Pool(config, store, { directory: root });
  pool.checkAuth = async () => {};
  t.after(async () => { await pool.close(); store.close(); rmSync(root, { recursive: true, force: true }); });

  // Paid model override inside non-paid route must NEVER be auto-selected.
  assert.throws(() => pool.select({ kind: 'text', group: 'high' }), { code: 'NO_ROUTE' });

  // Single task with 21% remaining and 20% threshold must succeed (not self-penalize by +2% to 22%).
  const submitted = await pool.submit({ prompt: 'hello', workspace: root, kind: 'text', routeId: 'claude-edge', modelId: 'free-m', idempotencyKey: 'edge-21-0001' });
  let done = pool.get(submitted.id);
  for (let i = 0; i < 100 && !['succeeded', 'failed', 'timed_out', 'cancelled'].includes(done.state); i++) {
    await new Promise(r => setTimeout(r, 50));
    done = pool.get(submitted.id);
  }
  assert.equal(done.state, 'succeeded');
});

test('Pool.select comparator is transitive and respects known-quota ordering', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'pool-audit-order-'));
  const config = configSchema.parse({
    workspaceRoots: [root],
    routes: [
      { id: 'r1', adapter: 'codex', executable: process.execPath, enabled: true, billing: 'subscription', priority: 100, models: [{ id: 'm1', alias: 'M1', group: 'medium', kinds: ['text'] }] },
      { id: 'r2', adapter: 'claude', executable: process.execPath, enabled: true, billing: 'subscription', priority: 100, models: [{ id: 'm2', alias: 'M2', group: 'medium', kinds: ['text'] }] },
      { id: 'r3', adapter: 'agy', executable: process.execPath, enabled: true, billing: 'subscription', priority: 100, models: [{ id: 'm3', alias: 'M3', group: 'medium', kinds: ['text'] }] },
    ],
  });
  const store = new Store(':memory:');
  const now = new Date().toISOString();
  store.saveQuota('r1', { status: 'available', observedAt: now, windows: [{ name: '5h', remainingPercent: 90 }] });
  store.saveQuota('r2', { status: 'unknown', observedAt: now, windows: [] });
  store.saveQuota('r3', { status: 'available', observedAt: now, windows: [{ name: '5h', remainingPercent: 40 }] });
  const pool = new Pool(config, store, { directory: root });
  t.after(async () => { await pool.close(); store.close(); rmSync(root, { recursive: true, force: true }); });

  const pick = pool.select({ kind: 'text', group: 'medium' });
  assert.equal(pick.selected.routeId, 'r1');

  // Expired rate_limited snapshot with stale observedAt should not falsely block once stale.
  const oldTime = new Date(Date.now() - 120_000).toISOString();
  store.saveQuota('r1', { status: 'rate_limited', observedAt: oldTime, windows: [{ name: '5h', remainingPercent: 0 }] });
  assert.equal(store.quota('r1').observedAt, oldTime);
});

test('parseExecutionReport extracts trailing JSON block even when earlier fenced code blocks exist', () => {
  const output = [
    'Here is the patch I applied:',
    '```js',
    'export const ok = true;',
    '```',
    '',
    'Final report:',
    '```json',
    JSON.stringify({ status: 'completed', summary: 'Fixed bug', files: [{ path: 'a.js', change: 'updated' }], checks: [{ command: 'npm test', outcome: 'passed' }], research: [], blockers: [] }),
    '```',
  ].join('\n');
  const report = parseExecutionReport(output);
  assert.ok(report);
  assert.equal(report.status, 'completed');
  assert.equal(report.summary, 'Fixed bug');
});

test('director onExit/secretEnv blocked for non-owner callers and TaskWatchdog strips daemon secrets from hook env', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'pool-audit-hook-'));
  const dumpScript = path.join(root, 'dump-env.cjs');
  const outFile = path.join(root, 'hook-env.json');
  writeFileSync(dumpScript, `const fs=require('fs');fs.writeFileSync(${JSON.stringify(outFile)}, JSON.stringify(process.env));console.log('CAP_NOTIFY Bearer abcdef0123456789abcdef0123456789');`);
  const config = configSchema.parse({ workspaceRoots: [root], routes: [] });
  const store = new Store(':memory:');
  const pool = new Pool(config, store, { directory: root });
  t.after(async () => { await pool.close(); store.close(); rmSync(root, { recursive: true, force: true }); });

  // Running director (with taskToken/worker) cannot attach onExit or secretEnv via pool_submit.
  const workerTools = poolTools(pool, { worker: true, taskToken: 'fake-token' });
  await assert.rejects(
    () => invokeTool(workerTools, 'pool_submit', {
      prompt: 'next', workspace: root, kind: 'write', mode: 'execute', profile: 'director', idempotencyKey: 'dir-hook-0001',
      onExit: { argv: [process.execPath, dumpScript], timeoutSeconds: 10 },
    }),
    err => err.code === 'OWNER_ONLY',
  );
  await assert.rejects(
    () => invokeTool(workerTools, 'pool_submit', {
      prompt: 'next', workspace: root, kind: 'write', mode: 'execute', profile: 'director', idempotencyKey: 'dir-sec-0001',
      secretEnv: { PB_DEMO: 'val' },
    }),
    err => err.code === 'OWNER_ONLY',
  );
  // Strict schema rejects unknown fields on MCP tool invocation.
  await assert.rejects(
    () => invokeTool(poolTools(pool), 'pool_list_pools', { unexpectedField: 123 }),
    err => err.code === 'INVALID_REQUEST' || err.name === 'ZodError',
  );

  // TaskWatchdog hook must NOT inherit arbitrary daemon env vars.
  const prevKey = process.env.POOL_AUDIT_DAEMON_SECRET;
  process.env.POOL_AUDIT_DAEMON_SECRET = 'must-not-leak-to-hook';
  t.after(() => {
    if (prevKey === undefined) delete process.env.POOL_AUDIT_DAEMON_SECRET;
    else process.env.POOL_AUDIT_DAEMON_SECRET = prevKey;
  });
  store.insert({
    id: 'task-hook-1', key: 'hk-1-00001', fingerprint: 'fp-1', workspace: root,
    request: { prompt: 'x', workspace: root, kind: 'write', mode: 'execute', profile: 'director', onExit: { argv: [process.execPath, dumpScript], timeoutSeconds: 15 } },
  });
  store.update('task-hook-1', 'failed', null, 'CLI_FAILED');
  await pool.reconciled;
  const watchdog = new TaskWatchdog(pool);
  await watchdog.tick();
  await Promise.all([...watchdog.hooks.values()]);
  await watchdog.close();
  const capturedEnv = JSON.parse(readFileSync(outFile, 'utf8'));
  assert.equal(capturedEnv.POOL_AUDIT_DAEMON_SECRET, undefined);
  assert.equal(capturedEnv.CAP_TASK_ID, 'task-hook-1');
  const notifyLines = store.notifications('task-hook-1');
  assert.equal(notifyLines.length, 1);
  assert.equal(notifyLines[0].includes('abcdef0123456789'), false);
});

test('HTTP/Management hardening: prototype operation rejected, live quota & preflight_status require Bearer, malformed URL returns 400', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'pool-audit-http-'));
  const config = configSchema.parse({
    workspaceRoots: [root],
    routes: [{ id: 'r1', adapter: 'codex', executable: process.execPath, enabled: true, billing: 'subscription', models: [{ id: 'm1', alias: 'M1', group: 'medium', kinds: ['text'] }] }],
  });
  const store = new Store(':memory:');
  const pool = new Pool(config, store, { directory: root });
  const token = 'a'.repeat(64);
  const mgmt = 'b'.repeat(64);
  const app = createServer(pool, token, 0, { token: mgmt });
  const addr = await app.listen();
  t.after(async () => { app.server.close(); app.server.closeAllConnections(); await pool.close(); store.close(); rmSync(root, { recursive: true, force: true }); });

  // Prototype property lookup on ownerDirectorOperations must throw INVALID_OPERATION.
  await assert.rejects(async () => managementOperation(pool, { token: mgmt }, { operation: 'constructor' }), { code: 'INVALID_OPERATION' });
  await assert.rejects(async () => managementOperation(pool, { token: mgmt }, { operation: 'toString' }), { code: 'INVALID_OPERATION' });

  // Unauthenticated ?live=1 must return 401.
  const liveUnauth = await httpRequest(addr.port, 'GET', '/api/quotas/r1?live=1');
  assert.equal(liveUnauth.status, 401);

  // Unauthenticated pool_preflight_status must return 401.
  const pfUnauth = await httpRequest(addr.port, 'POST', '/api/tools/pool_preflight_status', { headers: { 'Content-Type': 'application/json' }, body: {} });
  assert.equal(pfUnauth.status, 401);

  // Prototype key alias on /api/tools/constructor must not dispatch.
  const protoTool = await httpRequest(addr.port, 'POST', '/api/tools/constructor', { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: {} });
  assert.equal(protoTool.status, 404);

  // Malformed percent encoding must return 400 (not 500).
  const badUrl = await httpRequest(addr.port, 'GET', '/api/pools/%E0%A4%A');
  assert.equal(badUrl.status, 400);

  // Extra trailing path segments must return 404.
  const extraSeg = await httpRequest(addr.port, 'GET', '/api/pools/medium/extra/junk');
  assert.equal(extraSeg.status, 404);
});

test('childEnvironment deduplicates Windows env keys case-insensitively and mirrorAgyPermissions strips MCP secrets', () => {
  if (process.platform === 'win32') {
    const env = childEnvironment({ USERPROFILE: 'C:\\IsolatedProfile' });
    const profileKeys = Object.keys(env).filter(k => k.toUpperCase() === 'USERPROFILE');
    assert.deepEqual(profileKeys, ['USERPROFILE']);
    assert.equal(env.USERPROFILE, 'C:\\IsolatedProfile');
  }
  const srcHome = mkdtempSync(path.join(tmpdir(), 'pool-audit-agy-src-'));
  const dstGemini = mkdtempSync(path.join(tmpdir(), 'pool-audit-agy-dst-'));
  try {
    mkdirSync(path.join(srcHome, '.gemini', 'config'), { recursive: true });
    mkdirSync(path.join(srcHome, '.gemini', 'antigravity-cli'), { recursive: true });
    writeFileSync(path.join(srcHome, '.gemini', 'config', 'mcp_config.json'), JSON.stringify({
      mcpServers: {
        demo: { command: 'node', args: ['srv.js'], env: { API_TOKEN: 'secret-val' }, headers: { Authorization: 'Bearer xyz' } },
      },
    }));
    mirrorAgyPermissions(dstGemini, srcHome, false);
    const mirrored = JSON.parse(readFileSync(path.join(dstGemini, 'config', 'mcp_config.json'), 'utf8'));
    assert.equal(mirrored.mcpServers.demo.command, 'node');
    assert.equal(mirrored.mcpServers.demo.env, undefined);
    assert.equal(mirrored.mcpServers.demo.headers, undefined);
    const settingsText = readFileSync(path.join(dstGemini, 'antigravity-cli', 'settings.json'), 'utf8');
    assert.equal(settingsText.includes('.project-brain'), false);
  } finally {
    rmSync(srcHome, { recursive: true, force: true });
    rmSync(dstGemini, { recursive: true, force: true });
  }
});

test('quotas & adapters fixes: OpenCode Go count-vs-percent, Antigravity NaN guard, Kimi TOML parsing, agy routeCatalog ordering', async () => {
  // OpenCode Go: limit=1000, used=900, remaining=100 => 10% (not 100%).
  const goWindows = parseOpenCodeGoUsage({ windows: [{ name: '5h', limit: 1000, used: 900, remaining: 100 }] });
  assert.equal(goWindows.length, 1);
  assert.equal(goWindows[0].remainingPercent, 10);

  // Antigravity NaN remainingFraction must be skipped (not become null <= 0 -> rate_limited).
  const agyWin = antigravityModelWindows({
    models: {
      'gemini-bad': { quotaInfo: { remainingFraction: 'not-a-number' } },
      'gemini-ok': { quotaInfo: { remainingFraction: 0.75 } },
    },
  });
  assert.equal(agyWin.length, 1);
  assert.equal(agyWin[0].remainingPercent, 75);

  // Kimi TOML with array brackets before key must still parse access_token.
  const kimiHome = mkdtempSync(path.join(tmpdir(), 'pool-audit-kimi-'));
  try {
    mkdirSync(path.join(kimiHome, '.kimi-code', 'credentials'), { recursive: true });
    writeFileSync(
      path.join(kimiHome, '.kimi-code', 'config.toml'),
      '[providers."managed:kimi-code".oauth]\nscopes = ["read", "write"]\nkey = "oauth/demo_key"\n',
    );
    writeFileSync(path.join(kimiHome, '.kimi-code', 'credentials', 'demo_key.json'), JSON.stringify({ access_token: 'tok_valid_demo' }));
    assert.equal(kimiLoggedIn(kimiHome), true);
  } finally {
    rmSync(kimiHome, { recursive: true, force: true });
  }

  // agy routeCatalog must not throw TypeError when base model ID appears before effort variants.
  const agyRoot = mkdtempSync(path.join(tmpdir(), 'pool-audit-agy-cat-'));
  const fakeAgy = path.join(agyRoot, 'agy.cjs');
  writeFileSync(fakeAgy, 'console.log("gemini-4-argon\\tGemini 4 Argon\\ngemini-4-argon-low\\tGemini 4 Argon Low\\ngemini-4-argon-high\\tGemini 4 Argon High");');
  try {
    const cat = await routeCatalog({ id: 'agy-test', adapter: 'agy', executable: fakeAgy, enabled: true, billing: 'subscription', models: [] }, agyRoot, undefined, agyRoot);
    assert.equal(cat.models.length, 1);
    assert.equal(cat.models[0].id, 'gemini-4-argon');
    assert.deepEqual(cat.models[0].efforts, ['low', 'high']);
  } finally {
    rmSync(agyRoot, { recursive: true, force: true });
  }
});

test('remote QR V7-V10 preserves alignment pattern centers over timing patterns', () => {
  // 140-char URL requires QR Version 7+ (size >= 45, which has alignment patterns at row/col 6).
  const longUrl = 'https://host-example.tail12345.ts.net:43128/?pair=' + 'a'.repeat(92);
  const matrix = encodeQrMatrix(longUrl);
  const size = matrix.length;
  assert.ok(size >= 45, `expected QR V7+ (size >= 45), got size ${size}`);
  // Alignment pattern center at (mid, mid) must be intact: center = 1, ring1 = 0, ring2 = 1.
  const mid = Math.floor((size - 13) / 2) + 6;
  assert.equal(matrix[mid][mid], 1);
  assert.equal(matrix[mid][mid - 1], 0);
  assert.equal(matrix[mid][mid - 2], 1);
  // Timing pattern at (6, 8) is 1, (6, 9) is 0.
  assert.equal(matrix[6][8], 1);
  assert.equal(matrix[6][9], 0);
});

test('remote server enforces CSRF, sensitive file denylist, direct-loopback guard, and clearChatNativeSession', async t => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'pool-audit-remote-data-'));
  const workDir = mkdtempSync(path.join(tmpdir(), 'pool-audit-remote-work-'));
  writeFileSync(path.join(dataDir, 'access-token'), 'secret-token-content');
  writeFileSync(path.join(workDir, 'notes.md'), '# Safe note\n');
  writeFileSync(path.join(workDir, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02, 0xff]));

  const remoteStore = new RemoteStore(dataDir);
  const paired = remoteStore.pairDevice('Test Browser');
  const chat = remoteStore.createChat({ title: 'C1', workspace: workDir });
  remoteStore.appendMessage(chat.id, { role: 'assistant', text: 'prev', taskId: 't-old', sessionId: 'sess-old', routeId: 'r1', modelId: 'm1', workspace: workDir });
  remoteStore.recordTaskSession(chat.id, 't-old', 'sess-old');
  remoteStore.clearChatNativeSession(chat.id);

  let lastSubmitted = null;
  const fakePool = {
    getConfig() { return { workspaceRoots: [workDir], routes: [] }; },
    async health() { return { status: 'ok', version: '2.30.0', counts: {} }; },
    async pools() { return { categories: [] }; },
    async catalogModels() { return []; },
    async quotas() { return { connections: [] }; },
    async connections() { return []; },
    async tasks() { return { tasks: [] }; },
    async task() { return { id: 't1', state: 'succeeded', result: 'ok' }; },
    async submit(payload) { lastSubmitted = payload; return { id: 't1', state: 'queued' }; },
  };
  const srv = createRemoteServer({
    directory: dataDir, host: '127.0.0.1', port: 0, store: remoteStore, poolBridge: fakePool,
    managementToken: 'm'.repeat(64),
  });
  const addr = await srv.listen();
  t.after(async () => {
    await srv.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  });

  const authHeaders = { Cookie: `pool_remote=${paired.cookieValue}` };

  // CSRF: mutating POST without Content-Type: application/json must fail 415.
  const noJson = await httpRequest(addr.port, 'POST', '/r/chats', { headers: { ...authHeaders, 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(noJson.status, 415);

  // CSRF: foreign Origin on mutating POST must fail 403.
  const badOrigin = await httpRequest(addr.port, 'POST', '/r/chats', {
    headers: { ...authHeaders, 'Content-Type': 'application/json', Origin: 'https://evil.example' },
    body: { title: 'x' },
  });
  assert.equal(badOrigin.status, 403);

  // /r/file blocks sensitive dataDir and binary files, allows workspace text file.
  const secretFile = await httpRequest(addr.port, 'GET', `/r/file?workspace=${encodeURIComponent(dataDir)}&file=access-token`, { headers: authHeaders });
  assert.equal(secretFile.status, 403);
  const binFile = await httpRequest(addr.port, 'GET', `/r/file?workspace=${encodeURIComponent(workDir)}&file=bin.dat`, { headers: authHeaders });
  assert.equal(binFile.status, 400);
  const okFile = await httpRequest(addr.port, 'GET', `/r/file?workspace=${encodeURIComponent(workDir)}&file=notes.md`, { headers: authHeaders });
  assert.equal(okFile.status, 200);
  assert.match(okFile.json.content, /Safe note/);

  // /r/folders/pick must reject Tailscale Serve proxied requests carrying X-Forwarded-For.
  const proxiedPick = await httpRequest(addr.port, 'POST', '/r/folders/pick', {
    headers: { ...authHeaders, 'Content-Type': 'application/json', 'X-Forwarded-For': '100.64.0.9' },
    body: {},
  });
  assert.equal(proxiedPick.status, 409);
  assert.equal(proxiedPick.json?.error?.code, 'PICKER_UNAVAILABLE');

  // Cleared nativeSession must NOT be resurrected from old assistant message metadata.
  const sent = await httpRequest(addr.port, 'POST', `/r/chats/${chat.id}/send`, {
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: { prompt: 'new turn', routeId: 'r1', modelId: 'm1', workspace: workDir },
  });
  assert.equal(sent.status, 200);
  assert.equal(lastSubmitted.sessionId, undefined);
});

test('web/pool-state fixes: settingsViewSignature tracks real quota windows/email, quotaWindowPercent returns null when absent, quotaMatches treats informational as healthy', () => {
  const cfg = {
    routes: [{ id: 'r1', adapter: 'claude', enabled: true, billing: 'subscription', priority: 100, minRemainingPercent: 10, models: [{ id: 'm1', alias: 'M1', kinds: ['text'] }] }],
    categories: [],
    modelFilters: [],
  };
  const sigA = settingsViewSignature(cfg, { r1: { status: 'available', email: 'a@example.com', windows: [{ name: '5h', remainingPercent: 90 }] } });
  const sigB = settingsViewSignature(cfg, { r1: { status: 'available', email: 'a@example.com', windows: [{ name: '5h', remainingPercent: 40 }] } });
  const sigC = settingsViewSignature(cfg, { r1: { status: 'available', email: 'b@example.com', windows: [{ name: '5h', remainingPercent: 40 }] } });
  assert.notEqual(sigA, sigB);
  assert.notEqual(sigB, sigC);

  // Requesting 5h when only weekly window exists must return null (not weekly %).
  const weeklyOnly = { status: 'available', windows: [{ name: 'weekly', windowMinutes: 10080, remainingPercent: 80 }] };
  assert.equal(quotaWindowPercent(weeklyOnly, 'm1', '5h'), null);
  assert.equal(quotaWindowPercent(weeklyOnly, 'm1', 'weekly'), 80);

  // Informational quota (no numeric windows, e.g. OpenCode Zen stats) is healthy, not unknown.
  const route = cfg.routes[0];
  const model = route.models[0];
  const infoSnap = { status: 'unknown', informational: true, note: 'Bugun: 3 oturum', windows: [] };
  assert.equal(quotaMatches(infoSnap, 'm1', 'healthy', route, model), true);
  assert.equal(quotaMatches(infoSnap, 'm1', 'unknown', route, model), false);
});
