import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

export async function stdioBridge(directory, config) {
  const token = readFileSync(path.join(directory, 'access-token'), 'utf8').trim();
  const client = new Client({ name: 'cli-agent-pool-stdio', version: '0.1.0' });
  const server = new Server({ name: 'cli-agent-pool', version: '0.1.0' }, { capabilities: { tools: {} } });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${config.port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  server.setRequestHandler(ListToolsRequestSchema, () => client.listTools());
  server.setRequestHandler(CallToolRequestSchema, request => client.callTool(request.params));
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const close = async () => { await server.close(); await client.close(); };
  process.stdin.once('end', () => { void close(); });
  process.once('SIGTERM', () => { void close(); });
  return close;
}
