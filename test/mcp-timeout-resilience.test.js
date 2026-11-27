import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { configSchema, dataDirectory } from '../src/config.js';
import { Store } from '../src/store.js';
import { Pool } from '../src/pool.js';
import { createServer } from '../src/server.js';
import { apiRequest, callPoolTool, managementRequest } from '../src/daemon.js';
import { execute, quota } from '../src/adapters.js';
import { runProcess } from '../src/process.js';
import {
  stdioBridge,
  isAuthError,
  isReconnectableError,
  CONNECT_TIMEOUT_MS,
  LIST_TOOLS_TIMEOUT_MS,
  CALL_TOOL_TIMEOUT_MS,
} from '../src/stdio.js';
import { profileEnvironment, mirrorAgyPermissions } from '../src/profiles.js';
import { prepareNativeAgyProfile } from '../src/accounts.js';
import { cliVersion } from '../src/preflight.js';

function createCleanups(t) {
  const stack = [];
  t.after(async () => {
    for (const fn of stack.reverse()) {
      try { await fn(); } catch { /* best-effort cleanup */ }
    }
  });
  return fn => stack.push(fn);
}

function makeTempDir(addCleanup, prefix = 'pool-mcp-res-') {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  addCleanup(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return dir;
}

function makeFixture(addCleanup) {
  const root = makeTempDir(addCleanup);
  const config = configSchema.parse({
    workspaceRoots: [],
    routes: [{
      id: 'test-route',
      adapter: 'codex',
      executable: process.execPath,
      enabled: true,
      billing: 'subscription',
      models: [{ id: 'test-model', alias: 'Test Model', group: 'high', kinds: ['text', 'read'] }],
    }],
  });
  const token = randomBytes(32).toString('hex');
  const managementToken = randomBytes(32).toString('hex');
  const store = new Store(path.join(root, 'pool.sqlite'));
  addCleanup(() => store.close());
  const pool = new Pool(config, store, { directory: root });
  addCleanup(() => pool.close());
  store.saveQuota('test-route', { status: 'available', windows: [{ name: '5h', remainingPercent: 85 }], observedAt: new Date().toISOString() });
  writeFileSync(path.join(root, 'access-token'), token);
  writeFileSync(path.join(root, 'management-token'), managementToken);
  writeFileSync(path.join(root, '.acl-hardened'), 'test\n');
  return { root, config, token, managementToken, store, pool };
}

test('stdio bridge completes MCP initialize immediately before daemon is up and connects lazily on first request', async t => {
  const addCleanup = createCleanups(t);
  const { root, config, token, managementToken, pool } = makeFixture(addCleanup);
  const probeApp = createServer(pool, token, 0, { directory: root, token: managementToken });
  const { port } = await probeApp.listen();
  probeApp.server.closeAllConnections();
  await new Promise(resolve => probeApp.server.close(resolve));

  config.port = port;
  writeFileSync(path.join(root, 'config.json'), JSON.stringify(config));

  let ensureCalls = 0;
  let liveApp = null;
  const ensureDaemonFn = async () => {
    ensureCalls++;
    if (!liveApp) {
      liveApp = createServer(pool, token, port, { directory: root, token: managementToken });
      await liveApp.listen();
      addCleanup(async () => {
        liveApp.server.closeAllConnections();
        await new Promise(resolve => liveApp.server.close(resolve));
      });
    }
    return { status: 'listening', started: true };
  };

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const closeBridge = await stdioBridge(root, null, { serverTransport, warmUp: false, ensureDaemonFn });
  addCleanup(() => closeBridge());

  const client = new Client({ name: 'lazy-init-test', version: '1.0.0' });
  const t0 = Date.now();
  await client.connect(clientTransport);
  addCleanup(() => client.close());

  assert.equal(ensureCalls, 0, 'MCP initialize must not block on daemon startup');
  assert.ok(Date.now() - t0 < 2000, 'MCP initialize should finish immediately');

  const tools = await client.listTools();
  assert.equal(ensureCalls, 1, 'first MCP request lazily ensures daemon');
  assert.equal(tools.tools.length, 19);

  const help = await client.callTool({ name: 'pool_help', arguments: {} });
  assert.equal(help.isError, undefined);
  assert.ok(help.structuredContent?.data?.entries);
});

test('stdio bridge automatically reconnects after daemon stop and restart without restarting the bridge', async t => {
  const addCleanup = createCleanups(t);
  const { root, config, token, managementToken, pool } = makeFixture(addCleanup);
  let activeApp = createServer(pool, token, 0, { directory: root, token: managementToken });
  const { port } = await activeApp.listen();
  config.port = port;
  writeFileSync(path.join(root, 'config.json'), JSON.stringify(config));

  addCleanup(async () => {
    if (activeApp?.server?.listening) {
      activeApp.server.closeAllConnections();
      await new Promise(resolve => activeApp.server.close(resolve));
    }
  });

  let ensureCalls = 0;
  const ensureDaemonFn = async () => {
    ensureCalls++;
    if (!activeApp.server.listening) {
      activeApp = createServer(pool, token, port, { directory: root, token: managementToken });
      await activeApp.listen();
    }
    return { status: 'listening', started: true };
  };

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const closeBridge = await stdioBridge(root, null, { serverTransport, warmUp: false, ensureDaemonFn });
  addCleanup(() => closeBridge());

  const client = new Client({ name: 'reconnect-test', version: '1.0.0' });
  await client.connect(clientTransport);
  addCleanup(() => client.close());

  assert.equal((await client.listTools()).tools.length, 19);
  assert.equal(ensureCalls, 0);

  // Stop the daemon completely (simulating cli-agent-pool stop / restart / update).
  activeApp.server.closeAllConnections();
  await new Promise(resolve => activeApp.server.close(resolve));

  // Next tool call on the SAME stdio bridge reconnects transparently.
  const help = await client.callTool({ name: 'pool_help', arguments: {} });
  assert.equal(ensureCalls, 1);
  assert.ok(!help.isError);
  assert.ok(help.structuredContent?.data?.entries);

  // Stop again and verify listTools also recovers.
  activeApp.server.closeAllConnections();
  await new Promise(resolve => activeApp.server.close(resolve));

  const toolsAfterRestart = await client.listTools();
  assert.equal(ensureCalls, 2);
  assert.equal(toolsAfterRestart.tools.length, 19);
});

test('error classification separates reconnectable transport drops from auth conflicts', () => {
  assert.equal(isAuthError({ status: 401 }), true);
  assert.equal(isAuthError({ code: 'DAEMON_IDENTITY_CONFLICT', message: 'conflict' }), true);
  assert.equal(isAuthError(new Error('Streamable HTTP error: 401 Unauthorized')), true);
  assert.equal(isReconnectableError({ status: 401 }), false);
  assert.equal(isReconnectableError({ code: 'DAEMON_IDENTITY_CONFLICT', message: 'conflict' }), false);
  assert.equal(isReconnectableError(Object.assign(new Error('aborted'), { name: 'AbortError' })), false);
  assert.equal(isReconnectableError(new TypeError('fetch failed')), true);
  assert.equal(isReconnectableError(Object.assign(new Error('connect failed'), { cause: { code: 'ECONNREFUSED' } })), true);
  assert.equal(isReconnectableError({ code: 503, message: 'Service Unavailable' }), true);
  assert.equal(isReconnectableError(new Error('Connection closed')), true);
});

test('isolated account profiles resolve enclosing Pool data directory, write runtime-path locator, and sanitize MCP config safely', async t => {
  const addCleanup = createCleanups(t);
  const poolRoot = makeTempDir(addCleanup, 'pool-isolated-root-');
  writeFileSync(path.join(poolRoot, 'access-token'), 'a'.repeat(64));
  writeFileSync(path.join(poolRoot, 'config.json'), JSON.stringify({ routes: [] }));

  // 1. Even before any locator file exists, <poolRoot>/profiles/<adapter>/<profile> resolves to poolRoot.
  const agyProfile = path.join(poolRoot, 'profiles', 'agy', 'acc3');
  mkdirSync(agyProfile, { recursive: true });
  assert.equal(dataDirectory({ env: {}, home: agyProfile }), poolRoot);

  // 2. profileEnvironment and prepareNativeAgyProfile write .cli-agent-pool/runtime-path into the profile home.
  profileEnvironment({ adapter: 'agy', profile: 'acc3' }, poolRoot, true);
  const locator3 = path.join(agyProfile, '.cli-agent-pool', 'runtime-path');
  assert.equal(existsSync(locator3), true);
  assert.equal(readFileSync(locator3, 'utf8').trim(), path.resolve(poolRoot));

  prepareNativeAgyProfile({ adapter: 'agy', profile: 'acc4' }, poolRoot);
  const locator4 = path.join(poolRoot, 'profiles', 'agy', 'acc4', '.cli-agent-pool', 'runtime-path');
  assert.equal(existsSync(locator4), true);
  assert.equal(readFileSync(locator4, 'utf8').trim(), path.resolve(poolRoot));

  // 3. mirrorAgyPermissions strips secret env/headers while preserving only valid absolute CLI_AGENT_POOL_HOME.
  const srcHome = makeTempDir(addCleanup, 'pool-mcp-src-');
  const dstGemini = path.join(makeTempDir(addCleanup, 'pool-mcp-dst-'), '.gemini');
  mkdirSync(path.join(srcHome, '.gemini', 'config'), { recursive: true });
  mkdirSync(path.join(srcHome, '.gemini', 'antigravity-cli'), { recursive: true });
  writeFileSync(path.join(srcHome, '.gemini', 'config', 'mcp_config.json'), JSON.stringify({
    mcpServers: {
      'cli-agent-pool': { command: 'node', args: ['pool.js', 'stdio'], env: { CLI_AGENT_POOL_HOME: poolRoot, SECRET_TOKEN: 'drop-me' }, headers: { Authorization: 'Bearer nope' } },
      'relative-bad': { command: 'node', args: ['x.js'], env: { CLI_AGENT_POOL_HOME: 'relative/path', API_KEY: 'secret' } },
    },
  }));
  mirrorAgyPermissions(dstGemini, srcHome, false);
  const mirrored = JSON.parse(readFileSync(path.join(dstGemini, 'config', 'mcp_config.json'), 'utf8'));
  assert.deepEqual(mirrored.mcpServers['cli-agent-pool'].env, { CLI_AGENT_POOL_HOME: poolRoot });
  assert.equal(mirrored.mcpServers['cli-agent-pool'].headers, undefined);
  assert.equal(mirrored.mcpServers['relative-bad'].env, undefined);

  // 4. Spawned bin/pool.js stdio running inside an isolated profile without CLI_AGENT_POOL_HOME connects cleanly (no 401).
  const { root, config, token, managementToken, pool } = makeFixture(addCleanup);
  const app = createServer(pool, token, 0, { directory: root, token: managementToken });
  const { port } = await app.listen();
  config.port = port;
  writeFileSync(path.join(root, 'config.json'), JSON.stringify(config));
  addCleanup(async () => {
    app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
  });

  const isolatedHome = path.join(root, 'profiles', 'agy', 'acc3');
  mkdirSync(isolatedHome, { recursive: true });
  const client = new Client({ name: 'isolated-stdio-test', version: '1.0.0' });
  const cleanEnv = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => ['PATH', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'LOCALAPPDATA'].includes(name)),
  );
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../bin/pool.js', import.meta.url)), 'stdio'],
    env: { ...cleanEnv, USERPROFILE: isolatedHome, HOME: isolatedHome },
    stderr: 'pipe',
  }));
  addCleanup(() => client.close());

  const tools = await client.listTools();
  assert.equal(tools.tools.length, 19);
});

