import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { PoolError, configView, saveConfig } from './config.js';
import { taskSchema } from './pool.js';

export function mcpServer(pool) {
  const server = new McpServer({ name: 'cli-agent-pool', version: '0.1.0' });
  const register = (name, description, inputSchema, callback, readOnly = true) => server.registerTool(name, {
    description, inputSchema, annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: readOnly, openWorldHint: !readOnly },
  }, async input => {
    try {
      const value = await callback(input);
      return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: { data: value } };
    } catch (error) {
      const known = error instanceof PoolError;
      return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: { code: known ? error.code : 'INTERNAL_ERROR', message: known ? error.message : 'İşlem tamamlanamadı. Yerel servis durumunu kontrol edin.' } }) }] };
    }
  });
  register('pool_list_connections', 'List configured CLI routes without credentials or account identifiers.', {}, () => pool.config.routes.map(({ id, adapter, enabled, billing }) => ({ id, adapter, enabled, billing, auth: 'unknown' })));
  register('pool_list_models', 'List configured models. Manual groups are authoritative.', {}, () => pool.models());
  register('pool_get_policy', 'Read immutable admission policy. Agents cannot change it.', {}, () => ({ concurrency: pool.config.concurrency, automaticRetry: false, overlappingWorkspaces: 'serialized', unknownQuota: 'bounded-task', billing: 'subscription-only', maxQueued: 100, maxTimeoutSeconds: 3600 }));
  register('pool_select', 'Recommend an allowed model without starting a task.', { kind: z.enum(['text', 'read', 'write']), routeId: z.string().optional(), modelId: z.string().optional(), group: z.string().optional(), effort: z.string().optional() }, input => pool.select(input));
  register('pool_submit', 'Start one bounded CLI task. Reuse the same idempotency key when retrying a lost response. Write tasks may change workspace files.', taskSchema.shape, input => pool.submit(input), false);
  register('pool_get_task', 'Read task state, result and at most 100 events after a cursor.', { taskId: z.string().uuid(), after: z.number().int().min(0).default(0) }, ({ taskId, after }) => pool.get(taskId, after));
  register('pool_list_tasks', 'Read paginated local task history.', { limit: z.number().int().min(1).max(100).default(50), offset: z.number().int().min(0).max(1_000_000).default(0) }, ({ limit, offset }) => pool.list(limit, offset));
  register('pool_cancel_task', 'Request cancellation and wait for subsequent task state to confirm it.', { taskId: z.string().uuid() }, ({ taskId }) => pool.cancel(taskId), false);
  register('pool_get_quotas', 'Query vendor quota through the installed CLI. Unsupported quotas remain unknown.', { routeId: z.string() }, ({ routeId }) => pool.getQuota(routeId));
  return server;
}

export function createServer(pool, token, port = pool.config.port, management) {
  if (!/^[a-f0-9]{64}$/.test(token)) throw new PoolError('INVALID_TOKEN', 'Erişim anahtarı geçersiz. Yerel kurulumu kontrol edin.');
  if (management && !/^[a-f0-9]{64}$/.test(management.token)) throw new PoolError('INVALID_TOKEN', 'Yönetim anahtarı geçersiz. Yerel kurulumu kontrol edin.');
  let inflight = 0;
  const server = http.createServer(async (req, res) => {
    const fail = (status, code, message) => { if (!res.headersSent) res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ error: { code, message } })); };
    const actualPort = server.address()?.port;
    if (req.headers.host !== `127.0.0.1:${actualPort}` || 'origin' in req.headers || 'sec-fetch-site' in req.headers) return fail(403, 'ORIGIN_DENIED', 'Bu bağlantı kaynağına izin verilmiyor.');
    const authorization = req.headers.authorization || '';
    const manage = req.url === '/manage' && management;
    const expected = `Bearer ${manage ? management.token : token}`;
    if (Buffer.byteLength(authorization) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(authorization), Buffer.from(expected))) return fail(401, 'UNAUTHORIZED', 'Yerel MCP erişim anahtarı gerekli.');
    if (req.url !== '/mcp' && !manage) return fail(404, 'NOT_FOUND', 'İstenen arayüz bulunamadı.');
    if (req.method !== 'POST') return fail(405, 'METHOD_NOT_ALLOWED', 'Bu arayüz POST isteği kabul eder.');
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) return fail(415, 'CONTENT_TYPE', 'JSON isteği gerekli.');
    if (inflight >= 16) return fail(429, 'BUSY', 'Çok fazla eşzamanlı istek var. Biraz sonra deneyin.');
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
      if (manage) {
        try {
          if (body.operation === 'save') {
            if (body.config?.port !== pool.config.port || body.config?.python !== pool.config.python) return fail(400, 'RESTART_REQUIRED', 'Port veya Python yolunu değiştirmek için servisi durdurup yerel ayarları değiştirin.');
            pool.config = saveConfig(management.directory, body.config, body.revision);
            pool.schedule();
          } else if (body.operation !== 'get') return fail(400, 'INVALID_OPERATION', 'Geçersiz yönetim işlemi.');
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify(configView(management.directory)));
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
  return { server, listen: () => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(server.address()); });
  }) };
}
