import http from 'node:http';
import { timingSafeEqual, createHash } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { compactCatalog, catalogSchema, categoryQuerySchema, compactModel, quotaOverview, quotaOverviewSchema } from './catalog.js';
import { PoolError } from './config.js';
import { routeAccountEmail } from './adapters.js';
import { browserUI, managementOperation } from './web.js';
import { taskSchema } from './pool.js';
import { version } from './version.js';
import { compactTask } from './task-protocol.js';
import { serviceHelp } from './service-help.js';
import { preflightSchema } from './director.js';
import { directorFeatures } from './lifecycle.js';
import { handleApi } from './http-api.js';

const tokenHash = value => createHash('sha256').update(value).digest('hex');

export function errorEnvelope(error) {
  const known = error instanceof PoolError;
  const invalid = error instanceof z.ZodError;
  const invalidDetail = invalid ? error.issues.slice(0, 4).map(issue => issue.path.join('.') || 'input').join(', ') : '';
  const rawMessage = known ? error.message : invalid ? `İstek alanları geçersiz${invalidDetail ? ` (${invalidDetail})` : ''}.` : 'İşlem tamamlanamadı.';
  const code = known ? error.code : invalid ? 'INVALID_REQUEST' : 'INTERNAL_ERROR';
  return { error: { code, message: rawMessage.slice(0, 1200), help: { tool: 'pool_help', arguments: { code } } } };
}

