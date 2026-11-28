// Plain HTTP JSON surface for agents: one curl/fetch per question, no MCP
// handshake, no tool schema loading. Read-only metadata is open on loopback;
// task reads/writes and generic tool calls need the private Bearer token.
import { PoolError } from './config.js';
import { compactModel } from './catalog.js';
import { version } from './version.js';

// Tools whose results are cached metadata only (no live CLI spawns or filesystem
// probing). Account emails are stripped unless the caller presents the Bearer token.
export const publicTools = new Set(['pool_help', 'pool_get_policy', 'pool_catalog', 'pool_list_models', 'pool_list_pools',
  'pool_quota_overview', 'pool_capabilities', 'pool_select', 'pool_list_connections']);

const numeric = new Set(['limit', 'offset', 'after', 'minRemainingPercent', 'timeoutSeconds']);
const booleans = new Set(['compact', 'force', 'activeFirst']);
const arrays = new Set(['readPaths', 'capabilities']);
const aliases = Object.assign(Object.create(null), { route: 'routeId', model: 'modelId', category: 'group', q: 'query' });
const ignored = new Set(['pretty', 'live']);

export function queryArguments(searchParams) {
  const args = {};
  for (const key of new Set(searchParams.keys())) {
    if (ignored.has(key)) continue;
    const name = Object.hasOwn(aliases, key) ? aliases[key] : key;
    const values = searchParams.getAll(key);
    if (arrays.has(name)) args[name] = values;
    else if (numeric.has(name) && /^-?\d+(?:\.\d+)?$/.test(values[0])) args[name] = Number(values[0]);
    else if (booleans.has(name) && /^(?:1|0|true|false)$/i.test(values[0])) args[name] = /^(?:1|true)$/i.test(values[0]);
    else args[name] = values[0];
  }
  return args;
}

export function stripEmails(value) {
  if (Array.isArray(value)) return value.map(stripEmails);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'email').map(([key, item]) => [key, stripEmails(item)]));
}

export const apiIndex = port => ({
  service: 'cli-agent-pool', version, base: `http://127.0.0.1:${port}/api`,
  open: {
    'GET /api/health': 'service up + counts',
    'GET /api/pools': 'primary discovery: categories; /api/pools/<id> -> category model page',
    'GET /api/catalog': 'pool-only sources (owner-assigned categories only); ?billing=free|subscription|... &adapter= &q= &kind=text|read|write &route= &limit= &offset= -> model page',
    'GET /api/model?route=R&model=M': 'one pooled model with cached quota',
    'GET /api/quotas': 'cached quota per connection; /api/quotas/<routeId> windows; ?live=1 asks the CLI',
    'GET /api/select?kind=write&mode=execute[&group=]': 'recommend a pooled model without starting (explicit group strictly enforces category)',
    'GET /api/help[?code=X]': 'service map or recovery for one error code',
    'GET /api/capabilities': 'optional task contracts',
    'GET /api/connections': 'enabled connections',
  },
  token: {
    header: 'Authorization: Bearer <access-token file in data directory>; or use the cli-agent-pool CLI (handles it)',
    'POST /api/tasks': 'pool_submit body {prompt,workspace,kind,mode?,routeId?,modelId?,group?,effort?,idempotencyKey}',
    'GET /api/tasks/<id>': 'compact task state/result (?compact=0 full)',
    'GET /api/tasks': 'history (?limit=&offset=)',
    'POST /api/tasks/<id>/cancel': 'cancel',
    'POST /api/tools/<tool>': 'any pool tool, JSON body = arguments',
  },
  notes: 'Responses are compact JSON; errors are {error:{code,message,help}}. Pages: limit<=40 (default 12), nextOffset -> offset.',
});

