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
      const resolved = target.models.find(item => item.id === model.id) || target.models.find(item => ['opus', 'sonnet', 'haiku'].includes(model.id) && item.id.startsWith(`claude-${model.id}-`));
      if (!old) { if (!resolved) target.models.push(structuredClone(model)); continue; }
      if (!resolved) continue;
      for (const key of ['memberships', 'group', 'enabled', 'defaultEffort', 'alias']) {
        if (JSON.stringify(model[key]) !== JSON.stringify(old[key])) {
          if (model[key] === undefined) delete resolved[key]; else resolved[key] = structuredClone(model[key]);
        }
      }
    }
  }
  for (const key of ['selectionMode', 'groupingMode', 'workspaceRoots']) if (JSON.stringify(draft[key]) !== JSON.stringify(before[key])) merged[key] = structuredClone(draft[key]);
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

export function quotaWindows(snapshot, modelId = '') {
  return (snapshot?.windows || []).filter(window => (!modelId || !window.models?.length || window.models.some(id => modelId.includes(id))) && Number.isFinite(window.remainingPercent)).map(window => {
    const remaining = Math.max(0, Math.min(100, window.remainingPercent));
    return { ...window, remaining, used: 100 - remaining };
  });
}

export function effortLabel(value) {
  return ({ low: 'Düşük', medium: 'Orta', high: 'Yüksek', xhigh: 'Çok yüksek', max: 'En yüksek', minimal: 'En az', none: 'Kapalı', default: 'Varsayılan' })[value] || value || 'CLI varsayılanı';
}
