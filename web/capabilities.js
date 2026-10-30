const coding = new Set(['codex', 'claude', 'opencode', 'mimo', 'zcode', 'qwen', 'mcode', 'kimi', 'agy']);
const chat = new Set(['mmx', 'ollama', 'lmstudio', 'omniroute']);

export function toolSupport(route) {
  if (route.argsTemplate?.length) return 'configured-template';
  if (coding.has(route.adapter)) return 'native-cli';
  if (chat.has(route.adapter)) return 'chat-cli';
  return 'configured-template';
}

export function taskKinds(route, model) {
  const source = toolSupport(route);
  const native = source === 'native-cli' ? ['text', 'read', 'write'] : source === 'chat-cli' ? ['text'] : [...model.kinds];
  return route.toolPolicy === 'configured' ? native.filter(kind => model.kinds.includes(kind)) : native;
}

export function capabilityLabel(route, model) {
  const kinds = taskKinds(route, model);
  if (kinds.includes('write')) return 'Dosya okuma / yazma · istek kapsamı ve CLI izinleri geçerli';
  if (kinds.includes('read')) return 'Dosya okuma · bağlantı kapsamı yazmayı kısıtlıyor';
  return toolSupport(route) === 'chat-cli' ? 'Sohbet CLI’ı · yerel dosya aracı sunmuyor' : 'Bağlantı kapsamı · dosya araçları kapalı';
}
