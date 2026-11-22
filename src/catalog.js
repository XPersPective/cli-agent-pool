import { z } from 'zod';
import { PoolError } from './config.js';
import { quotaApplies, cleanModelDisplayName, sortEfforts } from '../web/pool-state.js';

const page = { limit: z.number().int().min(1).max(40).default(12), offset: z.number().int().min(0).max(100000).default(0) };
const kind = z.enum(['text', 'read', 'write']).optional();
export const catalogSchema = z.object({
  view: z.enum(['overview', 'models']).optional(), kind,
  billing: z.enum(['subscription', 'token_plan', 'free_credits', 'free', 'paid_api', 'unknown']).optional(),
  routeId: z.string().max(100).optional(), adapter: z.string().max(100).optional(),
  query: z.string().trim().max(100).optional(), ...page,
}).strict();
export const categoryQuerySchema = z.object({ group: z.string().min(1).max(64).optional(), kind, ...page }).strict();
export const quotaOverviewSchema = z.object({ routeId: z.string().max(100).optional() }).strict();

// Cached per-connection status for quick agent checks; never invokes a CLI.
export function quotaOverview(pool, input = {}) {
  const request = quotaOverviewSchema.parse(input);
  const routes = pool.config.routes.filter(r => r.enabled && (!request.routeId || r.id === request.routeId));
  if (request.routeId && !routes.length) throw new PoolError('NOT_FOUND', 'Bağlantı bulunamadı veya kapalı.');
  const models = pool.catalogModels().filter(m => m.enabled);
  const duplicateRoutes = typeof pool.duplicateRouteMap === 'function' ? pool.duplicateRouteMap() : new Map();
  const connections = routes.map(route => {
    const q = pool.store.quota(route.id);
    const duplicateOf = duplicateRoutes.get(route.id) || null;
    const windows = (q?.windows || []).filter(w => Number.isFinite(w.remainingPercent));
    const tightest = [...windows].sort((a, b) => a.remainingPercent - b.remainingPercent)[0];
    return { routeId: route.id, adapter: route.adapter, billing: route.billing,
      ...(route.profile ? { account: route.profile } : {}), ...(q?.email ? { email: q.email } : {}),
      ...(duplicateOf ? { duplicateOf, note: `Paylaşımlı oturum ${duplicateOf} ile aynı hesaba geçti; kopya modeller gizlendi. Ayarlar'dan izole profile geçin.` } : {}),
      models: duplicateOf ? 0 : models.filter(m => m.routeId === route.id).length,
      status: duplicateOf ? 'duplicate_account' : (q?.status || 'unknown'),
      ...(tightest ? { remainingPercent: tightest.remainingPercent, resetsAt: tightest.resetsAt ?? null } : {}),
      ...(q ? { observedAt: q.observedAt, stale: Date.now() - Date.parse(q.observedAt) >= 60000 } : {}),
      ...(request.routeId ? { windows: windows.map(w => ({ name: w.name, remainingPercent: w.remainingPercent, resetsAt: w.resetsAt ?? null, ...(w.models?.length ? { models: w.models } : {}) })) } : {}) };
  });
  return { total: connections.length, connections, live: 'pool_get_quotas {routeId} or GET /api/quotas/<routeId>?live=1' };
}

function quotaSummary(pool, model) {
  const q = pool.store.quota(model.routeId);
  if (!q) return { status: 'unknown' };
  const applicable = (q.windows || []).filter(w => quotaApplies(w, model.id) && Number.isFinite(w.remainingPercent));
  const tightest = applicable.sort((a, b) => a.remainingPercent - b.remainingPercent)[0];
  return { status: q.status, ...(tightest ? { remainingPercent: tightest.remainingPercent, resetsAt: tightest.resetsAt ?? null } : {}),
    observedAt: q.observedAt, stale: Date.now() - Date.parse(q.observedAt) >= 60000 };
}
export function compactModel(pool, model) {
  const email = pool.store.quota(model.routeId)?.email;
  const sortedEfforts = sortEfforts(model.efforts);
  return { routeId: model.routeId, ...(model.account && model.account !== 'default' ? { account: model.account } : {}), ...(email ? { email } : {}), modelId: model.id, name: cleanModelDisplayName(model.id, model.alias),
    ...(model.group && model.group !== 'unassigned' ? { category: model.group } : { categories: model.categories || [] }),
    ...(model.defaultEffort && model.defaultEffort !== 'default' ? { effort: model.defaultEffort } : {}),
    ...(sortedEfforts.length ? { efforts: sortedEfforts } : {}), kinds: model.kinds, billing: model.billing,
    quota: quotaSummary(pool, model) };
}
const paginate = (items, request) => ({ total: items.length, nextOffset: request.offset + request.limit < items.length ? request.offset + request.limit : null });

// Discovery reads cached metadata only; no CLI/model invocation.
export function compactCatalog(pool, input = {}) {
  const request = catalogSchema.parse(input), query = request.query?.toLowerCase();
  const duplicateRoutes = typeof pool.duplicateRouteMap === 'function' ? pool.duplicateRouteMap() : new Map();
  const all = pool.catalogModels().filter(m => m.enabled && (request.routeId ? true : !duplicateRoutes.has(m.routeId)));
  if (!request.view && !request.kind && !request.billing && !request.routeId && !request.adapter && !request.query) {
    const sources = [...new Set(all.map(m => m.billing))].map(billing => ({ billing, count: all.filter(m => m.billing === billing).length }));
    const providers = [...new Set(all.map(m => m.adapter))].map(adapter => ({ adapter, count: all.filter(m => m.adapter === adapter).length }));
    return { total: all.length, sources, providers, next: { tool: 'pool_catalog', arguments: { view: 'models', limit: 12 } } };
  }
  const matches = all.filter(m => (!request.kind || m.kinds.includes(request.kind)) &&
    (!request.billing || m.billing === request.billing) && (!request.routeId || m.routeId === request.routeId) &&
    (!request.adapter || m.adapter === request.adapter) && (!query || [m.id, m.alias, cleanModelDisplayName(m.id, m.alias), m.adapter, m.routeId].some(s => s?.toLowerCase().includes(query))));
  return { ...paginate(matches, request), models: matches.slice(request.offset, request.offset + request.limit).map(m => compactModel(pool, m)) };
}
export function categoryPage(pool, input = {}) {
  const request = categoryQuerySchema.parse(input);
  const duplicateRoutes = typeof pool.duplicateRouteMap === 'function' ? pool.duplicateRouteMap() : new Map();
  const models = pool.models().filter(m => m.enabled && !duplicateRoutes.has(m.routeId) && (!request.kind || m.kinds.includes(request.kind)));
  if (request.group) {
    const category = pool.config.categories.find(c => c.id === request.group);
    if (!category) throw new PoolError('CATEGORY_NOT_FOUND', 'Kategori bulunamadı.');
    const matches = models.filter(m => m.group === request.group);
    return { category, ...paginate(matches, request), models: matches.slice(request.offset, request.offset + request.limit).map(m => compactModel(pool, m)) };
  }
  const categories = pool.config.categories.map(c => ({ ...c, count: models.filter(m => m.group === c.id).length }));
  return { ...paginate(categories, request), categories: categories.slice(request.offset, request.offset + request.limit) };
}
