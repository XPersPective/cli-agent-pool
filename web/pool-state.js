export function memberships(model) {
  return model.memberships ?? (['high', 'medium', 'low'].includes(model.group) ? [{ group: model.group, ...(model.defaultEffort ? { effort: model.defaultEffort } : {}) }] : []);
}

export function mergeScanDraft(scanned, before, draft) {
  const merged = structuredClone(scanned);
  for (const route of draft.routes) {
    const target = merged.routes.find(item => item.id === route.id);
    const original = before.routes.find(item => item.id === route.id);
    if (!target) { if (!original) merged.routes.push(structuredClone(route)); continue; }
    if (!original) continue;
    for (const key of ['enabled', 'billing', 'autoSelect', 'trustedSettings', 'priority', 'minRemainingPercent', 'api']) {
      if (JSON.stringify(route[key]) !== JSON.stringify(original[key])) {
        if (route[key] === undefined) delete target[key]; else target[key] = structuredClone(route[key]);
      }
    }
    for (const model of route.models) {
      const old = original.models.find(item => item.id === model.id);
      const resolved = target.models.find(item => item.id === model.id) || target.models.find(item => Object.values(item.variants || {}).includes(model.id)) || target.models.find(item => ['opus', 'sonnet', 'haiku'].includes(model.id) && item.id.startsWith(`claude-${model.id}-`));
      if (!old) { if (!resolved) target.models.push(structuredClone(model)); continue; }
      if (!resolved) continue;
      for (const key of ['memberships', 'group', 'enabled', 'defaultEffort', 'alias']) {
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
  for (const key of ['selectionMode', 'groupingMode', 'workspaceRoots', 'modelFilters']) if (JSON.stringify(draft[key]) !== JSON.stringify(before[key])) merged[key] = structuredClone(draft[key]);
  return merged;
}
export function addMembership(model, group, effort = '') {
  if (!['high', 'medium', 'low'].includes(group) || effort && !model.efforts.includes(effort)) throw new Error('Havuz veya efor seçimi geçersiz.');
  if (memberships(model).some(member => member.group === group && (member.effort || '') === effort)) return false;
  model.memberships = memberships(model);
  let member = model.memberships.find(item => item.group === group);
  if (!member) { member = { group }; model.memberships.push(member); }
  if (effort) member.effort = effort; else delete member.effort;
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
    for (const key of ['memberships', 'group', 'enabled', 'defaultEffort']) {
      if (model[key] === undefined) delete previous[key]; else previous[key] = structuredClone(model[key]);
    }
  } else route.models.push(structuredClone(model));
  if (enableRoute) route.enabled = true;
  return config;
}

export function quotaWindows(snapshot, modelId = '') {
  return (snapshot?.windows || []).filter(window => quotaApplies(window,modelId) && Number.isFinite(window.remainingPercent)).map(window => {
    const remaining = Math.max(0, Math.min(100, window.remainingPercent));
    return { ...window, remaining, used: 100 - remaining };
  });
}

export function quotaApplies(window, modelId = '') {
  const id=modelId.toLowerCase();
  return !id || !window.models?.length || window.models.some(scope => ['gemini-flash','gemini-pro'].includes(scope) ? id.includes('gemini') && id.includes(scope.slice(7)) : id.includes(scope.toLowerCase()));
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
  return key.match(/(?:^|-)(astra|sol|terra|luna|opus|sonnet|haiku)(?:-|$)/)?.[1] || key.match(/^(gemini|qwen|glm|kimi|mimo|deepseek|gpt-oss|gpt)(?:-|$)/)?.[1] || key.replace(/[-_.]?\d.*$/, '') || key;
}
export function modelFiltered(filters, routeId, modelId) {
  return (filters || []).some(rule => (!rule.routeId || rule.routeId === routeId) && (rule.match === 'family' ? modelFamily(modelId) === rule.value : rule.routeId ? modelId.toLowerCase() === rule.value.toLowerCase() : modelIdentity(modelId) === modelIdentity(rule.value)));
}
export function sortModels(entries, order = 'az', families = false) {
  return [...entries].sort((a,b) => (families ? (order === 'za' ? -1 : 1) * modelIdentity(a.model.id).localeCompare(modelIdentity(b.model.id), 'tr', {numeric:true}) : 0) || (order === 'za' ? -1 : 1) * a.model.id.localeCompare(b.model.id, 'tr', {numeric:true}) || a.route.id.localeCompare(b.route.id));
}
export function initialTaskGroup(models, mode, previous, initialized = false) {
  if (mode !== 'manual') return previous || '';
  if (initialized && ['high','medium','low'].includes(previous)) return previous;
  return ['high','medium','low'].find(group => models.some(model => model.enabled && model.group === group)) || 'high';
}

export function restoredWorkspace(saved, roots) { return typeof saved === 'string' && roots.includes(saved) ? saved : ''; }