test('timeout layers are aligned and Pool.getQuota + cliVersion bound slow probes', async t => {
  const addCleanup = createCleanups(t);
  const { root, token, managementToken, store } = makeFixture(addCleanup);

  // 1. Unlimited execution/HTTP timeouts and aligned transport constants.
  assert.equal(CONNECT_TIMEOUT_MS, 15_000);
  assert.equal(LIST_TOOLS_TIMEOUT_MS, 30_000);
  assert.equal(CALL_TOOL_TIMEOUT_MS, 2_147_483_647);

  const slowConfig = configSchema.parse({
    workspaceRoots: [],
    routes: [{
      id: 'slow-route',
      adapter: 'claude',
      executable: process.execPath,
      enabled: true,
      billing: 'subscription',
      models: [{ id: 'test-model', alias: 'Test Model', group: 'high', kinds: ['text', 'read'] }],
    }],
  });
  store.saveQuota('slow-route', { status: 'available', windows: [{ name: '5h', remainingPercent: 85 }], observedAt: new Date().toISOString() });
  const slowPool = new Pool(slowConfig, store, {
    directory: root,
    quotaTimeoutMs: 120,
    quota: () => new Promise(resolve => {
      const timer = setTimeout(() => resolve({ status: 'available', windows: [{ name: '5h', remainingPercent: 50 }], observedAt: new Date().toISOString() }), 1000);
      timer.unref();
    }),
  });
  addCleanup(() => slowPool.close());

  const app = createServer(slowPool, token, 0, { directory: root, token: managementToken });
  assert.equal(app.server.requestTimeout, 0);
  assert.equal(app.server.headersTimeout, 15_000);
  app.server.close();

  // 2. callPoolTool passes unlimited (max 32-bit) timeout so long tasks never time out prematurely.
  let capturedOptions = null;
  const fakeClient = {
    async callTool(_params, _schema, opts) {
      capturedOptions = opts;
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] };
    },
  };
  await callPoolTool(fakeClient, 'pool_help', {});
  assert.equal(capturedOptions?.timeout, 2_147_483_647);

  // 3. Pool.getQuota enforces quotaTimeoutMs and falls back to cached windows with stale+networkError.
  const t0 = Date.now();
  const timedOutSnap = await slowPool.getQuota('slow-route', true);
  assert.ok(Date.now() - t0 < 800, 'getQuota must return promptly when probe exceeds quotaTimeoutMs');
  assert.equal(timedOutSnap.stale, true);
  assert.equal(timedOutSnap.networkError, true);
  assert.equal(timedOutSnap.windows[0].remainingPercent, 85);

  // 4. cliVersion deduplicates concurrent invocations for the same binary.
  const binDir = makeTempDir(addCleanup, 'pool-cliver-');
  const countFile = path.join(binDir, 'count.txt');
  const fakeCli = path.join(binDir, 'ver.cjs');
  writeFileSync(fakeCli, `const fs=require('fs');const f=${JSON.stringify(countFile)};fs.appendFileSync(f,'x');setTimeout(()=>console.log('1.2.3'),80);`);
  const fakeRoute = { id: 'r-ver', adapter: 'claude', executable: fakeCli };
  const [v1, v2] = await Promise.all([
    cliVersion(fakeRoute, process.platform === 'win32' ? 'python' : 'python3'),
    cliVersion(fakeRoute, process.platform === 'win32' ? 'python' : 'python3'),
  ]);
  assert.equal(v1, v2);
  assert.match(v1, /1\.2\.3/);
  assert.equal(readFileSync(countFile, 'utf8').length, 1, 'concurrent cliVersion calls should share one in-flight probe');
});

