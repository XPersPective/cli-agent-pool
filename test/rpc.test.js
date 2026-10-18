import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { rpcRequest } from '../src/rpc.js';

test('JSON RPC accepts Unicode stdin and exposes only agent tools with bounded requests', async () => {
  const request = { tool: 'pool_submit', arguments: { prompt: 'Türkçe 🎤 görev' } };
  const bytes = Buffer.from(JSON.stringify(request));
  assert.deepEqual(await rpcRequest(Readable.from([...bytes].map(byte => Buffer.from([byte])))), request);
  for (const input of ['{', '{}', '{"tool":"save","arguments":{}}', '{"tool":"pool_list_models","arguments":[]}', JSON.stringify({ ...request, token: 'forbidden' }), 'x'.repeat(1_000_001)])
    await assert.rejects(rpcRequest(Readable.from([input])), { code: 'INVALID_REQUEST' });
});
