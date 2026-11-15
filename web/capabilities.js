const coding = new Set(['codex', 'claude', 'opencode', 'mimo', 'zcode', 'qoder', 'qwen', 'mcode', 'kimi', 'agy']);
const chat = new Set(['mmx', 'ollama', 'lmstudio', 'omniroute']);

export function toolSupport(route) {
  if (route.argsTemplate?.length) return 'configured-template';
  if (coding.has(route.adapter)) return 'native-cli';
  if (chat.has(route.adapter)) return 'chat-cli';
  return 'configured-template';
}

export function taskKinds(route, model) {
  const source = toolSupport(route);
  // MiniMax standard enables tools, but smart permissions do not enforce read-only.
  const native = source === 'native-cli' ? route.adapter === 'mcode' ? ['text', 'write'] : ['text', 'read', 'write'] : source === 'chat-cli' ? ['text'] : [...model.kinds];
  return route.toolPolicy === 'configured' ? native.filter(kind => model.kinds.includes(kind)) : native;
}

export function capabilityLabel(route, model) {
  const kinds = taskKinds(route, model);
  if (kinds.includes('write')) return 'okuma / yazma';
  if (kinds.includes('read')) return 'okuma';
  return toolSupport(route) === 'chat-cli' ? 'sohbet' : 'metin';
}