// One tool table drives MCP, the stdin RPC bridge and the plain HTTP /api surface.
export function poolTools(pool, caller = {}) {
  const tools = new Map();
  const parent = () => caller.taskToken ? pool.taskTokens.get(tokenHash(caller.taskToken)) : null;
  const directing = () => parent()?.director && !parent()?.preflight;
  const owner = () => {
    if (caller.taskToken || caller.worker) throw new PoolError('OWNER_ONLY', 'This operation requires an owner session outside a Pool task.');
  };
  const register = (name, description, inputSchema, callback, readOnly = true) => tools.set(name, { name, description, inputSchema, callback, readOnly });
  register('pool_list_connections', 'Enabled connections only; each account is its own connection. Prefer pool_catalog for model discovery.', {}, () => pool.config.routes.filter(r => r.enabled).map(route => {
    const email = pool.store.quota(route.id)?.email || routeAccountEmail(route, pool.directory);
    return { id: route.id, adapter: route.adapter, billing: route.billing, account: route.profile || 'default', ...(email ? { email } : {}), ...(route.runtime === 'wsl' ? { runtime: route.runtime } : {}) };
  }));
  register('pool_list_pools', 'Categories only by default; group selects a short model page. Cached quota; no CLI calls.', categoryQuerySchema.shape, input => pool.pools(input));
  register('pool_list_models', 'Compatibility paginated catalog. Prefer pool_catalog.', catalogSchema.shape, input => compactCatalog(pool, {...input, view:'models'}));
  register('pool_help', 'Short service map, or recovery guidance for one error code.', {code:z.string().max(100).optional()}, ({code}) => serviceHelp(code));
  register('pool_get_policy', 'Compatibility service map; no selection or authority modes. Prefer pool_help.', {}, () => serviceHelp());
  register('pool_select', 'Recommend an allowed model without starting a task. mode: execute requires write and native tool support. minRemainingPercent can raise the owner quota reserve, never lower it.', { kind: z.enum(['text', 'read', 'write']), mode: z.enum(['response', 'execute']).optional(), routeId: z.string().max(100).optional(), modelId: z.string().max(100).optional(), group: z.string().max(100).optional(), effort: z.string().max(100).optional(), minRemainingPercent: z.number().min(0).max(100).optional() }, async input => { const result = caller.cachedOnly ? pool.select(input) : await pool.selectLive(input, { allowStaleRefresh: true, maxWaitMs: 2500 }); return {selected:compactModel(pool,result.selected),alternatives:result.alternatives.length}; });
  register('pool_submit', 'Start one bounded CLI task. For implementation use kind: write, mode: execute and the calling project/worktree absolute workspace. Native tools perform edits and checks, then return a short report. Reuse the same idempotency key for a lost response; poll the returned ID, never replay a started write.', taskSchema.extend({ compact: z.boolean().default(true) }).shape, async ({ compact, ...input }) => { let task;
    if (input.profile === 'director') {
      if (caller.taskToken && !directing()) throw new PoolError('OWNER_ONLY', 'Workers cannot submit directors.');
      if (caller.worker && !directing()) owner();
      if ((caller.taskToken || caller.worker) && (input.onExit || input.secretEnv)) throw new PoolError('OWNER_ONLY', 'Only an owner session can attach onExit hooks or secretEnv.');
      task = await pool.submitDirector(input);
    } else task = await pool.submitLive(input, false, { taskToken: caller.taskToken }); return compact ? compactTask(task) : task; }, false);
  register('pool_catalog', 'Sources only by default; billing/adapter/query filters return short model pages. No category required; no CLI discovery.', catalogSchema.shape, input => compactCatalog(pool, input));
  register('pool_quota_overview', 'Cached quota/status for every enabled connection (or one routeId); no CLI calls, no tokens.', quotaOverviewSchema.shape, input => quotaOverview(pool, input));
  register('pool_get_task', 'Read task state and result. compact: true omits prompt/events and bounds the report to reduce tokens. Queued is not failure; inspect queueReason/blockedBy.', { taskId: z.string().uuid(), after: z.number().int().min(0).default(0), compact: z.boolean().default(true) }, ({ taskId, after, compact }) => compact ? compactTask(pool.get(taskId, after)) : pool.get(taskId, after));
  register('pool_list_tasks', 'Read paginated local task history.', { limit: z.number().int().min(1).max(100).default(50), offset: z.number().int().min(0).max(1_000_000).default(0), activeFirst: z.boolean().default(false) }, ({ limit, offset, activeFirst }) => pool.list(limit, offset, activeFirst));
  register('pool_cancel_task', 'Request cancellation and wait for subsequent task state to confirm it.', { taskId: z.string().uuid() }, ({ taskId }) => pool.cancel(taskId), false);
  register('pool_capabilities', 'Supported optional task contracts and director mechanisms.', {}, () => directorFeatures);
  register('pool_preflight', 'Owner-only verified director readiness probes; takes normal workspace lock.', preflightSchema.shape, input => { owner(); return pool.preflight(input); }, false);
  register('pool_preflight_status', 'Cached director readiness; lock-free and runs no model.', preflightSchema.omit({ force: true }).shape, input => pool.preflightStatus(input));
  register('pool_preflight_ack', 'Used only by the running preflight probe.', { nonce: z.string().regex(/^[a-f0-9]{64}$/) }, ({ nonce }) => pool.preflightAck(nonce, caller.taskToken), false);
  register('pool_ack_task', 'Acknowledge running director takeover; idempotent while running.', { taskId: z.string().uuid() }, ({ taskId }) => {
    if ((caller.taskToken || caller.worker) && parent()?.taskId !== taskId) throw new PoolError('OWNER_ONLY', 'A task can acknowledge only itself.');
    return pool.watchdog.ack(taskId);
  }, false);
  register('pool_resolve_task', 'Owner: release an inspected stopped review lock without reverting files.', { taskId: z.string().uuid(), reviewed: z.literal(true), note: z.string().trim().min(1).max(600) }, input => { owner(); return pool.resolveInspected(input); }, false);
  register('pool_get_quotas', 'Query vendor quota through the installed CLI. Unsupported quotas remain unknown.', { routeId: z.string() }, ({ routeId }) => pool.getQuota(routeId));
  return tools;
}

// Validates like the MCP SDK does, then runs the shared callback.
export async function invokeTool(tools, name, input = {}) {
  const tool = tools.get(name);
  if (!tool) throw new PoolError('UNKNOWN_TOOL', 'Bilinmeyen araç. GET /api veya pool_help {} araç listesini verir.');
  return tool.callback(z.object(tool.inputSchema).strict().parse(input ?? {}));
}

export function mcpServer(pool, caller = {}) {
  const server = new McpServer({ name: 'cli-agent-pool', version });
  for (const { name, description, inputSchema, callback, readOnly } of poolTools(pool, caller).values()) server.registerTool(name, {
    description, inputSchema, annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: readOnly, openWorldHint: !readOnly },
  }, async input => {
    try {
      const value = await callback(input);
      return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: { data: value } };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: JSON.stringify(errorEnvelope(error)) }] };
    }
  });
  return server;
}

