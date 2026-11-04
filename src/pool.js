import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { allowedWorkspace, PoolError, nonMeteredBillings, dataDirectory, configView, saveConfig } from './config.js';
import { checkAuth, execute, quota, loginCommands } from './adapters.js';
import { modelFiltered } from '../web/pool-state.js';
import { categoryPage } from './catalog.js';
import { codexControl } from './codex-control.js';
import { supportsExecution, validateMode, workspaceConflict, parseExecutionReport } from './task-protocol.js';
import { rejectionReason, noRouteMessage } from './routing.js';
import { taskKinds, toolSupport } from '../web/capabilities.js';

// A model test must survive a cold start. Antigravity needs ~98s for a one-word
// reply on this machine, so the old 45s budget killed healthy CLIs and reported a
// false timeout instead of the real answer.
export const PROBE_TIMEOUT_SECONDS = 180;

export const taskSchema = z.object({
  prompt: z.string().trim().min(1).max(100_000),
  workspace: z.string().min(1).max(4096),
  kind: z.enum(['text', 'read', 'write']),
  mode: z.enum(['response', 'execute']).optional(),
  routeId: z.string().max(100).optional(),
  modelId: z.string().max(100).optional(),
  group: z.string().max(100).optional(),
  effort: z.string().max(100).optional(),
  clientLabel: z.string().trim().min(1).max(100).refine(value=>!/[\u0000-\u001f]/.test(value)).optional(),
  minRemainingPercent: z.number().min(0).max(100).optional(),
  timeoutSeconds: z.number().int().min(1).max(Math.floor(2147483647 / 1000)).default(300),
  idempotencyKey: z.string().min(8).max(128).regex(/^[a-zA-Z0-9_.:-]+$/),
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
    this.historyTimer=setInterval(()=>{try{this.store.pruneHistory();}catch{/* Retain evidence and retry at the next interval. */}},3600_000);
    this.historyTimer.unref();
  }
  models() {
    return this.config.routes.flatMap(route => route.models.filter(model => !modelFiltered(this.config.modelFilters, route.id, model.id)).flatMap(model => {
      const billing = model.billing || route.billing;
      const memberships = model.memberships ? [...model.memberships] : [{ group: model.group, effort: model.defaultEffort }];
      const activeMemberships = memberships.filter(member => this.config.categories.some(category => category.id === member.group));
      return (activeMemberships.length ? activeMemberships : [{ group: 'unassigned' }]).map(member => ({
      ...model,
      kinds: taskKinds(route, model),
      configuredKinds: model.kinds,
      toolSupport: toolSupport(route),
      toolPolicy: route.toolPolicy || 'native',
      permissionAuthority: 'native-cli',
      group: member.group,
      defaultEffort: member.effort,

      suggestedGroup: suggestGroup(`${model.id} ${model.alias}`),
      routeId: route.id,
      adapter: route.adapter,
      account: route.profile || 'default',
      enabled: route.enabled && model.enabled,
      billing,
      autoSelect: route.autoSelect ?? (billing !== 'paid_api'),
      priority: route.priority,
      protocol: route.api?.protocol || null,
      executionModes: supportsExecution(route) && taskKinds(route, model).includes('write') ? ['execute'] : [],
      baseUrl: route.api?.baseUrl || null,
    })); }));
  }
  catalogModels() {
    const unique = new Map();
    for (const model of this.models()) {
      const key = JSON.stringify([model.routeId, model.id]);
      if (unique.has(key)) continue;
      const source = this.config.routes.find(route => route.id === model.routeId).models.find(item => item.id === model.id);
      unique.set(key, { ...model, group: undefined, defaultEffort: source.defaultEffort,
        categories: (source.memberships || []).map(member => member.group) });
    }
    return [...unique.values()];
  }
  pools(input = {}) { return categoryPage(this, input); }
  select(request) {
    validateMode(request);
    if (request.group && !this.config.categories.some(category => category.id === request.group))
      throw new PoolError('CATEGORY_NOT_FOUND', 'Kategori bulunamadı. pool_list_pools ile kategorileri sorgulayın.');
    const rejected = new Map();
    const matches = (request.group ? this.models() : this.catalogModels()).filter(model => {
      if ((request.routeId && model.routeId !== request.routeId) || (request.modelId && model.id !== request.modelId) || (request.group && model.group !== request.group)) return false;
      const snapshot = this.store.quota(model.routeId);
      const route = this.config.routes.find(r => r.id === model.routeId);
      const reason = rejectionReason(model, route, snapshot, request);
      if (reason) rejected.set(reason, (rejected.get(reason) || 0) + 1);
      return !reason; })
      .sort((a, b) => {
        const tierA = nonMeteredBillings.has(a.billing) ? 0 : 1;
        const tierB = nonMeteredBillings.has(b.billing) ? 0 : 1;
        return tierA - tierB || a.priority - b.priority || a.routeId.localeCompare(b.routeId) || a.id.localeCompare(b.id);
      });
    if (!matches.length) throw new PoolError('NO_ROUTE', noRouteMessage(request, rejected));
    return { selected: matches[0], alternatives: matches.slice(1), reason: 'Önce abonelik, token planı ve ücretsiz modeller tercih edilir; ücretli API yalnızca açıkça seçildiğinde veya otomatik seçime izin verildiğinde kullanılır.' };
  }
  async getQuota(routeId, force = false) {
    const route = this.config.routes.find(r => r.id === routeId);
    if (!route) throw new PoolError('NOT_FOUND', 'Bağlantı bulunamadı.');
    const cached = this.store.quota(routeId);
    if (!force && cached && Date.now() - Date.parse(cached.observedAt) < 15_000) return cached;
    if (this.quotaRequests.has(routeId)) return this.quotaRequests.get(routeId);
    const request = (async () => {
      const cwd = this.directory;
      let snapshot;
      if (route.adapter === 'codex' && !route.api) {
        try { snapshot = { ...(await codexControl(route, cwd, this.config.python, 'quotas', this.directory)), adapter: route.adapter, billing: route.billing, loginCommand: loginCommands.codex }; }
        catch {
          try { await this.checkAuth(route, cwd, this.config.python, this.directory); }
          catch (error) {
            if (error.code !== 'AUTH_REQUIRED') throw error;
            snapshot = { connection: route.id, status: 'auth_required', windows: [], observedAt: new Date().toISOString(), loginCommand: loginCommands.codex };
          }
          snapshot ||= cached?.windows?.length ? cached : { connection: route.id, status: 'unknown', windows: [], observedAt: new Date().toISOString(), loginCommand: loginCommands.codex };
        }
      } else snapshot = await quota(route, cwd, this.config.python, this.directory);
      if (route.adapter === 'qwen' && snapshot.auth === 'verified' && cached?.source === 'cli-run-rejection' &&
          Date.now() - Date.parse(cached.observedAt) < 5 * 60_000) {
        snapshot = { ...snapshot, status: 'unknown', lastRejectedAt: cached.observedAt, lastRejectedModel: cached.modelId,
          note: `${snapshot.note || ''} Son CLI çağrısı${cached.modelId ? ` (${cached.modelId})` : ''} kota nedeniyle reddedildi; bu geçmiş sonuç kalan kotayı ölçmez.`.trim() };
      }
      this.store.saveQuota(routeId, snapshot);
      return snapshot;
    })();
    this.quotaRequests.set(routeId, request);
    try { return await request; } finally { this.quotaRequests.delete(routeId); }
  }
  async selectLive(request) {
    const routes = new Set(this.models().filter(model => model.enabled && model.kinds.includes(request.kind) &&
      (!request.group || model.group === request.group) && (!request.routeId || model.routeId === request.routeId) &&
      (!request.modelId || model.id === request.modelId) && (request.routeId || model.billing !== 'paid_api' || model.autoSelect)).map(model => model.routeId));
    // Unsupported/offline quota probes stay unknown; never invent a balance.
    await Promise.allSettled([...routes].map(id => this.getQuota(id)));
    return this.select(request);
  }
  async probeModel(input) {
    if (!input || typeof input.routeId!=='string' || typeof input.modelId!=='string' || Object.keys(input).some(key=>!['routeId','modelId','group','effort'].includes(key))) throw new PoolError('INVALID_REQUEST','Geçerli bir model seçin.');
    const root=path.join(this.directory,'probes');mkdirSync(root,{recursive:true});
    if(lstatSync(root).isSymbolicLink())throw new PoolError('UNSAFE_DATA_DIRECTORY','Test klasörü bağlantı olamaz.');
    const workspace=mkdtempSync(path.join(root,'model-'));
    return this.submitLive({...input,prompt:'Reply with exactly OK. Do not use tools or modify files.',workspace,kind:'text',timeoutSeconds:PROBE_TIMEOUT_SECONDS,clientLabel:'Model testi',idempotencyKey:`probe-${randomUUID()}`},true);
  }
  async submitLive(input, probe = false) {
    const request = taskSchema.parse(input);
    allowedWorkspace(request.workspace, probe?[path.join(this.directory,'probes')]:undefined);
    if (!this.store.byKey(request.idempotencyKey)) await this.selectLive(request);
    return this.submit(input,probe);
  }
  submit(input, probe = false) {
    if (this.closed) throw new PoolError('SHUTTING_DOWN', 'Havuz kapanıyor. Yeniden bağlanın.');
    const request = taskSchema.parse(input);
    request.workspace = allowedWorkspace(request.workspace, probe?[path.join(this.directory,'probes')]:undefined);
    const fingerprint = createHash('sha256').update(JSON.stringify(request)).digest('hex');
    const existing = this.store.byKey(request.idempotencyKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new PoolError('IDEMPOTENCY_CONFLICT', 'Aynı istek anahtarı farklı içerikle kullanıldı. Yeni bir anahtar seçin.');
      return this.get(existing.id);
    }
    const model = this.select(request).selected;
    request.routeId = model.routeId;
    request.modelId = model.id;
    if (request.group) request.group = model.group;
    request.effort = request.effort || model.defaultEffort;
    if(probe)request.probe=true;
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
    const queued = task.state === 'queued' ? this.store.queued() : [];
    const earlier = queued.slice(0, queued.findIndex(row => row.id === task.id));
    const scope = { ...request, workspace: task.workspace };
    const blocker = task.state === 'queued' ? this.store.held().find(held => workspaceConflict(held, scope)) || earlier.find(row => workspaceConflict({ ...JSON.parse(row.request), workspace: row.workspace, state: row.state }, scope)) : null;
    const queueReason = blocker ? blocker.state === 'needs_review' ? 'WORKSPACE_REVIEW_REQUIRED' : 'WORKSPACE_BUSY' : null;
    const report = request.mode === 'execute' && task.result ? parseExecutionReport(task.result) : null;
    return { id: task.id, state: task.state, mode: request.mode || null, report, routeId: request.routeId, modelId: request.modelId, reportedModel, queueReason, blockedBy:blocker?.id || null, group: request.group, effort: request.effort || null, clientLabel:request.clientLabel || null, historyExpired:Boolean(request.historyExpired), kind: request.kind, workspace: request.workspace, prompt: request.prompt || null, created: task.created, updated: task.updated, result: task.result, error: task.error, errorDetail: this.store.errorDetail(id), events };
  }
  list(limit = 50, offset = 0, activeFirst = false) {
    return this.store.list(limit, offset, activeFirst);
  }
  cancel(id) {
    const task = this.store.get(id);
    if (!task) throw new PoolError('NOT_FOUND', 'Görev bulunamadı.');
    if (task.state === 'queued') { this.store.update(id, 'cancelled', null, 'CANCELLED'); this.schedule(); }
    else if (['starting', 'running'].includes(task.state)) {
      this.store.update(id, 'cancelling');
      const handle = this.active.get(id);
      if (handle) { handle.cancelled = true; handle.run?.cancel('CANCELLED'); }
    }
    return this.get(id);
  }
  resolveInspected(input) {
    const { taskId, note } = z.object({ taskId: z.string().uuid(), reviewed: z.literal(true), note: z.string().trim().min(1).max(600) }).strict().parse(input);
    const task = this.store.get(taskId);
    if (!task) throw new PoolError('NOT_FOUND', 'Görev bulunamadı.');
    if (task.state !== 'needs_review' || this.active.has(taskId)) throw new PoolError('INVALID_STATE', 'Yalnızca durmuş ve dosyaları incelenmiş görev çözümlenebilir.');
    this.store.event(taskId, 'review_resolution', note);
    this.store.update(taskId, 'failed', task.result, 'MANUALLY_RESOLVED');
    this.schedule();
    return this.get(taskId);
  }
  schedule() {
    if (this.closed || this.pumping) return;
    this.pumping = true;
    queueMicrotask(() => {
      this.pumping = false;
      if (this.closed) return;
      try {
        const waiting = [];
        for (const task of this.store.queued()) {
          const request = JSON.parse(task.request);
          const route = this.config.routes.find(r => r.id === request.routeId);
          if (!route || !route.enabled) { this.store.update(task.id, 'failed', null, 'ROUTE_DISABLED'); continue; }
          const blocked = this.store.held().some(held => workspaceConflict(held, request)) || waiting.some(held => workspaceConflict(held, request));
          waiting.push({ ...request, state: 'queued' });
          if (blocked) continue;
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
      request.workspace = allowedWorkspace(request.workspace, request.probe?[path.join(this.directory,'probes')]:undefined);
      const model = this.select(request).selected;
      await this.checkAuth(route, request.workspace, this.config.python, this.directory, model);
      if (handle.cancelled || this.closed) { this.store.update(task.id, 'cancelled', null, 'CANCELLED'); return; }
      this.store.update(task.id, 'running');
      let events = 0;
      handle.run = this.execute(route, model, request, this.config.python, detail => {
        if (events++ < 100) this.store.event(task.id, 'progress', detail);
      }, this.directory);
      const outcome = await handle.run.done;
      if (outcome.detail) this.store.event(task.id, 'error_detail', outcome.detail);
      if (outcome.error === 'QUOTA_EXHAUSTED') {
        const previous = this.store.quota(route.id);
        this.store.saveQuota(route.id, {
          connection: route.id, adapter: route.adapter, billing: route.billing,
          status: 'unknown', auth: previous?.auth || 'credentials_present', windows: [],
          source: 'cli-run-rejection', observedAt: new Date().toISOString(), modelId: model.id,
          note: 'Son gerçek CLI çağrısı sağlayıcı tarafından kota/kredi nedeniyle reddedildi; kalan kota yüzdesi bilinmiyor.',
        });
      }
      if (!outcome.error && route.adapter === 'qwen' && this.store.quota(route.id)?.source === 'cli-run-rejection') {
        const previous = this.store.quota(route.id);
        this.store.saveQuota(route.id, {
          connection: route.id, adapter: route.adapter, billing: route.billing,
          status: 'unknown', auth: previous.auth, windows: [], source: 'cli-run-success',
          observedAt: new Date().toISOString(), note: 'Son gerçek CLI çağrısı başarılı; Qwen kalan kota yüzdesi bildirmiyor.',
        });
      }
      if (handle.cancelled) this.store.update(task.id, request.kind === 'write' ? 'needs_review' : 'cancelled', null, 'CANCELLED');
      else if (outcome.error) this.store.update(task.id, request.kind === 'write' ? 'needs_review' : outcome.error === 'TIMEOUT' ? 'timed_out' : 'failed', outcome.result || null, outcome.error);
      else if (request.mode === 'execute') {
        const report = parseExecutionReport(outcome.result);
        const error = !report ? 'INVALID_REPORT' : report.status !== 'completed' ? 'WORK_INCOMPLETE' : null;
        this.store.update(task.id, error ? 'needs_review' : 'succeeded', outcome.result, error);
      } else this.store.update(task.id, 'succeeded', outcome.result);
    } catch (error) {
      try { this.store.update(task.id, handle.run && request.kind === 'write' ? 'needs_review' : handle.cancelled ? 'cancelled' : 'failed', null, error instanceof PoolError ? error.code : 'INTERNAL_ERROR'); }
      catch { this.closed = true; handle.run?.cancel('STORAGE_FAILED'); }
    } finally {
      this.active.delete(task.id);
      this.schedule();
    }
  }
  async close() {
    this.closed = true;
    clearInterval(this.historyTimer);
    const pending = [...this.active.values()];
    for (const handle of pending) { handle.cancelled = true; handle.run?.cancel('CANCELLED'); }
    await Promise.allSettled(pending.map(handle => handle.done));
    await Promise.allSettled(this.quotaRequests.values());
  }
}