function route(method, segments, url) {
  if (segments.length > 3) return null;
  const [head, id, action] = segments;
  const get = method === 'GET', post = method === 'POST';
  const args = queryArguments(url.searchParams);
  if (!head && get) return { index: true };
  if (head === 'health' && get && !id) return { health: true };
  if (head === 'catalog' && get && !id) return { tool: 'pool_catalog', args };
  if (head === 'models' && get && !id) return { tool: 'pool_catalog', args: { view: 'models', ...args } };
  if (head === 'pools' && get && !action) return { tool: 'pool_list_pools', args: id ? { ...args, group: id } : args };
  if (head === 'model' && get && !id) return { model: args };
  if (head === 'quotas' && get && !action) {
    if (id && url.searchParams.get('live') === '1') return { tool: 'pool_get_quotas', args: { routeId: id }, token: true };
    return { tool: 'pool_quota_overview', args: id ? { routeId: id } : {} };
  }
  if (head === 'select' && get && !id) return { tool: 'pool_select', args: { kind: 'read', ...args } };
  if (head === 'help' && get && !action) return { tool: 'pool_help', args: id ? { code: id } : args };
  if (head === 'capabilities' && get && !id) return { tool: 'pool_capabilities', args: {} };
  if (head === 'connections' && get && !id) return { tool: 'pool_list_connections', args: {} };
  if (head === 'tasks') {
    if (!id && get) return { tool: 'pool_list_tasks', args, token: true };
    if (!id && post) return { tool: 'pool_submit', body: true, token: true };
    if (id && !action && get) return { tool: 'pool_get_task', args: { ...args, taskId: id }, token: true };
    if (id && action === 'cancel' && post) return { tool: 'pool_cancel_task', args: { taskId: id }, token: true };
  }
  if (head === 'tools' && id && !action) {
    if (post) return { tool: id, body: true, token: true };
    if (get && publicTools.has(id)) return { tool: id, args };
  }
  return null;
}

// Returns {status, body}. `tools` is the shared poolTools() table for this caller.
export async function handleApi({ pool, tools, invoke, method, url, authorized, readBody, port }) {
  let segments;
  try { segments = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean).map(decodeURIComponent); }
  catch { throw new PoolError('INVALID_URL', 'Geçersiz adres kodlaması.'); }
  const target = route(method, segments, url);
  if (!target) return { status: 404, body: { error: { code: 'NOT_FOUND', message: 'Bilinmeyen API yolu. GET /api uç noktaları listeler.' } } };
  if (target.index) return { status: 200, body: apiIndex(port) };
  if (target.health) {
    const enabled = pool.config.routes.filter(r => r.enabled);
    return { status: 200, body: { status: 'ok', version, connections: enabled.length, models: pool.pooledModels().filter(m => m.enabled).length, active: pool.active.size } };
  }
  if ((target.token || (target.tool && !publicTools.has(target.tool))) && !authorized)
    return { status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'Bu uç nokta Bearer access-token ister; görevler için cli-agent-pool CLI kullanılabilir.' } } };
  if (target.model) {
    const { routeId, modelId } = target.model;
    if (!routeId || !modelId) throw new PoolError('INVALID_REQUEST', 'route ve model sorgu alanları gerekli (örn. /api/model?route=codex-local&model=gpt-5; arama için /api/pools veya /api/catalog?q=...).');
    const model = pool.pooledModels().find(m => m.enabled && m.routeId === routeId && m.id === modelId);
    if (!model) {
      const inCatalog = pool.catalogModels().some(m => m.enabled && m.routeId === routeId && m.id === modelId);
      if (inCatalog) {
        throw new PoolError('MODEL_NOT_IN_POOL', 'Model hiçbir havuz kategorisine eklenmemiş. Dış ajanlar yalnızca havuzdaki modelleri sorgulayabilir ve çağırabilir.');
      }
      throw new PoolError('MODEL_NOT_FOUND', 'Model havuzda bulunamadı, kapalı veya gizli.');
    }
    const value = compactModel(pool, model);
    return { status: 200, body: authorized ? value : stripEmails(value) };
  }
  const args = target.body ? await readBody() : target.args;
  const value = await invoke(tools, target.tool, args);
  return { status: 200, body: authorized ? value : stripEmails(value) };
}
