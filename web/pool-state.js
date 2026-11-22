import { isCategoryId } from './categories.js';
export function memberships(model) {
  return model.memberships ?? (['high', 'medium', 'low', 'free'].includes(model.group) ? [{ group: model.group, ...(model.defaultEffort ? { effort: model.defaultEffort } : {}) }] : []);
}

// Disabling a connection hides its catalog and memberships without deleting them.
// A model served by another enabled connection remains independently visible.
// Ayarlar sayfasının görüntülenen verisinin imzası. İmza değişmediyse liste yeniden
// kurulmaz; böylece seçim yaparken sayfa zıplamaz, liste karışmaz.
export function settingsViewSignature(config, quotas = {}, ui = '') {
  if (!config) return '';
  // Revizyon kota önbelleği yazımlarında da değişir; imzaya katılmaz, yoksa liste her yoklamada yeniden kurulur.
  const { routes = [], revision, ...rest } = config;
  const routeSig = routes.map(route => [
    route.id,
    route.enabled ? 1 : 0,
    route.billing,
    route.profile || '',
    route.priority ?? '',
    route.minRemainingPercent ?? '',
    route.toolPolicy || '',
    route.trustedSettings ? 1 : 0,
    route.autoSelect ?? '',
    route.api?.baseUrl || '',
    (route.models || []).map(model => `${model.id}:${model.enabled ? 1 : 0}:${(model.memberships || []).map(item => item.group).join('+')}`).join(','),
  ].join('~')).join('|');
  const quotaSig = Object.keys(quotas || {}).sort().map(id => {
    const q = quotas[id];
    const wins = Array.isArray(q?.windows)
      ? q.windows.map(w => `${w.name || ''}:${w.remainingPercent ?? ''}`).join(';')
      : '';
    return `${id}:${q?.status || ''}:${q?.auth || ''}:${q?.subscription || ''}:${q?.email || ''}:${q?.informational ? 1 : 0}:${q?.remaining ?? ''}:${q?.used ?? ''}:${wins}`;
  }).join(',');
  return `${JSON.stringify(rest)}|${routeSig}|${quotaSig}|${ui}`;
}

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
    const matched = wins.filter(w => ['five_hour', '5h', 'primary'].includes(w.name) || /:5h$/i.test(w.name || '') || (Number.isFinite(w.windowMinutes) && w.windowMinutes <= 360));
    return matched.length ? Math.min(...matched.map(w => w.remaining)) : null;
  }
  if (kind === 'weekly') {
    const matched = wins.filter(w => ['seven_day', '7d', 'weekly', 'opus', 'secondary'].includes(w.name) || /:(?:7d|weekly)$/i.test(w.name || '') || (Number.isFinite(w.windowMinutes) && w.windowMinutes >= 1440 && w.windowMinutes <= 14_400));
    return matched.length ? Math.min(...matched.map(w => w.remaining)) : null;
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
    // A provider that answers with account-level information (OpenCode Zen/Go,
    // free provider models) is healthy even without a percentage window.
    if (snapshot?.informational) return { state: 'healthy', level: 'ok', badge: 'Hazır', isError: false, isUnknown: false, isDisabled: false };
    return { state: 'quota_unknown', level: 'unknown', badge: 'Kota okunamıyor', isError: false, isUnknown: true, isDisabled: false };
  }
  return { state: 'healthy', level: 'ok', badge: 'Hazır', isError: false, isUnknown: false, isDisabled: false };
}

