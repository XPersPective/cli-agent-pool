import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { dataDirectory, loadConfig } from '../../src/config.js';
import { discover } from '../../src/adapters.js';

const endpoints = ['snapshot', 'submit', 'task', 'cancel', 'settings', 'save', 'quota'];

export async function bridge(endpoint, payload) {
  const directory = dataDirectory();
  const config = loadConfig(directory);
  const base = `http://127.0.0.1:${config.port}`;
  if (endpoint === 'settings' || endpoint === 'save') {
    const token = readFileSync(path.join(directory, 'management-token'), 'utf8').trim();
    const response = await fetch(`${base}/manage`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(endpoint === 'settings' ? { operation: 'get' } : { operation: 'save', config: payload.config, revision: payload.revision }), signal: AbortSignal.timeout(15_000), redirect: 'error' });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error?.message || 'Ayarlar kaydedilemedi.');
    return value;
  }
  const client = new Client({ name: 'cli-agent-pool-dsh', version: '0.1.0' });
  const token = readFileSync(path.join(directory, 'access-token'), 'utf8').trim();
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    const call = async (name, args = {}) => {
      const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 25_000 });
      if (result.isError) throw new Error(JSON.parse(result.content[0].text).error.message);
      return result.structuredContent.data;
    };
    if (endpoint === 'snapshot') {
      const [connections, models, tasks] = await Promise.all([call('pool_list_connections'), call('pool_list_models'), call('pool_list_tasks', { limit: 50 })]);
      return { connections, models, tasks, installed: discover() };
    }
    const tools = { submit: 'pool_submit', task: 'pool_get_task', cancel: 'pool_cancel_task', quota: 'pool_get_quotas' };
    if (!tools[endpoint]) throw new Error('Geçersiz panel işlemi.');
    return await call(tools[endpoint], payload);
  } finally { await client.close(); }
}

export function apply(ctx) {
  ctx.inject(['connection'], connectionCtx => {
    const connection = connectionCtx.get('connection');
    for (const endpoint of endpoints) {
      const method = `cli-agent-pool.${endpoint}`;
      connectionCtx.effect(() => connection.fetch.register({
        path: `/api/${method}`, methods: ['POST'], requestBody: 'buffered',
        async fetch(request) {
          if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) return new Response(null, { status: 415 });
          const text = await request.text();
          if (Buffer.byteLength(text) > 262_144) return new Response(null, { status: 413 });
          let body;
          try { body = JSON.parse(text); } catch { return new Response(null, { status: 400 }); }
          if (body?.type !== 'client-request' || body.method !== method || typeof body.rpcId !== 'string' || body.rpcId.length > 128) return new Response(null, { status: 400 });
          let result;
          try { result = { ok: true, value: await bridge(endpoint, body.payload || {}) }; }
          catch { result = { ok: false, error: { code: 'pool-unavailable', message: 'Havuz işlemi tamamlanamadı. Servisi ve yerel ayarları kontrol edip yeniden deneyin.', details: {} } }; }
          return Response.json({ type: 'server-response', rpcId: body.rpcId, result }, { headers: { 'Cache-Control': 'no-store' } });
        },
      }), `cli-agent-pool: ${endpoint}`);
    }
  });
}
