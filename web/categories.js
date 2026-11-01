export const defaultCategories = [
  { id: 'high', name: 'Yüksek' }, { id: 'medium', name: 'Orta' },
  { id: 'low', name: 'Hafif' }, { id: 'free', name: 'Ücretsiz' },
];
export const isCategoryId = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value) && !['unassigned', 'catalog'].includes(value);
export const categoriesOf = config => config.categories ?? defaultCategories;

// Only category data migrates. Retired selection/authority switches never govern use.
export function migrateCategories(input) {
  const { groupingMode, selectionMode, concurrency, ...config } = input;
  for (const route of config.routes) delete route.maxConcurrent;
  config.categories = structuredClone(categoriesOf(input));
  if (!input.categories) {
    for (const route of config.routes) for (const model of route.models) {
      for (const member of model.memberships || []) if (!config.categories.some(c => c.id === member.group)) config.categories.push({ id: member.group, name: member.group });
      const legacy = defaultCategories.some(c => c.id === model.group) ? [{ group: model.group, ...(model.defaultEffort ? { effort: model.defaultEffort } : {}) }] : [];
      model.memberships ??= legacy;
      if ((model.billing || route.billing) === 'free' && model.memberships.length && !model.memberships.some(m => m.group === 'free')) model.memberships.push({ group: 'free' });
    }
  }
  return config;
}

export function removeCategory(config, id) {
  config.categories = categoriesOf(config).filter(category => category.id !== id);
  for (const route of config.routes) for (const model of route.models) {
    const previous = model.memberships ?? (model.group === id ? [{ group: id }] : []);
    model.memberships = previous.filter(member => member.group !== id);
    if (model.group === id) model.group = model.memberships[0]?.group || 'unassigned';
  }
}
