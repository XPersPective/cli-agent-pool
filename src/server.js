import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { PoolError, configView } from './config.js';
import { browserUI, managementOperation } from './web.js';
import { taskSchema, groupAssignmentSchema } from './pool.js';
import { version } from './version.js';
import { compactTask } from './task-protocol.js';

export function mcpServer(pool) {
  const server = new McpServer({ name: 'cli-agent-pool', version });
  const register = (name, description, inputSchema, callback, readOnly = true) => server.registerTool(name, {
    description, inputSchema, annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: readOnly, openWorldHint: !readOnly },
  }, async input => {
    try {
      const value = await callback(input);
      return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: { data: value } };
    } catch (error) {
      const known = error instanceof PoolError;
      const invalid = error instanceof z.ZodError;
      return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: { code: known ? error.code : invalid ? 'INVALID_REQUEST' : 'INTERNAL_ERROR', message: known ? error.message : invalid ? 'İstek alanları geçersiz. Araç şemasını kontrol edin.' : 'İşlem tamamlanamadı. Yerel servis durumunu kontrol edin.' } }) }] };
    }
  });
  register('pool_list_connections', 'List configured CLI and API routes without credentials or account identifiers.', {}, () => pool.config.routes.map(({ id, adapter, enabled, billing, autoSelect, api }) => ({ id, adapter, enabled, billing, autoSelect: autoSelect ?? (billing !== 'paid_api'), protocol: api?.protocol || null, baseUrl: api?.baseUrl || null, auth: 'unknown' })));
  register('pool_list_pools', 'Read the three strength pools, their exact model IDs, mandatory effort rules and cached quota windows. In manual mode select a pool with group; do not override fixedEffort.', {}, () => pool.pools());
  register('pool_list_models', 'List configured models. Manual groups are authoritative.', {}, () => pool.models());
  register('pool_get_policy', 'Read admission policy and owner-controlled grouping permission. Read revision before assigning groups.', {}, () => ({ concurrency: pool.config.concurrency, groupingMode: pool.config.groupingMode, selectionMode: pool.config.selectionMode, strengthPools: ["high", "medium", "low"], fixedEffort: "owner-pool-effort-is-mandatory", revision: configView(pool.directory).revision, automaticRetry: false, overlappingWorkspaces: 'shared-read-exclusive-write', taskModes: ['response', 'execute'], executionReport: 'v1-json-6000-chars', unknownQuota: 'bounded-task', billing: 'explicit-route-billing', paidApiAutoSelect: 'opt-in', maxQueued: 100, maxTimeoutSeconds: 3600 }));
  register('pool_assign_groups', 'Assign model groups only when the owner enabled agent grouping. Cannot change billing, permissions or routes. Preserve owner groups unless asked to reclassify. Use the current policy revision.', groupAssignmentSchema.shape, input => pool.assignGroups(input), false);
  register('pool_select', 'Recommend an allowed model without starting a task. mode: execute requires write and native tool support. minRemainingPercent can raise the owner quota reserve, never lower it.', { kind: z.enum(['text', 'read', 'write']), mode: z.enum(['response', 'execute']).optional(), routeId: z.string().optional(), modelId: z.string().optional(), group: z.string().optional(), effort: z.string().optional(), minRemainingPercent: z.number().min(0).max(100).optional() }, input => pool.selectLive(input));
  register('pool_submit', 'Start one bounded CLI task. For implementation use kind: write, mode: execute and the calling project/worktree absolute workspace. Native tools perform edits and checks, then return a short report. Reuse the same idempotency key for a lost response; poll the returned ID, never replay a started write.', taskSchema.shape, input => pool.submitLive(input), false);
  register('pool_get_task', 'Read task state and result. compact: true omits prompt/events and bounds the report to reduce tokens. Queued is not failure; inspect queueReason/blockedBy.', { taskId: z.string().uuid(), after: z.number().int().min(0).default(0), compact: z.boolean().default(false) }, ({ taskId, after, compact }) => compact ? compactTask(pool.get(taskId, after)) : pool.get(taskId, after));
  register('pool_list_tasks', 'Read paginated local task history.', { limit: z.number().int().min(1).max(100).default(50), offset: z.number().int().min(0).max(1_000_000).default(0) }, ({ limit, offset }) => pool.list(limit, offset));
  register('pool_cancel_task', 'Request cancellation and wait for subsequent task state to confirm it.', { taskId: z.string().uuid() }, ({ taskId }) => pool.cancel(taskId), false);
  register('pool_get_quotas', 'Query vendor quota through the installed CLI. Unsupported quotas remain unknown.', { routeId: z.string() }, ({ routeId }) => pool.getQuota(routeId));
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
      if (req.headers.origin !== `http://127.0.0.1:${actualPort}` || !ui.authorized(req, actualPort)) return fail(403, 'UNAUTHORIZED', 'Yönetim oturumu geçersiz. Terminaldeki bağlantıdan yeniden açın.');
    } else if ('origin' in req.headers || 'sec-fetch-site' in req.headers) return fail(403, 'ORIGIN_DENIED', 'Bu bağlantı kaynağına izin verilmiyor.');
    const authorization = req.headers.authorization || '';
    const manage = req.url === '/manage' && management;
    const expected = `Bearer ${manage ? management.token : token}`;
    if (!browser && (Buffer.byteLength(authorization) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(authorization), Buffer.from(expected)))) return fail(401, 'UNAUTHORIZED', 'Yerel MCP erişim anahtarı gerekli.');
    if (req.url !== '/mcp' && !manage && !browser) return fail(404, 'NOT_FOUND', 'İstenen arayüz bulunamadı.');
    if (req.method !== 'POST') return fail(405, 'METHOD_NOT_ALLOWED', 'Bu arayüz POST isteği kabul eder.');
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) return fail(415, 'CONTENT_TYPE', 'JSON isteği gerekli.');
    if (inflight >= 128) return fail(429, 'BUSY', 'Çok fazla eşzamanlı istek var. Biraz sonra deneyin.');
    inflight++;
    res.once('close', () => { inflight--; });
    let bytes = 0;
    const chunks = [];
    try {
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 262_144) { fail(413, 'REQUEST_TOO_LARGE', 'İstek boyutu sınırı aşıldı.'); req.resume(); return; }
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return fail(400, 'INVALID_JSON', 'Geçerli JSON gönderin.'); }
      if (manage || browser) {
        try {
          const value = browser
            ? await ui.operation(body)
            : body.operation === 'pair_ui'
              ? { status: 'listening', version, endpoint: `http://127.0.0.1:${actualPort}/mcp`, dashboard: ui?.launchURL(actualPort) }
              : managementOperation(pool, management, body);
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify(value));
        } catch (error) { fail(error instanceof PoolError ? 409 : 400, error instanceof PoolError ? error.code : 'INVALID_CONFIG', error instanceof PoolError ? error.message : 'Ayarlar geçersiz. Girdiğiniz değerleri kontrol edin.'); }
        return;
      }
      const mcp = mcpServer(pool);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.once('close', () => { void mcp.close(); });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch { if (!res.writableEnded) fail(500, 'INTERNAL_ERROR', 'İstek tamamlanamadı. Yeniden bağlanın.'); }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 32;
  return { server, uiURL: () => ui?.launchURL(server.address()?.port), listen: () => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); pool.schedule(); resolve(server.address()); });
  }) };
}
