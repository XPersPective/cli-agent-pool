import { isCategoryId } from './categories.js';
export function memberships(model) {
  return model.memberships ?? (['high', 'medium', 'low', 'free'].includes(model.group) ? [{ group: model.group, ...(model.defaultEffort ? { effort: model.defaultEffort } : {}) }] : []);
}

// Disabling a connection hides its catalog and memberships without deleting them.
// A model served by another enabled connection remains independently visible.
export function visibleRoutes(config) {
  return config.routes.filter(route => route.enabled);
}

export function mergeScanDraft(scanned, before, draft) {
  const merged = structuredClone(scanned);
  for (const route of draft.routes) {
    const target = merged.routes.find(item => item.id === route.id);
    const original = before.routes.find(item => item.id === route.id);
    if (!target) { if (!original) merged.routes.push(structuredClone(route)); continue; }
    if (!original) continue;
    for (const key of ['enabled', 'billing', 'autoSelect', 'trustedSettings', 'toolPolicy', 'priority', 'minRemainingPercent', 'api']) {
      if (JSON.stringify(route[key]) !== JSON.stringify(original[key])) {
        if (route[key] === undefined) delete target[key]; else target[key] = structuredClone(route[key]);
      }
    }
    for (const model of route.models) {
      const old = original.models.find(item => item.id === model.id);
      const resolved = target.models.find(item => item.id === model.id) || target.models.find(item => Object.values(item.variants || {}).includes(model.id)) || target.models.find(item => ['opus', 'sonnet', 'haiku'].includes(model.id) && item.id.startsWith(`claude-${model.id}-`));
      if (!old) { if (!resolved) target.models.push(structuredClone(model)); continue; }
      if (!resolved) continue;
      for (const key of ['memberships', 'group', 'enabled', 'defaultEffort', 'alias', 'order']) {
        if (JSON.stringify(model[key]) !== JSON.stringify(old[key])) {
          if(resolved.variants && resolved.id!==model.id && ['memberships','group','defaultEffort'].includes(key)) {
            const inferred=Object.entries(resolved.variants).find(([,id])=>id===model.id)?.[0];
            const previous=memberships(old), desired=memberships(model);
            const others=memberships(resolved).filter(member=>!previous.some(item=>item.group===member.group));
            resolved.memberships=[...others,...desired.map(member=>({...member,...(!member.effort && inferred?{effort:inferred}:{})}))];
            continue;
          }
          if (model[key] === undefined) delete resolved[key]; else resolved[key] = structuredClone(model[key]);
        }
      }
    }
  }
  for (const key of ['categories', 'workspaceRoots', 'modelFilters']) if (JSON.stringify(draft[key]) !== JSON.stringify(before[key])) merged[key] = structuredClone(draft[key]);
  return merged;
}
export function addMembership(model, group, effort = '', order = undefined) {
  if (!isCategoryId(group) || effort && !model.efforts.includes(effort)) throw new Error('Havuz veya efor seçimi geçersiz.');
  const existing = memberships(model).find(member => member.group === group);
  const nextOrder = Number.isInteger(order) ? order : existing?.order;
  if (existing && (existing.effort || '') === effort && existing.order === nextOrder) return false;
  model.memberships = memberships(model);
  let member = model.memberships.find(item => item.group === group);
  if (!member) { member = { group }; model.memberships.push(member); }
  if (effort) member.effort = effort; else delete member.effort;
  if (Number.isInteger(nextOrder)) member.order = nextOrder;
  return true;
}

export function modelSaveConfig(base, draft, routeId, modelId, enableRoute = false) {
  const config = structuredClone(base);
  const route = config.routes.find(item => item.id === routeId);
  const source = draft.routes.find(item => item.id === routeId);
  const model = source?.models.find(item => item.id === modelId);
  if (!route || !model) throw new Error('Önce modelin bağlantısını kaydedin.');
  const previous = route.models.find(item => item.id === modelId);
  if (previous) {
    for (const key of ['memberships', 'group', 'enabled', 'defaultEffort', 'order']) {
      if (model[key] === undefined) delete previous[key]; else previous[key] = structuredClone(model[key]);
    }
  } else route.models.push(structuredClone(model));
  if (enableRoute) route.enabled = true;
  return config;
}