test('runProcess settles on spawn error and cancels promptly during large blocked stdin write', async t => {
  const addCleanup = createCleanups(t);
  const workDir = makeTempDir(addCleanup, 'pool-proc-res-');

  // 1. Missing python binary settles immediately with SPAWN_FAILED instead of hanging.
  const t0 = Date.now();
  const missing = runProcess({
    argv: [process.execPath, '-e', 'console.log("ok")'],
    cwd: workDir,
    python: path.join(workDir, 'does-not-exist-python.exe'),
    timeoutMs: 5000,
  });
  const missingRes = await missing.done;
  assert.equal(missingRes.stopReason, 'SPAWN_FAILED');
  assert.equal(missing.send('ignored'), false);
  assert.ok(Date.now() - t0 < 2000, 'spawn error must settle immediately');

  // 2. Large (>32 KB) stdin prompt sent to a child that never reads stdin cancels promptly.
  const sleeper = path.join(workDir, 'sleeper.cjs');
  writeFileSync(sleeper, 'setInterval(() => {}, 60000);');
  const t1 = Date.now();
  const proc = runProcess({
    argv: [process.execPath, sleeper],
    cwd: workDir,
    input: 'X'.repeat(40_000),
    python: process.platform === 'win32' ? 'python' : 'python3',
    timeoutMs: 400,
  });
  const res = await proc.done;
  assert.equal(res.stopReason, 'TIMEOUT');
  assert.ok(Date.now() - t1 < 4000, 'timeout cancel must work even while initial large stdin write is blocked');
});

