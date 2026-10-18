import { runProcess } from './process.js';
import { executableArgv } from './adapters.js';
import { PoolError } from './config.js';

export async function codexControl(route, cwd, python, method) {
  let nextId = 1;
  const pending = new Map();
  const handle = runProcess({ argv: [...executableArgv(route.executable), 'app-server', '--stdio', '-c', 'model_provider="openai"'], cwd, python, relay: true, timeoutMs: 20_000,
    onLine(line) {
      const message = JSON.parse(line);
      if (message.method && message.id != null) {
        handle.send(JSON.stringify({ id: message.id, error: { code: -32601, message: 'Control-only client' } }) + '\n');
      } else if (pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) reject(new PoolError('CONTROL_FAILED', 'Codex kontrol isteği reddedildi. CLI sürümünü ve giriş durumunu kontrol edin.'));
        else resolve(message.result);
      }
    },
  });
  handle.done.then(() => { for (const p of pending.values()) p.reject(new PoolError('CONTROL_CLOSED', 'Codex kontrol bağlantısı kapandı.')); pending.clear(); });
  const call = (name, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    handle.send(JSON.stringify({ id, method: name, params }) + '\n');
  });
  try {
    await call('initialize', { clientInfo: { name: 'cli-agent-pool', version: '0.1.0' } });
    handle.send(JSON.stringify({ method: 'initialized' }) + '\n');
    if (method === 'models') {
      const result = await call('model/list', { limit: 100, includeHidden: false });
      return { connection: route.id, models: (result.data || []).map(model => ({
        id: model.model || model.id, name: model.displayName || model.model || model.id,
        efforts: (model.supportedReasoningEfforts || []).map(e => e.reasoningEffort),
        defaultEffort: model.defaultReasoningEffort || null,
      })), nextCursor: result.nextCursor || null };
    }
    const result = await call('account/rateLimits/read');
    const buckets = result.rateLimitsByLimitId || (result.rateLimits ? { default: result.rateLimits } : {});
    const windows = Object.entries(buckets).flatMap(([bucketId, bucket]) => ['primary', 'secondary'].flatMap(name => {
      const window = bucket[name];
      if (!window || !Number.isFinite(window.usedPercent)) return [];
      return [{ bucketId, name, usedPercent: window.usedPercent, remainingPercent: Math.max(0, 100 - window.usedPercent), windowMinutes: window.windowDurationMins ?? null, resetsAt: window.resetsAt ?? null }];
    }));
    return { connection: route.id, status: windows.length ? windows.some(w => w.usedPercent >= 100) ? 'rate_limited' : 'available' : 'unknown', scope: 'account', windows, source: 'codex-app-server', observedAt: new Date().toISOString() };
  } finally { handle.cancel('CONTROL_COMPLETE'); await handle.done; }
}
