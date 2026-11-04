import { z } from 'zod';
import { PoolError } from './config.js';
import { quotaApplies } from '../web/pool-state.js';

const page = { limit: z.number().int().min(1).max(40).default(12), offset: z.number().int().min(0).max(100000).default(0) };
const kind = z.enum(['text', 'read', 'write']).optional();
export const catalogSchema = z.object({
  view: z.enum(['overview', 'models']).optional(), kind,
  billing: z.enum(['subscription', 'token_plan', 'free_credits', 'free', 'paid_api', 'unknown']).optional(),
  routeId: z.string().max(100).optional(), adapter: z.string().max(100).optional(),
  query: z.string().trim().max(100).optional(), ...page,
}).strict();
export const categoryQuerySchema = z.object({ group: z.string().min(1).max(64).optional(), kind, ...page }).strict();

function quotaSummary(pool, model) {
  const q = pool.store.quota(model.routeId);
  if (!q) return { status: 'unknown' };
  const applicable = (q.windows || []).filter(w => quotaApplies(w, model.id) && Number.isFinite(w.remainingPercent));
  const tightest = applicable.sort((a, b) => a.remainingPercent - b.remainingPercent)[0];
  return { status: q.status, ...(tightest ? { remainingPercent: tightest.remainingPercent, resetsAt: tightest.resetsAt ?? null } : {}),
    observedAt: q.observedAt, stale: Date.now() - Date.parse(q.observedAt) >= 60000 };
}
export function compactModel(pool, model) {
  return { routeId: model.routeId, ...(model.account && model.account !== 'default' ? { account: model.account } : {}), modelId: model.id, name: model.alias,
    ...(model.group && model.group !== 'unassigned' ? { category: model.group } : { categories: model.categories || [] }),
    ...(model.defaultEffort ? { effort: model.defaultEffort } : {}),
    ...(model.efforts.length ? { efforts: model.efforts } : {}), kinds: model.kinds, billing: model.billing,
    quota: quotaSummary(pool, model) };
}
const paginate = (items, request) => ({ total: items.length, nextOffset: request.offset + request.limit < items.length ? request.offset + request.limit : null });

// Discovery reads cached metadata only; no CLI/model invocation.
export function compactCatalog(pool, input = {}) {
  const request = catalogSchema.parse(input), query = request.query?.toLowerCase();
  const all = pool.catalogModels().filter(m => m.enabled);
  if (!request.view && !request.kind && !request.billing && !request.routeId && !request.adapter && !request.query) {
    const sources = [...new Set(all.map(m => m.billing))].map(billing => ({ billing, count: all.filter(m => m.billing === billing).length }));
    const providers = [...new Set(all.map(m => m.adapter))].map(adapter => ({ adapter, count: all.filter(m => m.adapter === adapter).length }));
    return { total: all.length, sources, providers, next: { tool: 'pool_catalog', arguments: { view: 'models', limit: 12 } } };
  }
  const matches = all.filter(m => (!request.kind || m.kinds.includes(request.kind)) &&
    (!request.billing || m.billing === request.billing) && (!request.routeId || m.routeId === request.routeId) &&
    (!request.adapter || m.adapter === request.adapter) && (!query || [m.id, m.alias, m.adapter, m.routeId].some(s => s?.toLowerCase().includes(query))));
  return { ...paginate(matches, request), models: matches.slice(request.offset, request.offset + request.limit).map(m => compactModel(pool, m)) };
}
export function categoryPage(pool, input = {}) {
  const request = categoryQuerySchema.parse(input);
  const models = pool.models().filter(m => m.enabled && (!request.kind || m.kinds.includes(request.kind)));
  if (request.group) {
    const category = pool.config.categories.find(c => c.id === request.group);
    if (!category) throw new PoolError('CATEGORY_NOT_FOUND', 'Kategori bulunamadı.');
    const matches = models.filter(m => m.group === request.group);
    return { category, ...paginate(matches, request), models: matches.slice(request.offset, request.offset + request.limit).map(m => compactModel(pool, m)) };
  }
  const categories = pool.config.categories.map(c => ({ ...c, count: models.filter(m => m.group === c.id).length }));
  return { ...paginate(categories, request), categories: categories.slice(request.offset, request.offset + request.limit) };
}
