import { PoolError } from './config.js';

const tools = new Set(['pool_list_connections', 'pool_list_models', 'pool_list_pools', 'pool_get_policy', 'pool_select', 'pool_assign_groups', 'pool_submit', 'pool_get_task', 'pool_list_tasks', 'pool_cancel_task', 'pool_get_quotas']);

export async function rpcRequest(stream) {
  stream.setEncoding('utf8');
  let input = '';
  for await (const chunk of stream) {
    input += chunk.toString('utf8');
    if (Buffer.byteLength(input) > 1_000_000) throw new PoolError('INVALID_REQUEST', 'JSON isteği en fazla 1 MB olabilir.');
  }
  let request;
  try { request = JSON.parse(input); } catch { throw new PoolError('INVALID_REQUEST', 'stdin üzerinde geçerli JSON isteği gerekli.'); }
  if (!request || !tools.has(request.tool) || !request.arguments || typeof request.arguments !== 'object' || Array.isArray(request.arguments) || Object.keys(request).some(key => !['tool', 'arguments'].includes(key)))
    throw new PoolError('INVALID_REQUEST', 'İstek {tool, arguments} biçiminde bir ajan aracı çağrısı olmalı.');
  return request;
}
