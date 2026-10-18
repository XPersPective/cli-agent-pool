import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { allowedWorkspace, overlaps, PoolError, activeBillings, nonMeteredBillings, dataDirectory, configView, saveConfig } from './config.js';
import { checkAuth, execute, quota, loginCommands } from './adapters.js';
import { codexControl } from './codex-control.js';

export const taskSchema = z.object({
  prompt: z.string().trim().min(1).max(100_000),
  workspace: z.string().min(1).max(4096),
  kind: z.enum(['text', 'read', 'write']),
  routeId: z.string().max(100).optional(),
  modelId: z.string().max(100).optional(),
  group: z.string().max(100).optional(),
  effort: z.string().max(100).optional(),
  minRemainingPercent: z.number().min(0).max(100).optional(),
  timeoutSeconds: z.number().int().min(5).max(3600).default(300),
  idempotencyKey: z.string().min(8).max(128).regex(/^[a-zA-Z0-9_.:-]+$/),
}).strict();

export const groupAssignmentSchema = z.object({
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  assignments: z.array(z.object({ routeId: z.string().min(1).max(100), modelId: z.string().min(1).max(100), group: z.enum(['high', 'medium', 'low']), effort: z.string().min(1).max(100).optional(), remove: z.boolean().optional() }).strict()).min(1).max(5000),
}).strict();

export function suggestGroup(name) {
  // ponytail: model names only give starting suggestions; unknown families need owner/agent judgement or measured capability data.
  return /\b(astra|opus)\b/i.test(name) ? 'high' : /\b(luna|haiku|flash|mini)\b/i.test(name) ? 'low' : /\b(sol|sonnet)\b/i.test(name) ? 'medium' : null;
}