export function batchModelSaveConfig(base, draft, targets, enableRoutes = false) {
  let config = structuredClone(base);
  for (const { routeId, modelId } of targets) {
    config = modelSaveConfig(config, draft, routeId, modelId, enableRoutes);
  }
  return config;
}

export function preferenceSaveConfig(base, draft, key) {
  if (!['categories', 'modelFilters'].includes(key)) throw new Error('Geçersiz havuz ayarı.');
  const next = { ...structuredClone(base), [key]: structuredClone(draft[key]) };
  return next;
}

export function quotaWindows(snapshot, modelId = '') {
  return (snapshot?.windows || []).filter(window => quotaApplies(window,modelId) && Number.isFinite(window.remainingPercent)).map(window => {
    const remaining = Math.max(0, Math.min(100, window.remainingPercent));
    return { ...window, remaining, used: 100 - remaining };
  });
}

export function quotaWindowPercent(snapshot, modelId = '', kind = 'min') {
  const wins = quotaWindows(snapshot, modelId);
  if (!wins.length) return null;
  if (kind === '5h') {
    const matched = wins.filter(w => ['five_hour', '5h', 'primary'].includes(w.name) || (Number.isFinite(w.windowMinutes) && w.windowMinutes <= 360));
    return Math.min(...(matched.length ? matched : wins).map(w => w.remaining));
  }
  if (kind === 'weekly') {
    const matched = wins.filter(w => ['seven_day', '7d', 'weekly', 'opus', 'secondary'].includes(w.name) || (Number.isFinite(w.windowMinutes) && w.windowMinutes >= 1440));
    return Math.min(...(matched.length ? matched : wins).map(w => w.remaining));
  }
  return Math.min(...wins.map(w => w.remaining));
}

const activeBillingSet = new Set(['subscription', 'token_plan', 'free_credits', 'free', 'paid_api']);
export function modelIssueInfo(route, model, snapshot, quotaError = '') {
  if (route && (!route.enabled || model?.enabled === false)) {
    return { state: 'disabled', level: 'disabled', badge: 'Devre dışı', isError: false, isUnknown: false, isDisabled: true };
  }
  if (route && !activeBillingSet.has(route.billing)) {
    return { state: 'billing_unconfirmed', level: 'error', badge: 'Plan doğrulanmadı', isError: true, isUnknown: false, isDisabled: false };
  }
  if (snapshot?.status === 'auth_required' || snapshot?.auth === 'missing' || snapshot?.auth === 'rejected') {
    return { state: 'auth_error', level: 'error', badge: 'Giriş gerekli', isError: true, isUnknown: false, isDisabled: false };
  }
  if (snapshot?.subscription === 'none' && ['subscription', 'token_plan'].includes(route?.billing)) {
    return { state: 'subscription_error', level: 'error', badge: 'Abonelik / Plan gerekli', isError: true, isUnknown: false, isDisabled: false };
  }
  if (snapshot?.status === 'error' || Boolean(quotaError)) {
    return { state: 'connection_error', level: 'error', badge: 'Bağlantı / Kota hatası', isError: true, isUnknown: false, isDisabled: false };
  }
  const wins = quotaWindows(snapshot, model?.id);
  if (snapshot?.status === 'rate_limited' || (wins.length > 0 && Math.min(...wins.map(w => w.remaining)) <= 0)) {
    return { state: 'quota_exhausted', level: 'error', badge: 'Kota tükendi (%0)', isError: true, isUnknown: false, isDisabled: false };
  }
  if (wins.length === 0) {
    return { state: 'quota_unknown', level: 'unknown', badge: 'Kota okunamıyor', isError: false, isUnknown: true, isDisabled: false };
  }
  return { state: 'healthy', level: 'ok', badge: 'Hazır', isError: false, isUnknown: false, isDisabled: false };
}

