import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { loadConfig } from './config.js';
import { ensureInitialized, ensureDaemon } from './daemon.js';
import { version } from './version.js';
import { taskHeader } from './task-header.js';

export const CONNECT_TIMEOUT_MS = 15_000;
export const LIST_TOOLS_TIMEOUT_MS = 30_000;
export const CALL_TOOL_TIMEOUT_MS = 120_000;

const RECONNECTABLE_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT', 'ERR_SOCKET_CLOSED', 'ECONNABORTED',
]);

export function isAuthError(error) {
  if (!error) return false;
  const status = error.status ?? error.code;
  if (status === 401 || status === 403 || error.code === 'DAEMON_IDENTITY_CONFLICT') return true;
  const message = String(error.message || '');
  return /\b(?:401|403|unauthorized|DAEMON_IDENTITY_CONFLICT)\b/i.test(message);
}

export function isReconnectableError(error) {
  if (!error || isAuthError(error)) return false;
  if (error.name === 'AbortError') return false;
  const httpStatus = typeof error.code === 'number' ? error.code : error.status;
  if (httpStatus === 404 || httpStatus === 502 || httpStatus === 503 || httpStatus === 504) return true;
  for (const candidate of [error, error.cause, error.cause?.cause]) {
    if (!candidate) continue;
    if (typeof candidate.code === 'string' && RECONNECTABLE_CODES.has(candidate.code)) return true;
  }
  const message = String(error.message || '');
  if (/fetch failed|socket hang up|other side closed|terminated|econnrefused|econnreset|epipe|not connected|connection closed|sse stream disconnected|shutting down/i.test(message)) {
    return true;
  }
  return false;
}

export async function stdioBridge(directory, initialConfig = null, options = {}) {
  const {
    warmUp = true,
    ensureDaemonFn = ensureDaemon,
    connectTimeoutMs = CONNECT_TIMEOUT_MS,
    listTimeoutMs = LIST_TOOLS_TIMEOUT_MS,
    callTimeoutMs = CALL_TOOL_TIMEOUT_MS,
    serverTransport = new StdioServerTransport(),
  } = options;

  let activeClient = null;
  let connectPromise = null;
  let closed = false;
  const bridgeAbort = new AbortController();

  const readBackend = () => {
    const hasConfig = existsSync(path.join(directory, 'config.json'));
    const hasToken = existsSync(path.join(directory, 'access-token'));
    let cfg;
    if (!hasConfig || !hasToken) {
      cfg = ensureInitialized(directory, !hasConfig);
    } else {
      cfg = loadConfig(directory);
    }
    if (!cfg && initialConfig) cfg = initialConfig;
    const token = readFileSync(path.join(directory, 'access-token'), 'utf8').trim();
    return { config: cfg, token };
  };

  const dropClient = client => {
    if (!client) return;
    if (activeClient === client) activeClient = null;
    void client.close().catch(() => {});
  };

  const openFresh = async (cfg, token) => {
    const client = new Client({ name: 'cli-agent-pool-stdio', version });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${cfg.port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}`, ...taskHeader() } },
    });
    transport.onclose = () => {
      if (activeClient === client) activeClient = null;
    };
    try {
      await client.connect(transport, { timeout: connectTimeoutMs });
    } catch (error) {
      void client.close().catch(() => {});
      throw error;
    }
    if (closed) {
      void client.close().catch(() => {});
      throw new Error('Bridge closed');
    }
    return client;
  };

  const ensureConnected = async ({ startDaemonFirst = false } = {}) => {
    if (closed) throw new Error('Bridge closed');
    if (activeClient) return activeClient;
    if (connectPromise) return connectPromise;
    const work = (async () => {
      let { config: cfg, token } = readBackend();
      if (!startDaemonFirst) {
        try {
          const fresh = await openFresh(cfg, token);
          activeClient = fresh;
          return fresh;
        } catch (error) {
          if (closed || isAuthError(error)) throw error;
        }
      }
      // During a service restart, a dying daemon may answer pair_ui right before
      // closing its socket; retry boundedly until the fresh listener accepts /mcp.
      let lastError = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (closed) throw new Error('Bridge closed');
        if (attempt > 0) await delay(250, undefined, { signal: bridgeAbort.signal });
        try {
          await ensureDaemonFn(directory, cfg, { signal: bridgeAbort.signal });
          if (closed) throw new Error('Bridge closed');
          ({ config: cfg, token } = readBackend());
          const fresh = await openFresh(cfg, token);
          activeClient = fresh;
          return fresh;
        } catch (error) {
          lastError = error;
          if (closed || isAuthError(error) || !isReconnectableError(error) || attempt === 2) throw error;
        }
      }
      throw lastError;
    })();
    connectPromise = work;
    try {
      return await work;
    } finally {
      if (connectPromise === work) connectPromise = null;
    }
  };

  const reconnect = async staleClient => {
    if (activeClient && activeClient !== staleClient) return activeClient;
    dropClient(staleClient);
    return ensureConnected({ startDaemonFirst: true });
  };

  const requestOptions = (timeout, extra) => ({
    timeout,
    ...(extra?.signal ? { signal: extra.signal } : {}),
  });

  const withClient = async (fn, extra) => {
    let client = null;
    try {
      client = await ensureConnected();
      return await fn(client);
    } catch (error) {
      if (closed || extra?.signal?.aborted || !isReconnectableError(error)) throw error;
      const fresh = await reconnect(client);
      return await fn(fresh);
    }
  };

  const server = new Server({ name: 'cli-agent-pool', version }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, (_request, extra) =>
    withClient(client => client.listTools(undefined, requestOptions(listTimeoutMs, extra)), extra));
  server.setRequestHandler(CallToolRequestSchema, (request, extra) =>
    withClient(client => client.callTool(request.params, undefined, requestOptions(callTimeoutMs, extra)), extra));

  // Complete MCP stdio initialization immediately without waiting for ACL setup,
  // daemon auto-start or HTTP transport probes.
  await server.connect(serverTransport);

  if (warmUp) {
    void ensureConnected().catch(() => {});
  }

  let closing = null;
  const close = () => {
    if (!closing) {
      closed = true;
      bridgeAbort.abort();
      const pendingClient = activeClient;
      activeClient = null;
      closing = Promise.allSettled([
        server.close(),
        pendingClient ? pendingClient.close() : Promise.resolve(),
      ]).then(() => {});
    }
    return closing;
  };
  if (serverTransport instanceof StdioServerTransport) {
    process.stdin.once('end', () => { void close(); });
    process.stdin.once('close', () => { void close(); });
    process.once('SIGINT', () => { void close(); });
    process.once('SIGTERM', () => { void close(); });
  }
  return close;
}