test('stdio bridge survives dying-daemon restart race on reconnect', async t => {
  const addCleanup = createCleanups(t);
  const { root, config, token, managementToken, pool } = makeFixture(addCleanup);
  let activeApp = createServer(pool, token, 0, { directory: root, token: managementToken });
  const { port } = await activeApp.listen();
  config.port = port;
  writeFileSync(path.join(root, 'config.json'), JSON.stringify(config));

  addCleanup(async () => {
    if (activeApp?.server?.listening) {
      activeApp.server.closeAllConnections();
      await new Promise(resolve => activeApp.server.close(resolve));
    }
  });

  // Simulate restart race: first ensureDaemon call returns while the port is still closed
  // (as if a dying daemon answered pair_ui 1ms before closing); second call starts the server.
  let ensureCalls = 0;
  const ensureDaemonFn = async () => {
    ensureCalls++;
    if (ensureCalls >= 2 && !activeApp.server.listening) {
      activeApp = createServer(pool, token, port, { directory: root, token: managementToken });
      await activeApp.listen();
    }
    return { status: 'listening', started: ensureCalls >= 2 };
  };

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const closeBridge = await stdioBridge(root, null, { serverTransport, warmUp: false, ensureDaemonFn });
  addCleanup(() => closeBridge());

  const client = new Client({ name: 'restart-race-test', version: '1.0.0' });
  await client.connect(clientTransport);
  addCleanup(() => client.close());

  assert.equal((await client.listTools()).tools.length, 19);

  // Shut down daemon completely.
  activeApp.server.closeAllConnections();
  await new Promise(resolve => activeApp.server.close(resolve));

  // Next tool call survives the first failed openFresh attempt and succeeds on retry.
  const help = await client.callTool({ name: 'pool_help', arguments: {} });
  assert.equal(ensureCalls, 2);
  assert.ok(!help.isError);
  assert.ok(help.structuredContent?.data?.entries);
});

