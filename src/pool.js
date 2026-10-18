import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { allowedWorkspace, overlaps, PoolError } from './config.js';
import { checkAuth, execute, quota } from './adapters.js';
import { codexControl } from './codex-control.js';

export const taskSchema = z.object({
  prompt: z.string().trim().min(1).max(100_000),
  workspace: z.string().min(1).max(4096),
  kind: z.enum(['text', 'read', 'write']),
  routeId: z.string().max(100).optional(),
  modelId: z.string().max(100).optional(),
  group: z.string().max(100).optional(),
  effort: z.string().max(100).optional(),
  timeoutSeconds: z.number().int().min(5).max(3600).default(300),
  idempotencyKey: z.string().min(8).max(128).regex(/^[a-zA-Z0-9_.:-]+$/),
}).strict();

export class Pool {
  constructor(config, store, dependencies = {}) {
    this.config = config;
    this.store = store;
    this.execute = dependencies.execute || execute;
    this.checkAuth = dependencies.checkAuth || checkAuth;
    this.active = new Map();
    this.quotaRequests = new Map();
    this.closed = false;
    this.pumping = false;
  }
  models() {
    return this.config.routes.flatMap(route => route.models.map(model => ({ ...model, routeId: route.id, adapter: route.adapter, enabled: route.enabled && model.enabled, billing: route.billing, priority: route.priority })));
  }
  select(request) {
    const matches = this.models().filter(model => {
      const snapshot = this.store.quota(model.routeId);
      const route = this.config.routes.find(r => r.id === model.routeId);
      const fresh = snapshot && Date.now() - Date.parse(snapshot.observedAt) < 60_000;
      const quotaBlocked = fresh && (snapshot.status === 'rate_limited' || snapshot.subscription === 'none' || snapshot.windows?.some(window => window.remainingPercent != null && window.remainingPercent <= route.minRemainingPercent));
      return !quotaBlocked && model.enabled && model.billing === 'subscription' && model.kinds.includes(request.kind) &&
      (!request.routeId || model.routeId === request.routeId) && (!request.modelId || model.id === request.modelId) &&
      (!request.group || model.group === request.group) && (!request.effort || model.efforts.includes(request.effort)); })
      .sort((a, b) => a.priority - b.priority || a.routeId.localeCompare(b.routeId) || a.id.localeCompare(b.id));
    if (!matches.length) throw new PoolError('NO_ROUTE', 'Kurallara uyan etkin abonelik modeli yok. Yerel bağlantı ayarlarını kontrol edin.');
    return { selected: matches[0], alternatives: matches.slice(1), reason: 'Kullanıcı filtreleri, desteklenen görev/efor ve bağlantı önceliği uygulandı. Kota bilinmiyorsa kullanılabilir varsayılmaz; gerçek kabul CLI tarafından belirlenir.' };
  }
  async getQuota(routeId) {
    const route = this.config.routes.find(r => r.id === routeId);
    if (!route) throw new PoolError('NOT_FOUND', 'Bağlantı bulunamadı.');
    if (!route.enabled) throw new PoolError('ROUTE_DISABLED', 'Bağlantı kapalı.');
    const cached = this.store.quota(routeId);
    if (cached && Date.now() - Date.parse(cached.observedAt) < 15_000) return cached;
    if (this.quotaRequests.has(routeId)) return this.quotaRequests.get(routeId);
    const request = (async () => {
      const cwd = this.config.workspaceRoots[0];
      if (!cwd) throw new PoolError('INVALID_WORKSPACE', 'Önce izinli bir çalışma klasörü tanımlayın.');
      const snapshot = route.adapter === 'codex' ? await codexControl(route, cwd, this.config.python, 'quotas') : await quota(route, cwd, this.config.python);
      this.store.saveQuota(routeId, snapshot);
      return snapshot;
    })();
    this.quotaRequests.set(routeId, request);
    try { return await request; } finally { this.quotaRequests.delete(routeId); }
  }
  submit(input) {
    if (this.closed) throw new PoolError('SHUTTING_DOWN', 'Havuz kapanıyor. Yeniden bağlanın.');
    const request = taskSchema.parse(input);
    request.workspace = allowedWorkspace(request.workspace, this.config.workspaceRoots);
    const fingerprint = createHash('sha256').update(JSON.stringify(request)).digest('hex');
    const existing = this.store.byKey(request.idempotencyKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new PoolError('IDEMPOTENCY_CONFLICT', 'Aynı istek anahtarı farklı içerikle kullanıldı. Yeni bir anahtar seçin.');
      return this.get(existing.id);
    }
    if (this.store.queued().length >= 100) throw new PoolError('QUEUE_FULL', 'Görev kuyruğu dolu. Çalışan işlerin tamamlanmasını bekleyin.');
    const model = this.select(request).selected;
    request.routeId = model.routeId;
    request.modelId = model.id;
    request.effort ||= model.defaultEffort;
    const id = randomUUID();
    this.store.insert({ id, key: request.idempotencyKey, fingerprint, workspace: request.workspace, request });
    this.schedule();
    return this.get(id);
  }
  get(id, after = 0) {
    const task = this.store.get(id);
    if (!task) throw new PoolError('NOT_FOUND', 'Görev bulunamadı. Görev kimliğini kontrol edin.');
    const request = JSON.parse(task.request);
    return { id: task.id, state: task.state, routeId: request.routeId, modelId: request.modelId, kind: request.kind, created: task.created, updated: task.updated, result: task.result, error: task.error, events: this.store.events(id, after) };
  }
  list(limit = 50, offset = 0) {
    return this.store.list(limit, offset);
  }
  cancel(id) {
    const task = this.store.get(id);
    if (!task) throw new PoolError('NOT_FOUND', 'Görev bulunamadı.');
    if (task.state === 'queued') this.store.update(id, 'cancelled', null, 'CANCELLED');
    else if (['starting', 'running'].includes(task.state)) {
      this.store.update(id, 'cancelling');
      const handle = this.active.get(id);
      if (handle) { handle.cancelled = true; handle.run?.cancel('CANCELLED'); }
    }
    return this.get(id);
  }
  schedule() {
    if (this.closed || this.pumping) return;
    this.pumping = true;
    queueMicrotask(() => {
      this.pumping = false;
      if (this.closed) return;
      try {
        for (const task of this.store.queued()) {
          if (this.active.size >= this.config.concurrency) break;
          // ponytail: serialize overlapping workspaces, including reads, until snapshot isolation is implemented.
          if (this.store.held().some(held => overlaps(held.workspace, task.workspace))) continue;
          const request = JSON.parse(task.request);
          const route = this.config.routes.find(r => r.id === request.routeId);
          if (!route || !route.enabled) { this.store.update(task.id, 'failed', null, 'ROUTE_DISABLED'); continue; }
          if ([...this.active.values()].filter(active => active.routeId === route.id).length >= route.maxConcurrent) continue;
          this.store.update(task.id, 'starting');
          const handle = { routeId: route.id, cancelled: false, run: null };
          this.active.set(task.id, handle);
          handle.done = this.run(task, request, route, handle);
        }
      } catch {
        this.closed = true; // A storage fault stops admission; never claim an unpersisted success.
        for (const handle of this.active.values()) handle.run?.cancel('STORAGE_FAILED');
      }
    });
  }
  async run(task, request, route, handle) {
    try {
      request.workspace = allowedWorkspace(request.workspace, this.config.workspaceRoots);
      const model = this.select(request).selected;
      await this.checkAuth(route, request.workspace, this.config.python);
      if (handle.cancelled || this.closed) { this.store.update(task.id, 'cancelled', null, 'CANCELLED'); return; }
      this.store.update(task.id, 'running');
      let events = 0;
      handle.run = this.execute(route, model, request, this.config.python, detail => {
        if (events++ < 100) this.store.event(task.id, 'progress', detail);
      });
      const outcome = await handle.run.done;
      if (handle.cancelled) this.store.update(task.id, request.kind === 'write' ? 'needs_review' : 'cancelled', null, 'CANCELLED');
      else if (outcome.error) this.store.update(task.id, request.kind === 'write' ? 'needs_review' : outcome.error === 'TIMEOUT' ? 'timed_out' : 'failed', null, outcome.error);
      else this.store.update(task.id, 'succeeded', outcome.result);
    } catch (error) {
      try { this.store.update(task.id, handle.cancelled ? 'cancelled' : 'failed', null, error instanceof PoolError ? error.code : 'INTERNAL_ERROR'); }
      catch { this.closed = true; handle.run?.cancel('STORAGE_FAILED'); }
    } finally {
      this.active.delete(task.id);
      this.schedule();
    }
  }
  async close() {
    this.closed = true;
    const pending = [...this.active.values()];
    for (const handle of pending) { handle.cancelled = true; handle.run?.cancel('CANCELLED'); }
    await Promise.allSettled(pending.map(handle => handle.done));
    await Promise.allSettled(this.quotaRequests.values());
  }
}