export class Pool {
  constructor(config, store, dependencies = {}) {
    this.config = config;
    this.store = store;
    this.directory = dependencies.directory || dataDirectory();
    this.execute = dependencies.execute || execute;
    this.checkAuth = dependencies.checkAuth || checkAuth;
    this.active = new Map();
    this.quotaRequests = new Map();
    this.closed = false;
    this.pumping = false;
  }
  models() {
    return this.config.routes.flatMap(route => route.models.flatMap(model => {
      const memberships = model.memberships ?? [{ group: model.group, effort: model.defaultEffort }];
      return (memberships.length ? memberships : [{ group: 'unassigned' }]).map(member => ({
      ...model,
      group: member.group,
      defaultEffort: member.effort,
      fixedEffort: model.memberships ? member.effort : undefined,
      suggestedGroup: suggestGroup(`${model.id} ${model.alias}`),
      routeId: route.id,
      adapter: route.adapter,
      enabled: route.enabled && model.enabled,
      billing: route.billing,
      autoSelect: route.autoSelect ?? (route.billing !== 'paid_api'),
      priority: route.priority,
      protocol: route.api?.protocol || null,
      baseUrl: route.api?.baseUrl || null,
    })); }));
  }
  pools() {
    const models = this.models();
    return { selectionMode: this.config.selectionMode, groupingMode: this.config.groupingMode, pools: ['high', 'medium', 'low'].map(group => ({ group, members: models.filter(model => model.group === group).map(model => {
      const quota = this.store.quota(model.routeId);
      return { ...model, quota: quota ? { status: quota.status, windows: quota.windows, observedAt: quota.observedAt, scope: quota.scope } : null };
    }) })) };
  }
  assignGroups(input) {
    const { revision, assignments } = groupAssignmentSchema.parse(input);
    const view = configView(this.directory);
    if (view.config.groupingMode !== 'agent') throw new PoolError('GROUPING_DENIED', 'Model gruplarını yalnızca kullanıcı yönetebilir. Ajan yetkisi kapalı.');
    for (const { routeId, modelId, group, effort, remove } of assignments) {
      const model = view.config.routes.find(route => route.id === routeId)?.models.find(model => model.id === modelId);
      if (!model) throw new PoolError('NOT_FOUND', 'Gruplanacak model bulunamadı.');
      model.memberships ??= ['high', 'medium', 'low'].includes(model.group) ? [{ group: model.group, ...(model.defaultEffort ? { effort: model.defaultEffort } : {}) }] : [];
      model.group = group;
      if (remove) model.memberships = model.memberships.filter(member => member.group !== group);
      else {
        let member = model.memberships.find(member => member.group === group);
        if (!member) { member = { group }; model.memberships.push(member); }
        if (effort) member.effort = effort;
      }
    }
    this.config = saveConfig(this.directory, view.config, revision);
    return { updated: assignments.length, revision: configView(this.directory).revision };
  }
  select(request) {
    if (this.config.selectionMode === 'manual' && !['high', 'medium', 'low'].includes(request.group))
      throw new PoolError('POOL_REQUIRED', 'Manuel modda Yüksek, Orta veya Hafif havuzlarından birini seçin.');
    const matches = this.models().filter(model => {
      const snapshot = this.store.quota(model.routeId);
      const route = this.config.routes.find(r => r.id === model.routeId);
      const fresh = snapshot && Date.now() - Date.parse(snapshot.observedAt) < 60_000;
      const missingPlan = snapshot?.subscription === 'none' && (route.billing === 'subscription' || route.billing === 'token_plan');
      const quotaBlocked = fresh && (snapshot.status === 'rate_limited' || snapshot.status === 'auth_required' || missingPlan || snapshot.windows?.some(window => (!window.models?.length || window.models.some(id => model.id.includes(id))) && window.remainingPercent != null && window.remainingPercent <= Math.max(route.minRemainingPercent, request.minRemainingPercent ?? 0)));
      const paidAllowed = model.billing !== 'paid_api' || Boolean(request.routeId) || Boolean(model.autoSelect);
      return !quotaBlocked && model.enabled && activeBillings.has(model.billing) && paidAllowed && model.kinds.includes(request.kind) &&
      (!request.routeId || model.routeId === request.routeId) && (!request.modelId || model.id === request.modelId) &&
      (!request.group || model.group === request.group) && (!request.effort || model.efforts.includes(request.effort)) &&
      (!request.effort || !model.fixedEffort || request.effort === model.fixedEffort); })
      .sort((a, b) => {
        const tierA = nonMeteredBillings.has(a.billing) ? 0 : 1;
        const tierB = nonMeteredBillings.has(b.billing) ? 0 : 1;
        return tierA - tierB || a.priority - b.priority || a.routeId.localeCompare(b.routeId) || a.id.localeCompare(b.id);
      });
    if (!matches.length) throw new PoolError('NO_ROUTE', 'Kurallara uyan etkin model yok. Bağlantı, ödeme türü veya izin ayarlarını kontrol edin.');
    return { selected: matches[0], alternatives: matches.slice(1), reason: 'Önce abonelik, token planı ve ücretsiz modeller tercih edilir; ücretli API yalnızca açıkça seçildiğinde veya otomatik seçime izin verildiğinde kullanılır.' };
  }
  async getQuota(routeId) {
    const route = this.config.routes.find(r => r.id === routeId);
    if (!route) throw new PoolError('NOT_FOUND', 'Bağlantı bulunamadı.');
    const cached = this.store.quota(routeId);
    if (cached && Date.now() - Date.parse(cached.observedAt) < 15_000) return cached;
    if (this.quotaRequests.has(routeId)) return this.quotaRequests.get(routeId);
    const request = (async () => {
      const cwd = this.config.workspaceRoots[0] || process.cwd();
      const snapshot = route.adapter === 'codex' && !route.api
        ? { ...(await codexControl(route, cwd, this.config.python, 'quotas')), adapter: route.adapter, billing: route.billing, loginCommand: loginCommands.codex }
        : await quota(route, cwd, this.config.python, this.directory);
      this.store.saveQuota(routeId, snapshot);
      return snapshot;
    })();
    this.quotaRequests.set(routeId, request);
    try { return await request; } finally { this.quotaRequests.delete(routeId); }
  }
  async selectLive(request) {
    const routes = new Set(this.models().filter(model => model.enabled && model.kinds.includes(request.kind) &&
      (!request.group || model.group === request.group) && (!request.routeId || model.routeId === request.routeId) &&
      (!request.modelId || model.id === request.modelId) && (model.billing !== 'paid_api' || request.routeId || model.autoSelect)).map(model => model.routeId));
    // Unsupported/offline quota probes stay unknown; never invent a balance.
    await Promise.allSettled([...routes].map(id => this.getQuota(id)));
    return this.select(request);
  }
  async submitLive(input) {
    const request = taskSchema.parse(input);
    allowedWorkspace(request.workspace, this.config.workspaceRoots);
    if (!this.store.byKey(request.idempotencyKey)) await this.selectLive(request);
    return this.submit(input);
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
    if (model.group !== 'unassigned') request.group = model.group;
    request.effort = model.fixedEffort || request.effort || model.defaultEffort;
    const id = randomUUID();
    this.store.insert({ id, key: request.idempotencyKey, fingerprint, workspace: request.workspace, request });
    this.schedule();
    return this.get(id);
  }
  get(id, after = 0) {
    const task = this.store.get(id);
    if (!task) throw new PoolError('NOT_FOUND', 'Görev bulunamadı. Görev kimliğini kontrol edin.');
    const request = JSON.parse(task.request);
    const events = this.store.events(id, after);
    const reportedModel = this.store.reportedModel(id);
    return { id: task.id, state: task.state, routeId: request.routeId, modelId: request.modelId, reportedModel, group: request.group, effort: request.effort || null, kind: request.kind, workspace: request.workspace, prompt: request.prompt, created: task.created, updated: task.updated, result: task.result, error: task.error, events };
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
      await this.checkAuth(route, request.workspace, this.config.python, this.directory);
      if (handle.cancelled || this.closed) { this.store.update(task.id, 'cancelled', null, 'CANCELLED'); return; }
      this.store.update(task.id, 'running');
      let events = 0;
      handle.run = this.execute(route, model, request, this.config.python, detail => {
        if (events++ < 100) this.store.event(task.id, 'progress', detail);
      }, this.directory);
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