test('execute completes cleanly via post-result exit grace when a CLI hangs after emitting final result', async t => {
  const addCleanup = createCleanups(t);
  const workDir = makeTempDir(addCleanup, 'pool-post-result-');
  const fakeAgy = path.join(workDir, 'hanging-agy.cjs');
  writeFileSync(fakeAgy, [
    'process.stdin.resume();',
    'console.log(JSON.stringify({ event: "init", init: { model: "gemini-4-neon" } }));',
    'console.log(JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "Finished cleanly" } }));',
    'setInterval(() => {}, 60000);',
  ].join('\n'));

  const route = { id: 'agy-hang-test', adapter: 'agy', executable: fakeAgy, enabled: true, billing: 'subscription', trustedSettings: true };
  const model = { id: 'gemini-4-neon', alias: 'Gemini 4 Neon', kinds: ['text'] };
  const t0 = Date.now();
  const run = execute(
    route,
    model,
    { prompt: 'hi', workspace: workDir, kind: 'text', timeoutSeconds: 0 },
    process.platform === 'win32' ? 'python' : 'python3',
    () => {},
    workDir,
    { directory: workDir, postResultExitMs: 250 },
  );
  const outcome = await run.done;
  assert.equal(outcome.error, undefined);
  assert.equal(outcome.result, 'Finished cleanly');
  assert.ok(Date.now() - t0 < 4000, 'hanging CLI after terminal result event must be reclaimed promptly');
});