export function quotaMatches(snapshot, modelId, mode = 'all', route = null, model = null, quotaError = '') {
  if (mode === 'all') return true;
  const known = quotaWindows(snapshot, modelId).length > 0;
  if (mode === 'known') return known;
  if (mode === 'unknown') return !known;
  const issue = modelIssueInfo(route, model || { id: modelId }, snapshot, quotaError);
  if (mode === 'healthy') return known && !issue.isError && !issue.isDisabled;
  if (mode === 'issues') return issue.isError;
  if (mode === 'auth_error') return ['auth_error', 'subscription_error', 'billing_unconfirmed', 'connection_error'].includes(issue.state);
  if (mode === 'enabled') return !issue.isDisabled;
  if (mode === 'disabled') return issue.isDisabled;
  if (mode === 'quota_high') return (quotaWindowPercent(snapshot, modelId, 'min') ?? -1) >= 50;
  if (mode === 'quota_low') { const p = quotaWindowPercent(snapshot, modelId, 'min'); return p !== null && p < 20; }
  if (mode === '5h_high') return (quotaWindowPercent(snapshot, modelId, '5h') ?? -1) >= 50;
  if (mode === 'weekly_high') return (quotaWindowPercent(snapshot, modelId, 'weekly') ?? -1) >= 50;
  return true;
}

export function quotaApplies(window, modelId = '') {
  const id = modelId.toLowerCase();
  return !id || !window.models?.length || window.models.some(scope => ['gemini-flash', 'gemini-pro'].includes(scope) ? id.includes('gemini') && id.includes(scope.slice(7)) : id.includes(scope.toLowerCase()));
}

export function effortLabel(value) {
  return ({ low: 'Düşük', medium: 'Orta', high: 'Yüksek', xhigh: 'Çok yüksek', max: 'En yüksek', minimal: 'En az', none: 'Kapalı', default: 'Varsayılan' })[value] || value || 'CLI varsayılanı';
}