export function createServer(pool, token, port = pool.config.port, management) {
  if (!/^[a-f0-9]{64}$/.test(token)) throw new PoolError('INVALID_TOKEN', 'Erişim anahtarı geçersiz. Yerel kurulumu kontrol edin.');
  if (management && !/^[a-f0-9]{64}$/.test(management.token)) throw new PoolError('INVALID_TOKEN', 'Yönetim anahtarı geçersiz. Yerel kurulumu kontrol edin.');
  let inflight = 0;
  const ui = management ? browserUI(pool, management) : null;
  const server = http.createServer(async (req, res) => {
    const fail = (status, code, message) => { if (!res.headersSent) res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ error: { code, message } })); };
    const actualPort = server.address()?.port;
    if (req.headers.host !== `127.0.0.1:${actualPort}`) return fail(403, 'ORIGIN_DENIED', 'Bu bağlantı kaynağına izin verilmiyor.');
    if (ui?.serve(req, res, actualPort)) return;
    const browser = req.url === '/ui' && ui;
    if (browser) {
      if (req.headers.origin !== `http://127.0.0.1:${actualPort}` || !ui.authorized(req, actualPort)) {
        if (req.headers.origin === `http://127.0.0.1:${actualPort}`) ui.noteAuth(false);
        return fail(403, 'UNAUTHORIZED', 'Yönetim oturumu geçersiz. Masaüstü kısayolundan veya "cli-agent-pool open" komutuyla yeniden açın.');
      }
      ui.noteAuth(true);
    } else if ('origin' in req.headers || 'sec-fetch-site' in req.headers) return fail(403, 'ORIGIN_DENIED', 'Bu bağlantı kaynağına izin verilmiyor.');
    // Preflight poolService probe: no bearer token, only a live 256-bit single-use nonce plus its secret.
    const probe = /^\/preflight\/([a-f0-9]{64})$/.exec(req.url || '');
    if (probe) {
      if (req.method !== 'POST') return fail(405, 'METHOD_NOT_ALLOWED', 'POST only.');
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) return fail(415, 'CONTENT_TYPE', 'JSON required.');
      if (inflight >= 128) return fail(429, 'BUSY', 'Too many concurrent requests.');
      inflight++;
      res.once('close', () => { inflight--; });
      let size = 0; const parts = [];
      try {
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 1024) { req.resume(); return fail(413, 'REQUEST_TOO_LARGE', 'Too large.'); }
          parts.push(chunk);
        }
      } catch { return fail(400, 'INVALID_JSON', 'Incomplete probe request.'); }
      let secret = null; try { secret = JSON.parse(Buffer.concat(parts).toString('utf8')).secret; } catch { /* invalid */ }
      const accepted = pool.serviceAck(probe[1], secret);
      res.writeHead(accepted ? 204 : 404, { 'Cache-Control': 'no-store' });
      return res.end();
    }
    const authorization = req.headers.authorization || '';
    const bearerMatches = expectedToken => Buffer.byteLength(authorization) === Buffer.byteLength(`Bearer ${expectedToken}`) && timingSafeEqual(Buffer.from(authorization), Buffer.from(`Bearer ${expectedToken}`));
    const pathname = (req.url || '/').split('?')[0];
    if (!browser && (pathname === '/api' || pathname.startsWith('/api/'))) {
      if (authorization && !bearerMatches(token)) return fail(401, 'UNAUTHORIZED', 'Bearer anahtarı eşleşmiyor.');
      if (!['GET', 'POST'].includes(req.method)) return fail(405, 'METHOD_NOT_ALLOWED', 'GET veya POST kullanın.');
      if (req.method === 'POST' && !/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) return fail(415, 'CONTENT_TYPE', 'JSON isteği gerekli.');
      if (inflight >= 128) return fail(429, 'BUSY', 'Çok fazla eşzamanlı istek var. Biraz sonra deneyin.');
      inflight++;
      res.once('close', () => { inflight--; });
      let url;
      try { url = new URL(req.url, `http://127.0.0.1:${actualPort}`); } catch { return fail(400, 'INVALID_URL', 'Geçersiz adres.'); }
      const readBody = async () => {
        const parts = [];
        for await (const chunk of req) parts.push(chunk);
        const text = Buffer.concat(parts).toString('utf8').trim();
        if (!text) return {};
        try { return JSON.parse(text); } catch { throw new PoolError('INVALID_JSON', 'Geçerli JSON gönderin.'); }
      };
      const taskHeader = req.headers['x-pool-task'];
      const tools = poolTools(pool, { worker: req.headers['x-pool-worker'] === '1', taskToken: typeof taskHeader === 'string' && /^[a-f0-9]{64}$/.test(taskHeader) ? taskHeader : null, cachedOnly: !authorization });
      let status, body;
      try { ({ status, body } = await handleApi({ pool, tools, invoke: invokeTool, method: req.method, url, authorized: Boolean(authorization), readBody, port: actualPort })); }
      catch (error) {
        const envelope = errorEnvelope(error);
        const code = envelope.error.code;
        status = code === 'INVALID_REQUEST' || code === 'INVALID_JSON' || code === 'INVALID_URL' || code === 'INVALID_WORKSPACE' ? 400
          : code === 'REQUEST_TOO_LARGE' ? 413
          : /NOT_FOUND|UNKNOWN_TOOL/.test(code) ? 404
          : code === 'OWNER_ONLY' || code === 'WORKSPACE_DENIED' || code === 'PAID_ROUTE_DENIED' || code === 'READ_PATH_DENIED' ? 403
          : code === 'SHUTTING_DOWN' ? 503
          : code === 'INTERNAL_ERROR' ? 500 : 409;
        body = envelope;
      }
      if (res.writableEnded) return;
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      return res.end(url.searchParams.get('pretty') === '1' ? JSON.stringify(body, null, 2) : JSON.stringify(body));
    }
    const manage = req.url === '/manage' && management;
    const expected = `Bearer ${manage ? management.token : token}`;
    if (!browser && (Buffer.byteLength(authorization) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(authorization), Buffer.from(expected)))) return fail(401, 'UNAUTHORIZED', 'Yerel MCP erişim anahtarı gerekli.');
    if (req.url !== '/mcp' && !manage && !browser) return fail(404, 'NOT_FOUND', 'İstenen arayüz bulunamadı.');
    if (req.method !== 'POST') return fail(405, 'METHOD_NOT_ALLOWED', 'Bu arayüz POST isteği kabul eder.');
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) return fail(415, 'CONTENT_TYPE', 'JSON isteği gerekli.');
    if (inflight >= 128) return fail(429, 'BUSY', 'Çok fazla eşzamanlı istek var. Biraz sonra deneyin.');
    inflight++;
    res.once('close', () => { inflight--; });
    const chunks = [];
    try {
      for await (const chunk of req) {
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return fail(400, 'INVALID_JSON', 'Geçerli JSON gönderin.'); }
      if (manage || browser) {
        if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(400, 'INVALID_JSON', 'JSON nesnesi gönderin.');
        try {
          const value = browser
            ? await ui.operation(body)
            : body.operation === 'pair_ui'
              ? { status: 'listening', version, endpoint: `http://127.0.0.1:${actualPort}/mcp`, dashboard: ui?.launchURL(actualPort), ...(ui?.needsReauth() ? { reauthNeeded: true } : {}) }
              : await managementOperation(pool, management, body);
          const serialized = JSON.stringify(value);
          const renewed = browser ? ui.refreshCookie(req, actualPort) : null;
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...(renewed ? { 'Set-Cookie': renewed } : {}) });
          res.end(serialized);
        } catch (error) { fail(error instanceof PoolError ? 409 : 400, error instanceof PoolError ? error.code : 'INVALID_CONFIG', error instanceof PoolError ? error.message : 'Ayarlar geçersiz. Girdiğiniz değerleri kontrol edin.'); }
        return;
      }
      const taskHeader = req.headers['x-pool-task'];
      const mcp = mcpServer(pool, { worker: req.headers['x-pool-worker'] === '1', taskToken: typeof taskHeader === 'string' && /^[a-f0-9]{64}$/.test(taskHeader) ? taskHeader : null });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.once('close', () => { void mcp.close(); });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch { if (!res.writableEnded) fail(500, 'INTERNAL_ERROR', 'İstek tamamlanamadı. Yeniden bağlanın.'); }
  });
  server.requestTimeout = 0;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 32;
  return { server, uiURL: () => ui?.launchURL(server.address()?.port), listen: () => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); pool.schedule(); resolve(server.address()); });
  }) };
}