test('managementRequest and apiRequest honor explicit timeouts and qoder/mmx quota failures degrade to networkError', async t => {
  const addCleanup = createCleanups(t);
  const root = makeTempDir(addCleanup, 'pool-http-timeout-');
  const token = randomBytes(32).toString('hex');
  const managementToken = randomBytes(32).toString('hex');
  writeFileSync(path.join(root, 'access-token'), token);
  writeFileSync(path.join(root, 'management-token'), managementToken);
  writeFileSync(path.join(root, '.acl-hardened'), 'test\n');

  const slowServer = http.createServer((_req, res) => {
    const timer = setTimeout(() => {
      if (!res.writableEnded) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      }
    }, 250);
    timer.unref();
  });
  await new Promise(resolve => slowServer.listen(0, '127.0.0.1', resolve));
  addCleanup(async () => {
    slowServer.closeAllConnections();
    await new Promise(resolve => slowServer.close(resolve));
  });
  const { port } = slowServer.address();
  const config = configSchema.parse({ port, workspaceRoots: [], routes: [] });
  writeFileSync(path.join(root, 'config.json'), JSON.stringify(config));

  // managementRequest times out at short budget and succeeds with longer budget.
  await assert.rejects(
    managementRequest(root, config, { operation: 'refresh_route_auth' }, { timeoutMs: 60 }),
    err => err?.name === 'TimeoutError' || err?.name === 'AbortError',
  );
  const okManage = await managementRequest(root, config, { operation: 'refresh_route_auth' }, { timeoutMs: 2000 });
  assert.deepEqual(okManage, { ok: true });

  // apiRequest enforces timeoutMs with REQUEST_TIMEOUT instead of hanging forever.
  await assert.rejects(
    apiRequest(root, '/api/help', { timeoutMs: 60 }),
    err => err?.code === 'REQUEST_TIMEOUT',
  );

  // qoder and mmx quota readers degrade to networkError on CLI spawn/timeout failure (allowing Pool.getQuota cached fallback).
  const badPy = path.join(root, 'no-such-python.exe');
  const qoderSnap = await quota({ id: 'qoder-t', adapter: 'qoder', executable: process.execPath, billing: 'free_credits' }, root, badPy, root);
  assert.equal(qoderSnap.networkError, true);
  assert.equal(qoderSnap.status, 'unknown');

  const mmxSnap = await quota({ id: 'mmx-t', adapter: 'mmx', executable: process.execPath, billing: 'token_plan' }, root, badPy, root);
  assert.equal(mmxSnap.networkError, true);
  assert.equal(mmxSnap.status, 'unknown');
});

test('inputs, outputs, execution reports and probes enforce no character limits or default timeouts', async () => {
  const { taskSchema, PROBE_TIMEOUT_SECONDS } = await import('../src/pool.js');
  const { executionReportSchema, compactTask } = await import('../src/task-protocol.js');
  const { rpcRequest } = await import('../src/rpc.js');
  const { Readable } = await import('node:stream');

  assert.equal(PROBE_TIMEOUT_SECONDS, 0);
  const bigPrompt = 'A'.repeat(250_000);
  const parsedTask = taskSchema.parse({
    prompt: bigPrompt,
    workspace: process.cwd(),
    kind: 'text',
    idempotencyKey: 'unlimited-prompt-test-key',
  });
  assert.equal(parsedTask.prompt.length, 250_000);
  assert.equal(parsedTask.timeoutSeconds, 0);

  const bigSummary = 'B'.repeat(50_000);
  const parsedReport = executionReportSchema.parse({
    status: 'completed',
    summary: bigSummary,
    files: [],
    checks: [],
    research: [],
    blockers: [],
  });
  assert.equal(parsedReport.summary.length, 50_000);

  const bigOutput = 'C'.repeat(150_000);
  const compact = compactTask({ id: 't1', prompt: bigPrompt, events: [], result: bigOutput, error: null });
  assert.equal(compact.result.length, 150_000);
  assert.equal(compact.reportTruncated, false);

  const bigRpcPayload = JSON.stringify({ tool: 'pool_submit', arguments: { prompt: 'D'.repeat(1_200_000) } });
  const rpc = await rpcRequest(Readable.from([bigRpcPayload]));
  assert.equal(rpc.arguments.prompt.length, 1_200_000);
});