export function quotaMatches(snapshot, modelId, mode = 'all', route = null, model = null, quotaError = '') {
  if (mode === 'all') return true;
  const known = quotaWindows(snapshot, modelId).length > 0;
  if (mode === 'known') return known;
  const issue = modelIssueInfo(route, model || { id: modelId }, snapshot, quotaError);
  if (mode === 'unknown') return issue.isUnknown;
  if (mode === 'healthy') return issue.state === 'healthy';
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

export function quotaWindowShortLabel(window) {
  const known = {
    five_hour: '5s',
    '5h': '5s',
    seven_day: '7g',
    '7d': '7g',
    weekly: '7g',
    thirty_day: '30g',
    '30d': '30g',
    monthly: '30g',
    opus: 'Opus 7g',
    'opus:7d': 'Opus 7g',
    'sonnet:7d': 'Sonnet 7g',
    primary: 'Kısa',
    secondary: '7g',
  };
  if (known[window?.name]) return known[window.name];
  if (Number.isFinite(window?.windowMinutes)) {
    if (window.windowMinutes >= 43_200) return `${Math.round(window.windowMinutes / 1440)}g`;
    if (window.windowMinutes >= 1440) return `${Math.round(window.windowMinutes / 1440)}g`;
    return `${Math.round(window.windowMinutes / 60)}s`;
  }
  const raw = String(window?.name || 'kota');
  return raw.includes(':') ? raw.split(':').at(-1) : raw;
}

export function formatCompactQuotaWindows(snapshot, modelId = '') {
  const wins = quotaWindows(snapshot, modelId);
  const seen = new Map();
  for (const w of wins) {
    const label = quotaWindowShortLabel(w);
    const remaining = Math.round(w.remaining);
    const level = remaining >= 50 ? 'ok' : remaining >= 20 ? 'mid' : 'low';
    const prev = seen.get(label);
    if (!prev || remaining < prev.remaining) {
      seen.set(label, { label, remaining, level, name: w.name });
    }
  }
  return [...seen.values()];
}

export function normalizeDisplayMode(mode) {
  return mode === 'mini' ? 'mini' : 'detailed';
}

export function quotaApplies(window, modelId = '') {
  const id = modelId.toLowerCase();
  return !id || !window.models?.length || window.models.some(scope => ['gemini-flash', 'gemini-pro'].includes(scope) ? id.includes('gemini') && id.includes(scope.slice(7)) : id.includes(scope.toLowerCase()));
}

// The quota toggle must never claim a state the page does not have: without an
// expandable quota block there is nothing to show or hide.
export function quotaToggleState(details = []) {
  const list = details.filter(Boolean);
  if (!list.length) return { label: 'Kota ayrıntısı yok', pressed: false, disabled: true, title: 'Bu görünümde açılabilir kota ayrıntısı yok' };
  const allOpen = list.every(detail => detail.open);
  return { label: allOpen ? 'Kotaları gizle' : 'Kotaları göster', pressed: allOpen, disabled: false, title: allOpen ? 'Kota ayrıntılarını gizle' : 'Kota ayrıntılarını göster' };
}

export function quotaToggleTarget(details = []) {
  return details.some(detail => !detail.open);
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
  return key.match(/(?:^|-)(argon|hydrogen|neon|astra|sol|terra|luna|opus|sonnet|haiku|fable)(?:-|$)/)?.[1] || key.match(/^(gemini|qwen|glm|kimi|mimo|deepseek|gpt-oss|gpt)(?:-|$)/)?.[1] || key.replace(/[-_.]?\d.*$/, '') || key;
}
export function modelFiltered(filters, routeId, modelId) {
  return (filters || []).some(rule => (!rule.routeId || rule.routeId === routeId) && (rule.match === 'family' ? modelFamily(modelId) === rule.value : rule.routeId ? modelId.toLowerCase() === rule.value.toLowerCase() : modelIdentity(modelId) === modelIdentity(rule.value)));
}
export function isSettingsFiltered(filters, routeId, modelId) {
  return (filters || []).some(rule => rule.reason === 'settings' && modelFiltered([rule], routeId, modelId));
}
export function setRouteModelSettingsFilter(filters, routeId, modelId, excluded, routes = null) {
  const list = structuredClone(filters || []);
  if (!excluded) {
    return unhideModels(list, routes || [{ id: routeId, models: [{ id: modelId }] }], [{ routeId, modelId }]);
  }
  const existing = list.find(item => item.match === 'model' && item.routeId === routeId && item.value.toLowerCase() === modelId.toLowerCase());
  if (existing) {
    existing.reason = existing.reason || 'settings';
    return list;
  }
  list.push({ match: 'model', value: modelId, routeId, reason: 'settings' });
  return list;
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

export function cleanRouteLabel(route, email = '', index = 1) {
  const cleanEmail = typeof email === 'string' ? email.trim() : '';
  const rawId = typeof route?.id === 'string' ? route.id.trim() : '';
  const adapter = typeof route?.adapter === 'string' ? route.adapter.trim() : '';
  if (route?.api) {
    const cleanedApiId = rawId.replace(/-local(?=$|-)/g, '');
    return `${cleanEmail || cleanedApiId || rawId || (index > 1 ? `API #${index}` : 'Özel API')} · API`;
  }
  if (cleanEmail) return cleanEmail;
  if (route?.profile) {
    const num = String(route.profile).replace(/\D+/g, '');
    return `Abonelik #${num || index}`;
  }
  if (rawId) {
    let cleaned = rawId.replace(/-local(?=$|-)/g, '');
    if (adapter && cleaned.toLowerCase() === adapter.toLowerCase()) cleaned = '';
    else if (adapter && cleaned.toLowerCase().startsWith(`${adapter.toLowerCase()}-`)) cleaned = cleaned.slice(adapter.length + 1);
    if (!cleaned || cleaned.toLowerCase() === 'local') {
      return index > 1 ? `Abonelik #${index}` : 'Varsayılan abonelik';
    }
    if (/^\d+$/.test(cleaned)) return `Abonelik #${cleaned}`;
    return cleaned;
  }
  return index > 1 ? `Abonelik #${index}` : 'Varsayılan abonelik';
}

export function toolGroupsForRoutes(routes = [], emails = {}, adapterLabels = {}) {
  const byAdapter = new Map();
  for (const route of routes || []) {
    if (!route?.adapter) continue;
    if (!byAdapter.has(route.adapter)) byAdapter.set(route.adapter, []);
    byAdapter.get(route.adapter).push(route);
  }
  const groups = [];
  for (const [adapter, list] of byAdapter) {
    const label = adapterLabels[adapter] || adapter;
    const sorted = [...list].sort((a, b) => {
      const apiDiff = Number(Boolean(a.api)) - Number(Boolean(b.api));
      if (apiDiff !== 0) return apiDiff;
      const aKey = String(emails[a.id] || a.email || a.profile || a.id || '');
      const bKey = String(emails[b.id] || b.email || b.profile || b.id || '');
      return aKey.localeCompare(bKey, 'tr', { numeric: true });
    });
    const wrapped = sorted.map((route, idx) => {
      const email = emails[route.id] || route.email || '';
      const subscriptionLabel = cleanRouteLabel(route, email, idx + 1);
      return {
        route,
        id: route.id,
        email,
        subscriptionLabel,
        isApi: Boolean(route.api),
        enabled: route.enabled !== false,
      };
    });
    groups.push({ adapter, label, routes: wrapped });
  }
  groups.sort((a, b) => a.label.localeCompare(b.label, 'tr'));
  return groups;
}

export function filterHierarchy(entries = [], selection = {}, emails = {}, adapterLabels = {}, familyLabelFn = x => x) {
  const byAdapter = new Map();
  for (const item of entries || []) {
    const adapter = item?.route?.adapter;
    if (!adapter) continue;
    if (!byAdapter.has(adapter)) byAdapter.set(adapter, { count: 0, routeIds: new Set() });
    const stats = byAdapter.get(adapter);
    stats.count += 1;
    if (item.route?.id) stats.routeIds.add(item.route.id);
  }
  const totalRouteIds = new Set((entries || []).map(item => item?.route?.id).filter(Boolean));
  const toolRows = [...byAdapter.entries()]
    .map(([id, stats]) => ({
      id,
      label: adapterLabels[id] || id,
      count: stats.count,
      subscriptionCount: stats.routeIds.size,
    }))
    .sort((a, b) => a.label.localeCompare(b.label, 'tr'));
  const tools = [
    { id: '__all__', label: 'Tümü', count: (entries || []).length, subscriptionCount: totalRouteIds.size },
    ...toolRows,
  ];

  // Geçersiz bir araç seçimi "Tümü"ye döner ve o abonelik seçimi de sıfırlanır.
  const toolValid = !selection?.tool
    || selection.tool === '__all__'
    || tools.some(t => t.id === selection.tool);
  const tool = toolValid && selection?.tool !== '__all__' && selection?.tool
    ? selection.tool
    : '__all__';
  const toolFiltered = tool === '__all__'
    ? [...(entries || [])]
    : (entries || []).filter(item => item?.route?.adapter === tool);

  // Abonelik şeridi her zaman görünür: "Tümü" seçiliyken tüm araçların abonelikleri,
  // tek bir araç seçiliyken o aracın abonelikleri listelenir.
  const uniqueRoutes = new Map();
  for (const item of toolFiltered) {
    if (item?.route?.id && !uniqueRoutes.has(item.route.id)) uniqueRoutes.set(item.route.id, item.route);
  }
  if (Array.isArray(selection?.routes)) {
    for (const r of selection.routes) {
      if (!r?.id || uniqueRoutes.has(r.id)) continue;
      if (tool === '__all__' || r?.adapter === tool) uniqueRoutes.set(r.id, r);
    }
  }
  const subscriptionGroups = toolGroupsForRoutes([...uniqueRoutes.values()], emails, adapterLabels);
  const subRows = [];
  for (const group of subscriptionGroups) {
    for (const w of group.routes) {
      subRows.push({
        id: w.id,
        label: tool === '__all__' ? `${group.label} · ${w.subscriptionLabel}` : w.subscriptionLabel,
        subscriptionLabel: w.subscriptionLabel,
        toolLabel: group.label,
        tool: group.adapter,
        email: w.email,
        isApi: w.isApi,
        enabled: w.enabled,
        count: toolFiltered.filter(item => item?.route?.id === w.id).length,
      });
    }
  }
  const subscriptions = [{ id: '__all__', label: 'Tümü', count: toolFiltered.length }, ...subRows];

  const routeId = toolValid && selection?.routeId && selection.routeId !== '__all__' && subscriptions.some(s => s.id === selection.routeId)
    ? selection.routeId
    : '__all__';
  const routeFiltered = routeId === '__all__'
    ? toolFiltered
    : toolFiltered.filter(item => item?.route?.id === routeId);

  const byFamily = new Map();
  for (const item of routeFiltered) {
    const fam = modelFamily(item?.model?.id || '');
    byFamily.set(fam, (byFamily.get(fam) || 0) + 1);
  }
  const familyRows = [...byFamily.entries()]
    .map(([id, count]) => ({ id, label: familyLabelFn(id), count }))
    .sort((a, b) => a.label.localeCompare(b.label, 'tr'));
  const families = [{ id: '__all__', label: 'Tüm aileler', count: routeFiltered.length }, ...familyRows];

  const family = selection?.family && selection.family !== '__all__' && families.some(f => f.id === selection.family)
    ? selection.family
    : '__all__';
  const filtered = family === '__all__'
    ? routeFiltered
    : routeFiltered.filter(item => modelFamily(item?.model?.id || '') === family);

  return { tool, routeId, family, tools, subscriptions, families, filtered };
}
