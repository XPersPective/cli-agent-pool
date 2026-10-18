import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ensureInitialized, ensureDaemon } from './daemon.js';
import { version } from './version.js';

export async function stdioBridge(directory, config) {
  if (!existsSync(path.join(directory, 'access-token'))) {
    config = ensureInitialized(directory, true);
  }
  const token = readFileSync(path.join(directory, 'access-token'), 'utf8').trim();
  const makeClient = () => new Client({ name: 'cli-agent-pool-stdio', version });
  const makeTransport = () => new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${config.port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  let client = makeClient();
  try {
    await client.connect(makeTransport());
  } catch {
    await ensureDaemon(directory, config);
    client = makeClient();
    await client.connect(makeTransport());
  }
  const server = new Server({ name: 'cli-agent-pool', version }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => client.listTools());
  server.setRequestHandler(CallToolRequestSchema, request => client.callTool(request.params));
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const close = async () => { await server.close(); await client.close(); };
  process.stdin.once('end', () => { void close(); });
  process.once('SIGTERM', () => { void close(); });
  return close;
}
