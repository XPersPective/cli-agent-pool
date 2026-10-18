import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { randomBytes } from 'node:crypto';
import { configSchema } from '../src/config.js';
import { discover } from '../src/adapters.js';
import { Store } from '../src/store.js';
import { Pool } from '../src/pool.js';
import { createServer } from '../src/server.js';

if (process.argv[2] !== '--live' || !process.argv[3]) {
  console.error('Explicit live subscription test: node scripts/smoke.js --live <available-codex-model>. This consumes subscription quota.');
  process.exit(1);
}
const executable = discover().find(cli => cli.adapter === 'codex')?.executable;
if (!executable) throw new Error('Codex CLI missing');
const root = mkdtempSync(path.join(tmpdir(), 'pool-live-'));
const config = configSchema.parse({ workspaceRoots: [process.cwd()], routes: [{ id: 'codex-smoke', adapter: 'codex', executable, enabled: true, billing: 'subscription', models: [{ id: process.argv[3], alias: 'Live verification', group: 'unassigned', efforts: ['low'], kinds: ['text'] }] }] });
const store = new Store(path.join(root, 'pool.sqlite'));
const pool = new Pool(config, store);
const token = randomBytes(32).toString('hex');
const app = createServer(pool, token, 0);
const client = new Client({ name: 'cli-agent-pool-live-smoke', version: '0.1.0' });
try {
  const address = await app.listen();
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  const response = await client.callTool({ name: 'pool_submit', arguments: { prompt: 'Do not use any tools. Respond with exactly POOL_SMOKE_OK and nothing else.', workspace: process.cwd(), kind: 'text', effort: 'low', timeoutSeconds: 90, idempotencyKey: 'live-verification-' + randomBytes(8).toString('hex') } });
  if (response.isError) throw new Error('Live submission rejected');
  const id = response.structuredContent.data.id;
  for (let i = 0; i < 110; i++) {
    const result = await client.callTool({ name: 'pool_get_task', arguments: { taskId: id } });
    const task = result.structuredContent.data;
    if (task.state === 'succeeded') {
      if (task.result.trim() !== 'POOL_SMOKE_OK') throw new Error('Unexpected live result; content omitted');
      console.log('PASS: MCP -> persistent pool -> authenticated Codex CLI -> exact expected result.');
      break;
    }
    if (['failed', 'timed_out', 'needs_review', 'cancelled'].includes(task.state)) throw new Error(`Live verification failed: ${task.error}`);
    if (i === 109) throw new Error('Live verification did not finish');
    await delay(1000);
  }
} finally {
  await client.close(); app.server.close(); app.server.closeAllConnections(); await pool.close(); store.close();
  rmSync(root, { recursive: true, force: true });
}