// Family names are navigation hints, not capability scores. Exact identities keep versions distinct.
export function modelIdentity(id) {
  return id.split('/').at(-1).toLowerCase().replace(/-(low|medium|high|xhigh|max)$/, '').replace(/(\d)[.](?=\d)/g, '$1-');
}
export function modelFamily(id) {
  const key = modelIdentity(id);
  return key.match(/(?:^|-)(argon|astra|sol|terra|luna|opus|sonnet|haiku)(?:-|$)/)?.[1] || key.match(/^(gemini|qwen|glm|kimi|mimo|deepseek|gpt-oss|gpt)(?:-|$)/)?.[1] || key.replace(/[-_.]?\d.*$/, '') || key;
}
export function modelFiltered(filters, routeId, modelId) {
  return (filters || []).some(rule => (!rule.routeId || rule.routeId === routeId) && (rule.match === 'family' ? modelFamily(modelId) === rule.value : rule.routeId ? modelId.toLowerCase() === rule.value.toLowerCase() : modelIdentity(modelId) === modelIdentity(rule.value)));
}
export function unhideModels(filters, routes, targets) {
  const targetKeys = new Set((targets || []).map(t => JSON.stringify([t.routeId, t.modelId])));
  if (!targetKeys.size) return structuredClone(filters || []);
  const next = [];
  const seen = new Set();
  const pushUnique = rule => {
    const key = JSON.stringify([rule.match, rule.routeId || '', rule.value]);
    if (seen.has(key)) return;
    seen.add(key);
    next.push(structuredClone(rule));
  };
  for (const rule of filters || []) {
    const matchesTarget = (routes || []).some(r => (r.models || []).some(m => targetKeys.has(JSON.stringify([r.id, m.id])) && modelFiltered([rule], r.id, m.id)));
    if (!matchesTarget) {
      pushUnique(rule);
      continue;
    }
    for (const r of routes || []) {
      for (const m of r.models || []) {
        if (targetKeys.has(JSON.stringify([r.id, m.id]))) continue;
        if (modelFiltered([rule], r.id, m.id)) {
          pushUnique({ match: 'model', value: m.id, routeId: r.id, ...(rule.reason ? { reason: rule.reason } : {}) });
        }
      }
    }
  }
  return next;
}
export function sortModels(entries, order = 'az', families = false, context = {}) {
  const { quotas = {}, emails = {}, quotaErrors = {}, group = '', categoryNames = {} } = context;
  const cmpName = (a, b, dir = 1) => dir * a.model.id.localeCompare(b.model.id, 'tr', { numeric: true }) || (a.route?.id || '').localeCompare(b.route?.id || '');
  if (order === 'az' || order === 'za') {
    const dir = order === 'za' ? -1 : 1;
    return [...entries].sort((a, b) => (families ? dir * modelIdentity(a.model.id).localeCompare(modelIdentity(b.model.id), 'tr', { numeric: true }) : 0) || cmpName(a, b, dir));
  }
  const quotaOf = (entry, kind = 'min') => quotaWindowPercent(quotas[entry.route?.id], entry.model?.id, kind);
  const emailOf = entry => (emails[entry.route?.id] || entry.route?.email || quotas[entry.route?.id]?.email || '').toLowerCase();
  const issueRank = entry => {
    const info = modelIssueInfo(entry.route, entry.model, quotas[entry.route?.id], quotaErrors[entry.route?.id]);
    return info.isError ? 0 : info.isUnknown ? 1 : info.isDisabled ? 2 : 3;
  };
  const manualOrderOf = entry => {
    if (group && group !== '__all__') {
      const m = memberships(entry.model).find(item => item.group === group);
      if (Number.isInteger(m?.order)) return m.order;
    }
    if (Number.isInteger(entry.model?.order)) return entry.model.order;
    const anyOrder = memberships(entry.model).find(item => Number.isInteger(item.order))?.order;
    return Number.isInteger(anyOrder) ? anyOrder : 999999;
  };
  const categoryOf = entry => {
    const g = memberships(entry.model)[0]?.group;
    return g ? (categoryNames[g] || g) : '~~~';
  };
  return [...entries].sort((a, b) => {
    if (order === 'manual') return manualOrderOf(a) - manualOrderOf(b) || cmpName(a, b);
    if (order === 'family') return modelFamily(a.model.id).localeCompare(modelFamily(b.model.id), 'tr', { numeric: true }) || modelIdentity(a.model.id).localeCompare(modelIdentity(b.model.id), 'tr', { numeric: true }) || cmpName(a, b);
    if (order === 'provider') return (a.route?.adapter || '').localeCompare(b.route?.adapter || '', 'tr') || (a.route?.billing || '').localeCompare(b.route?.billing || '', 'tr') || (a.route?.id || '').localeCompare(b.route?.id || '', 'tr') || cmpName(a, b);
    if (order === 'email') return (emailOf(a) || '~~~').localeCompare(emailOf(b) || '~~~', 'tr') || (a.route?.adapter || '').localeCompare(b.route?.adapter || '', 'tr') || cmpName(a, b);
    if (order === 'quota_desc') return (quotaOf(b, 'min') ?? -1) - (quotaOf(a, 'min') ?? -1) || issueRank(b) - issueRank(a) || cmpName(a, b);
    if (order === 'quota_asc') return (quotaOf(a, 'min') ?? 999) - (quotaOf(b, 'min') ?? 999) || issueRank(a) - issueRank(b) || cmpName(a, b);
    if (order === 'quota_5h') return (quotaOf(b, '5h') ?? -1) - (quotaOf(a, '5h') ?? -1) || cmpName(a, b);
    if (order === 'quota_weekly') return (quotaOf(b, 'weekly') ?? -1) - (quotaOf(a, 'weekly') ?? -1) || cmpName(a, b);
    if (order === 'category') return categoryOf(a).localeCompare(categoryOf(b), 'tr') || cmpName(a, b);
    if (order === 'status') return issueRank(a) - issueRank(b) || (quotaOf(a, 'min') ?? 999) - (quotaOf(b, 'min') ?? 999) || cmpName(a, b);
    return cmpName(a, b);
  });
}
export function initialTaskGroup(models, mode, previous, initialized = false) {
  if (mode !== 'manual') return previous || '';
  if (initialized && ['high','medium','low'].includes(previous)) return previous;
  return ['high','medium','low'].find(group => models.some(model => model.enabled && model.group === group)) || 'high';
}

export function restoredWorkspace(saved) { return typeof saved === 'string' ? saved : ''; }
