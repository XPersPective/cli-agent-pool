import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, lstatSync, rmSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { allowedWorkspace, PoolError, nonMeteredBillings, dataDirectory, redact } from './config.js';
import { loadSecret } from './secrets-store.js';
import { checkAuth, execute, quota, loginCommands, routeAccountEmail } from './adapters.js';
import { modelFiltered, quotaApplies } from '../web/pool-state.js';
import { categoryPage } from './catalog.js';
import { codexControl } from './codex-control.js';
import { supportsExecution, validateMode, parseExecutionReport } from './task-protocol.js';
import { rejectionReason, noRouteMessage } from './routing.js';
import { taskKinds, toolSupport } from '../web/capabilities.js';
import { CAPABILITIES, assertDirectorRoute } from './preflight.js';
import * as director from './director.js';
import { lifecycleShape, hasLifecycle, validateHook, TaskWatchdog } from './lifecycle.js';

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
  timeoutSeconds: z.number().int().min(0).max(Math.floor(2147483647 / 1000)).default(0),
  sessionId: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/, 'sessionId alfanümerik başlamalı ve geçerli karakterler içermeli.').optional(),
  persistSession: z.boolean().optional(),
  idempotencyKey: z.string().min(8).max(128).regex(/^[a-zA-Z0-9_.:-]+$/),
  // Director profile (owner surface only) and its declared capabilities.
  profile: z.enum(['worker', 'director']).optional(),
  capabilities: z.array(z.enum(CAPABILITIES)).max(6).optional(),
  readPaths: z.array(z.string().min(1).max(4096)).max(8).optional(),
  ...lifecycleShape,
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
    this.quotaReader = dependencies.quota || quota;
    this.quotaTimeoutMs = dependencies.quotaTimeoutMs ?? 25_000;
    this.authCacheTtlMs = dependencies.authCacheTtlMs ?? (dependencies.checkAuth ? 0 : 60_000);
    this.verifiedAuth = new Map();
    this.active = new Map();
    this.quotaRequests = new Map();
    this.taskTokens = new Map(); // sha256(token) -> running director/preflight run
    this.probes = new Map(); // preflight task id -> in-memory probe secrets
    this.nonces = new Map(); // preflight nonce -> { probe, capability }
    this.secrets = new Map();
    this.watchdog = new TaskWatchdog(this, dependencies.watchdog);
    this.reconciliationComplete = false;
    this.closed = false;
    this.pumping = false;
    this.historyTimer=setInterval(()=>{try{this.store.pruneHistory();}catch{/* Retain evidence and retry at the next interval. */}},3600_000);
    this.historyTimer.unref();
    this.reconciled = this.reconcileInterrupted().catch(() => {}).finally(() => { this.reconciliationComplete = true; void this.watchdog.tick().catch(() => {}); });
  }
  // Director context configures MCP; every native task also receives its own run token.
  taskContext(request) {
    return request.profile === 'director' ? { profile: 'director', port: this.config.port, directory: this.directory, readPaths: request.readPaths || [] } : null;
  }
  preflight(input) { return director.preflight(this, input); }
  preflightStatus(input) { return director.preflightStatus(this, input); }
  preflightAck(nonce, token) { return director.preflightAck(this, nonce, token); }
  serviceAck(nonce, secret) { return director.serviceAck(this, nonce, secret); }
  submitDirector(input) { return director.submitDirector(this, input); }
  directorIdentity(input) {
    const request = taskSchema.parse({ ...input, profile: 'director', kind: 'write', mode: 'execute' });
    delete request.secretEnv;
    request.workspace = allowedWorkspace(request.workspace);
    request.readPaths = [...new Set((request.readPaths || []).map(item => allowedWorkspace(item)))].sort();
    request.capabilities = [...new Set(request.capabilities?.length ? request.capabilities : CAPABILITIES)].sort();
    return createHash('sha256').update(JSON.stringify(request)).digest('hex');
  }
  // Detect enabled routes on the same adapter that resolve to the same account email.
  // An isolated profile route always takes precedence over a shared default desktop route
  // (e.g. agy-local drifting when the user switches accounts in the Antigravity desktop app).
  duplicateRouteMap() {
    const duplicates = new Map();
    const byAdapter = new Map();
    for (const route of this.config.routes) {
      if (!route.enabled || route.api) continue;
      const rawEmail = this.store.quota(route.id)?.email || route.email;
      const email = typeof rawEmail === 'string' ? rawEmail.trim().toLowerCase() : '';
      if (!email) continue;
      const key = `${route.adapter}\0${email}`;
      if (!byAdapter.has(key)) byAdapter.set(key, []);
      byAdapter.get(key).push(route);
    }
    for (const routes of byAdapter.values()) {
      if (routes.length < 2) continue;
      const canonical = routes.find(r => Boolean(r.profile)) || routes[0];
      for (const route of routes) {
        if (route.id !== canonical.id) duplicates.set(route.id, canonical.id);
      }
    }
    return duplicates;
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
      ...(member.order !== undefined ? { order: member.order } : model.order !== undefined ? { order: model.order } : {}),

      suggestedGroup: suggestGroup(`${model.id} ${model.alias}`),
      routeId: route.id,
      adapter: route.adapter,
      account: route.profile || 'default',
      enabled: route.enabled && model.enabled,
      billing,
      autoSelect: billing === 'paid_api' ? (route.billing === 'paid_api' && route.autoSelect === true) : (route.autoSelect ?? true),
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
      unique.set(key, { ...model, group: undefined, defaultEffort: source.defaultEffort, order: source.order,
        categories: (source.memberships || []).map(member => member.group) });
    }
    return [...unique.values()];
  }
  pools(input = {}) { return categoryPage(this, input); }
  select(request, options = {}) {
    validateMode(request);
    if (request.group && !this.config.categories.some(category => category.id === request.group))
      throw new PoolError('CATEGORY_NOT_FOUND', 'Kategori bulunamadı. pool_list_pools ile kategorileri sorgulayın.');
    const activeByRoute = new Map();
    for (const [taskId, handle] of this.active) {
      if (options.excludeTaskId && taskId === options.excludeTaskId) continue;
      if (handle?.routeId) activeByRoute.set(handle.routeId, (activeByRoute.get(handle.routeId) || 0) + 1);
    }
    const effectiveRemaining = model => {
      const snap = this.store.quota(model.routeId);
      const observed = snap ? Date.parse(snap.observedAt) : NaN;
      if (!snap || snap.stale || snap.networkError || !Number.isFinite(observed) || Date.now() - observed >= 60_000) return null;
      const wins = (snap.windows || []).filter(w => quotaApplies(w, model.id) && Number.isFinite(w.remainingPercent));
      if (!wins.length) return null;
      return Math.max(0, Math.min(...wins.map(w => w.remainingPercent)) - (activeByRoute.get(model.routeId) || 0) * 3);
    };
    const rejected = new Map();
    const duplicateRoutes = this.duplicateRouteMap();
    const matches = (request.group ? this.models() : this.catalogModels()).filter(model => {
      if ((request.routeId && model.routeId !== request.routeId) || (request.modelId && model.id !== request.modelId) || (request.group && model.group !== request.group)) return false;
      if (!request.routeId && duplicateRoutes.has(model.routeId)) return false;
      const snapshot = options.ignoreQuota ? null : this.store.quota(model.routeId);
      const route = this.config.routes.find(r => r.id === model.routeId);
      const reason = rejectionReason(model, route, snapshot, request, activeByRoute.get(model.routeId) || 0);
      if (reason) rejected.set(reason, (rejected.get(reason) || 0) + 1);
      return !reason; })
      .map(model => {
        const rem = effectiveRemaining(model);
        return {
          model,
          tier: nonMeteredBillings.has(model.billing) ? 0 : 1,
          remBucket: rem === null ? -1 : Math.floor(rem),
          load: activeByRoute.get(model.routeId) || 0,
          order: Number.isInteger(model.order) ? model.order : 999999,
        };
      })
      .sort((a, b) => {
        if (a.tier !== b.tier) return a.tier - b.tier;
        if (a.model.priority !== b.model.priority) return a.model.priority - b.model.priority;
        if (a.remBucket !== b.remBucket) return b.remBucket - a.remBucket;
        if (a.load !== b.load) return a.load - b.load;
        if (a.order !== b.order) return a.order - b.order;
        return a.model.routeId.localeCompare(b.model.routeId) || a.model.id.localeCompare(b.model.id);
      })
      .map(entry => entry.model);
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
      const probe = (async () => {
        if (route.adapter === 'codex' && !route.api) {
          const email = routeAccountEmail(route, this.directory);
          const emailExtra = email ? { email } : {};
          try { return { ...(await codexControl(route, cwd, this.config.python, 'quotas', this.directory)), adapter: route.adapter, billing: route.billing, loginCommand: loginCommands.codex, ...emailExtra }; }
          catch {
            let authSnap = null;
            try { await this.checkAuth(route, cwd, this.config.python, this.directory); }
            catch (error) {
              if (error.code !== 'AUTH_REQUIRED') throw error;
              authSnap = { connection: route.id, status: 'auth_required', windows: [], observedAt: new Date().toISOString(), loginCommand: loginCommands.codex, ...emailExtra };
            }
            return authSnap || (cached?.windows?.length ? { ...cached, ...emailExtra } : { connection: route.id, status: 'unknown', windows: [], observedAt: new Date().toISOString(), loginCommand: loginCommands.codex, ...emailExtra });
          }
        }
        return this.quotaReader(route, cwd, this.config.python, this.directory);
      })();
      let snapshot;
      if (this.quotaTimeoutMs > 0) {
        let timer;
        const timedOut = Symbol('quota_timeout');
        const winner = await Promise.race([
          probe,
          new Promise(resolve => { timer = setTimeout(() => resolve(timedOut), this.quotaTimeoutMs); timer.unref?.(); }),
        ]);
        clearTimeout(timer);
        if (winner === timedOut) {
          // Keep background probe error-handled so it never causes an unhandled rejection.
          void probe.then(late => {
            if (late && !late.networkError) { try { this.store.saveQuota(routeId, late); } catch { /* ignore */ } }
          }).catch(() => {});
          snapshot = cached?.windows?.length
            ? { ...cached, observedAt: cached.observedAt, stale: true, networkError: true, note: 'Canlı kota sorgusu zaman aşımına uğradı; önbellekteki son değer döndürüldü.' }
            : { connection: route.id, adapter: route.adapter, billing: route.billing, status: 'unknown', windows: [], observedAt: cached?.observedAt || new Date().toISOString(), stale: true, networkError: true, loginCommand: loginCommands[route.adapter], note: 'Canlı kota sorgusu zaman aşımına uğradı.' };
          return snapshot;
        }
        snapshot = winner;
      } else {
        snapshot = await probe;
      }
      if (snapshot.networkError && !snapshot.windows?.length && cached?.windows?.length) {
        snapshot = {
          ...cached,
          observedAt: cached.observedAt,
          stale: true,
          networkError: true,
          note: snapshot.note || cached.note,
        };
      }
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
  async selectLive(request, { allowStaleRefresh = false, maxWaitMs = 0 } = {}) {
    const routes = new Set(this.models().filter(model => model.enabled && model.kinds.includes(request.kind) &&
      (!request.group || model.group === request.group) && (!request.routeId || model.routeId === request.routeId) &&
      (!request.modelId || model.id === request.modelId) && (request.routeId || model.billing !== 'paid_api' || model.autoSelect)).map(model => model.routeId));
    // Unsupported/offline quota probes stay unknown; never invent a balance.
    const now = Date.now();
    const toAwait = [];
    for (const id of routes) {
      const cached = this.store.quota(id);
      const age = cached?.observedAt ? now - Date.parse(cached.observedAt) : Infinity;
      const pinned = Boolean(request.routeId && request.modelId);
      const blockedCache = cached?.status === 'auth_required' || cached?.status === 'rate_limited';
      if (blockedCache) {
        // Never block a user with a stale auth_required/rate_limited cache after login or reset.
        toAwait.push(this.getQuota(id, true));
        continue;
      }
      if (allowStaleRefresh && cached && (age < 60_000 || pinned)) {
        // Use valid/pinned cached quota immediately (0 ms) and refresh in background if >15s old.
        if (age >= 15_000) void this.getQuota(id).catch(() => {});
        continue;
      }
      toAwait.push(this.getQuota(id));
    }
    if (toAwait.length) {
      const work = Promise.allSettled(toAwait);
      if (maxWaitMs > 0) {
        let timer;
        await Promise.race([
          work,
          new Promise(resolve => { timer = setTimeout(resolve, maxWaitMs); timer.unref?.(); }),
        ]);
        clearTimeout(timer);
      } else {
        await work;
      }
    }
    return this.select(request);
  }
  async probeModel(input) {
    if (!input || typeof input.routeId!=='string' || typeof input.modelId!=='string' || Object.keys(input).some(key=>!['routeId','modelId','group','effort'].includes(key))) throw new PoolError('INVALID_REQUEST','Geçerli bir model seçin.');
    const root=path.join(this.directory,'probes');mkdirSync(root,{recursive:true});
    if(lstatSync(root).isSymbolicLink())throw new PoolError('UNSAFE_DATA_DIRECTORY','Test klasörü bağlantı olamaz.');
    const workspace=mkdtempSync(path.join(root,'model-'));
    return this.submitLive({...input,prompt:'Reply with exactly OK. Do not use tools or modify files.',workspace,kind:'text',timeoutSeconds:PROBE_TIMEOUT_SECONDS,clientLabel:'Model testi',idempotencyKey:`probe-${randomUUID()}`},true);
  }
  async submitLive(input, probe = false, options = {}) {
    const request = taskSchema.parse(input);
    if (request.profile === 'director' && !options.owner) throw new PoolError('OWNER_ONLY', 'Director tasks require the owner surface.');
    allowedWorkspace(request.workspace, probe?[path.join(this.directory,'probes')]:undefined);
    if (!this.store.byKey(request.idempotencyKey)) {
      await this.selectLive(request, { allowStaleRefresh: true, maxWaitMs: 2500 });
    }
    return this.submit(input,probe,options);
  }
  submit(input, probe = false, options = {}) {
    if (this.closed) throw new PoolError('SHUTTING_DOWN', 'Havuz kapanıyor. Yeniden bağlanın.');
    const request = taskSchema.parse(input);
    const secretEnv = request.secretEnv;
    delete request.secretEnv;
    if (hasLifecycle(input) && request.profile !== 'director') throw new PoolError('INVALID_REQUEST', 'Lifecycle options require profile: director.');
    if (hasLifecycle(input) && !options.owner) throw new PoolError('OWNER_ONLY', 'Director lifecycle options require the owner surface.');
    validateHook(request.onExit);
    if (secretEnv && Object.keys(secretEnv).length) request.requiresSecrets = true;
    if (request.profile === 'director') {
      if (!options.owner) throw new PoolError('OWNER_ONLY', 'Director tasks require the owner surface.');
      if (request.kind !== 'write' || request.mode !== 'execute') throw new PoolError('INVALID_REQUEST', 'A director task needs kind: write and mode: execute.');
    } else if (request.capabilities || request.readPaths) throw new PoolError('INVALID_REQUEST', 'capabilities/readPaths apply only to director tasks.');
    request.workspace = allowedWorkspace(request.workspace, probe?[path.join(this.directory,'probes')]:undefined);
    const parent = director.linkedDirector(this, options.taskToken);
    const fingerprint = createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(request).filter(([key]) => key !== 'requiresSecrets')))).digest('hex');
    const existing = this.store.byKey(request.idempotencyKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new PoolError('IDEMPOTENCY_CONFLICT', 'Aynı istek anahtarı farklı içerikle kullanıldı. Yeni bir anahtar seçin.');
      return this.get(existing.id);
    }
    const model = this.select(request).selected;
    if (request.profile === 'director') assertDirectorRoute(this.routeFor({ routeId: model.routeId }));
    if (parent) director.checkLinkedWorker(this, parent, request, model);
    request.routeId = model.routeId;
    request.modelId = model.id;
    if (request.group) request.group = model.group;
    request.effort = request.effort || model.defaultEffort;
    if(probe)request.probe=true;
    if (parent) request.parentTaskId = parent.taskId;
    if (options.preflight) request.preflight = true;
    if (options.directorIdentity) request.directorIdentity = options.directorIdentity;
    const row = { id: randomUUID(), key: request.idempotencyKey, fingerprint, workspace: request.workspace, request };
    this.store.insert(row);
    if (request.requiresSecrets) this.secrets.set(row.id, secretEnv);
    this.schedule();
    return this.get(row.id);
  }
  get(id, after = 0) {
    const task = this.store.get(id);
    if (!task) throw new PoolError('NOT_FOUND', 'Görev bulunamadı. Görev kimliğini kontrol edin.');
    const request = JSON.parse(task.request);
    const events = this.store.events(id, after);
    const reportedModel = this.store.reportedModel(id);
    const sessionId = this.store.sessionId(id) || request.sessionId || null;
    const report = request.mode === 'execute' && task.result ? parseExecutionReport(task.result) : null;
    const originalError = this.store.originalError(id);
    return { notifications: this.store.notifications(task.id), profile: request.profile || 'worker', parentTaskId: request.parentTaskId || null, preflight: request.preflight ? this.store.preflightForTask(task.id) : undefined, id: task.id, state: task.state, mode: request.mode || null, report, routeId: request.routeId, modelId: request.modelId, reportedModel, sessionId, queueReason: null, blockedBy: null, group: request.group, effort: request.effort || null, clientLabel:request.clientLabel || null, historyExpired:Boolean(request.historyExpired), kind: request.kind, workspace: request.workspace, prompt: request.prompt || null, created: task.created, updated: task.updated, result: task.result, error: task.error, ...(originalError ? { originalError } : {}), errorDetail: this.store.errorDetail(id), events };
  }
  list(limit = 50, offset = 0, activeFirst = false) {
    return this.store.list(limit, offset, activeFirst);
  }
  cancel(id, reason = 'CANCELLED') {
    const task = this.store.get(id);
    if (!task) throw new PoolError('NOT_FOUND', 'Görev bulunamadı.');
    if (task.state === 'queued') { director.failQueuedPreflight(this, id, reason); this.store.update(id, 'cancelled', null, reason); this.secrets.delete(id); void this.watchdog.tick().catch(() => {}); this.schedule(); }
    else if (['starting', 'running'].includes(task.state)) {
      this.store.update(id, 'cancelling');
      const handle = this.active.get(id);
      if (handle) { handle.cancelled = true; handle.cancelReason = reason; handle.run?.cancel(reason); }
    }
    return this.get(id);
  }
  resolveInspected(input) {
    const { taskId, note } = z.object({ taskId: z.string().uuid(), reviewed: z.literal(true), note: z.string().trim().min(1).max(600) }).strict().parse(input);
    const task = this.store.get(taskId);
    if (!task) throw new PoolError('NOT_FOUND', 'Görev bulunamadı.');
    if (task.state !== 'needs_review' || this.active.has(taskId)) throw new PoolError('INVALID_STATE', 'Yalnızca durmuş ve dosyaları incelenmiş görev çözümlenebilir.');
    if (task.error && task.error !== 'MANUALLY_RESOLVED') this.store.event(taskId, 'original_error', task.error);
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
      let queued;
      try { queued = this.store.queued(); } catch {
        this.closed = true; // A storage fault stops admission; never claim an unpersisted success.
        for (const handle of this.active.values()) handle.run?.cancel('STORAGE_FAILED');
        return;
      }
      for (const task of queued) {
        let request;
        try { request = JSON.parse(task.request); } catch {
          try { this.store.update(task.id, 'failed', null, 'INVALID_REQUEST'); } catch { /* ignore */ }
          continue;
        }
        try {
          const route = this.config.routes.find(r => r.id === request.routeId);
          if (!route || !route.enabled) { director.failQueuedPreflight(this, task.id, 'ROUTE_DISABLED'); this.store.update(task.id, 'failed', null, 'ROUTE_DISABLED'); void this.watchdog.tick().catch(() => {}); continue; }
          if (request.startDeadlineSeconds && this.watchdog.now() - Date.parse(task.created) >= request.startDeadlineSeconds * 1000) { this.cancel(task.id, 'START_TIMEOUT'); continue; }
          if (request.requiresSecrets && !this.secrets.has(task.id)) { this.store.update(task.id, 'failed', null, 'SECRET_LOST'); void this.watchdog.tick().catch(() => {}); continue; }
          this.store.update(task.id, 'starting');
          const handle = { routeId: route.id, cancelled: false, run: null };
          this.active.set(task.id, handle);
          handle.done = this.run(task, request, route, handle);
        } catch {
          this.closed = true; // A storage fault stops admission; never claim an unpersisted success.
          for (const handle of this.active.values()) handle.run?.cancel('STORAGE_FAILED');
          break;
        }
      }
    });
  }
  authCacheKey(route, model) {
    return `${route.id}|${route.billing}|${route.trustedSettings ? 1 : 0}|${route.profile || ''}|${route.runtime || ''}|${route.api?.secretRef || ''}|${route.adapter === 'qwen' ? (model?.id || '') : ''}`;
  }
  async verifyRouteAuth(route, workspace, model) {
    const key = this.authCacheKey(route, model);
    if (this.authCacheTtlMs > 0) {
      const verifiedAt = this.verifiedAuth.get(key);
      if (verifiedAt && Date.now() - verifiedAt < this.authCacheTtlMs) return;
    }
    await this.checkAuth(route, workspace, this.config.python, this.directory, model);
    if (this.authCacheTtlMs > 0) this.verifiedAuth.set(key, Date.now());
    if (this.store.quota(route.id)?.status === 'auth_required') {
      try { this.store.deleteQuota(route.id); } catch { /* best-effort */ }
      void this.getQuota(route.id, true).catch(() => {});
    }
  }
  async run(task, request, route, handle) {
    try {
      request.workspace = allowedWorkspace(request.workspace, request.probe?[path.join(this.directory,'probes')]:undefined);
      const model = this.select(request, { excludeTaskId: task.id }).selected;
      await this.verifyRouteAuth(route, request.workspace, model);
      if (handle.cancelled || this.closed) { director.failQueuedPreflight(this, task.id, handle.cancelReason || 'CANCELLED'); this.store.update(task.id, 'cancelled', null, handle.cancelReason || 'CANCELLED'); return; }
      const context = this.taskContext(request) || { directory: this.directory };
      context.secretEnv = this.secrets.get(task.id) || {};
      if (request.requiresSecrets && !this.secrets.has(task.id)) throw new PoolError('SECRET_LOST', 'Task secrets were lost on service restart.');
      context.onActivity = () => { handle.activity = this.watchdog.now(); };
      await director.beforeRun(this, task.id, request, context, handle);
      const redactToken = handle.redact;
      const secrets = Object.values(context.secretEnv).filter(secret => typeof secret === 'string' && secret.length >= 6);
      if (route.api?.secretRef) {
        try { const apiKey = loadSecret(this.directory, route.api.secretRef); if (apiKey && apiKey.length >= 6) secrets.push(apiKey); } catch { /* validated later by adapter */ }
      }
      handle.redact = text => typeof text === 'string' ? redact(secrets.reduce((value, secret) => value.split(secret).join('[SECRET]'), redactToken(text))) : text;
      if (handle.cancelled || this.closed) throw new PoolError(handle.cancelReason || 'CANCELLED', 'Görev başlamadan iptal edildi.');
      this.store.update(task.id, 'running');
      handle.startedAt = this.watchdog.now();
      handle.activity = handle.startedAt;
      let events = 0;
      handle.run = this.execute(route, model, request, this.config.python, detail => {
        handle.activity = this.watchdog.now();
        if (typeof detail === 'string' && detail.startsWith('session:')) {
          const sid = detail.slice(8).trim();
          if (sid && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(sid)) this.store.event(task.id, 'session', handle.redact ? handle.redact(sid) : sid);
          return;
        }
        if (events++ < 400) this.store.event(task.id, 'progress', handle.redact ? handle.redact(detail) : detail);
      }, this.directory, context);
      const outcome = await handle.run.done;
      if (handle.redact) { if (outcome.result) outcome.result = handle.redact(outcome.result); if (outcome.detail) outcome.detail = handle.redact(outcome.detail); }
      if (outcome.detail) this.store.event(task.id, 'error_detail', outcome.detail);
      if (outcome.error === 'QUOTA_EXHAUSTED') {
        const previous = this.store.quota(route.id);
        if (route.adapter === 'qwen') {
          this.store.saveQuota(route.id, {
            connection: route.id, adapter: route.adapter, billing: route.billing,
            status: 'unknown', auth: previous?.auth || 'credentials_present', windows: [],
            source: 'cli-run-rejection', observedAt: new Date().toISOString(), modelId: model.id,
            note: 'Son gerçek CLI çağrısı sağlayıcı tarafından kota/kredi nedeniyle reddedildi; kalan kota yüzdesi bilinmiyor.',
          });
        } else {
          let matched = false;
          const updatedWindows = (previous?.windows || []).map(window => {
            if (quotaApplies(window, model.id)) {
              matched = true;
              return { ...window, remainingPercent: 0 };
            }
            return window;
          });
          if (!matched) updatedWindows.push({ name: `${model.id}:exhausted`, remainingPercent: 0, models: [model.id] });
          const scope = previous?.scope || (route.adapter === 'agy' ? 'model' : 'account');
          const status = scope === 'model' && updatedWindows.some(w => Number(w.remainingPercent) > 0) ? 'available' : 'rate_limited';
          this.store.saveQuota(route.id, {
            connection: route.id, adapter: route.adapter, billing: route.billing,
            ...(previous?.email ? { email: previous.email } : {}),
            status, scope, auth: previous?.auth || 'credentials_present', windows: updatedWindows,
            source: 'cli-run-rejection', observedAt: new Date().toISOString(), modelId: model.id,
            note: 'Son gerçek CLI çağrısı sağlayıcı tarafından kota/kredi nedeniyle reddedildi.',
          });
        }
      } else if (outcome.error === 'AUTH_REQUIRED') {
        this.verifiedAuth.clear();
        const previous = this.store.quota(route.id);
        this.store.saveQuota(route.id, {
          connection: route.id, adapter: route.adapter, billing: route.billing,
          ...(previous?.email ? { email: previous.email } : {}),
          status: 'auth_required', auth: 'missing', windows: [],
          source: 'cli-run-auth-error', observedAt: new Date().toISOString(),
          note: 'Son CLI çağrısı oturum/yetki hatası döndürdü; yeniden giriş yapın.',
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
      await handle.beforeSettle?.({ ...outcome, cancelled: handle.cancelled });
      if (handle.cancelled) this.store.update(task.id, 'cancelled', null, handle.cancelReason || 'CANCELLED');
      else if (outcome.error) this.store.update(task.id, outcome.error === 'TIMEOUT' ? 'timed_out' : 'failed', outcome.result || null, outcome.error);
      else if (request.mode === 'execute') {
        const report = parseExecutionReport(outcome.result);
        const error = !report ? 'INVALID_REPORT' : report.status !== 'completed' ? 'WORK_INCOMPLETE' : null;
        this.store.update(task.id, !error ? 'succeeded' : 'failed', outcome.result, error);
      } else this.store.update(task.id, 'succeeded', outcome.result);
    } catch (error) {
      try {
        if (error instanceof PoolError && error.code === 'AUTH_REQUIRED') {
          const previous = this.store.quota(route.id);
          this.store.saveQuota(route.id, {
            connection: route.id, adapter: route.adapter, billing: route.billing,
            ...(previous?.email ? { email: previous.email } : {}),
            status: 'auth_required', auth: 'missing', windows: [],
            source: 'cli-auth-check', observedAt: new Date().toISOString(),
            note: error.message || 'CLI oturumu gerekli.',
          });
        }
        await director.settlePreflight(this, task.id, { cancelled: handle.cancelled, error: error instanceof PoolError ? error.code : 'INTERNAL_ERROR', message: error instanceof PoolError ? error.message : null }).catch(() => {});
        const finalCode = handle.cancelled ? (handle.cancelReason || 'CANCELLED') : (error instanceof PoolError ? error.code : 'INTERNAL_ERROR');
        this.store.update(task.id, handle.cancelled ? 'cancelled' : 'failed', null, finalCode);
        if (error instanceof PoolError && error.message) this.store.event(task.id, 'error_detail', (handle.redact ? handle.redact(error.message) : error.message).slice(0, 600));
      }
      catch { this.closed = true; handle.run?.cancel('STORAGE_FAILED'); }
    } finally {
      handle.release?.();
      this.active.delete(task.id);
      this.secrets.delete(task.id);
      if (request.probe && request.workspace) { try { rmSync(request.workspace, { recursive: true, force: true }); } catch { /* best-effort */ } }
      void this.watchdog.tick().catch(() => {});
      this.schedule();
    }
  }
  routeFor(request) { return this.config.routes.find(route => route.id === request.routeId); }
  async reconcileInterrupted() {
    const startup = this.store.startupInterrupted || [];
    this.store.startupInterrupted = [];
    const seen = new Set();
    for (const task of [...startup, ...this.store.interrupted()]) {
      if (seen.has(task.id)) continue;
      seen.add(task.id);
      try {
        const request = JSON.parse(task.request);
        director.cleanupInterrupted(request, task.id);
        if (task.state === 'needs_review') this.store.update(task.id, 'failed', task.result, 'INTERRUPTED');
      } catch { /* ignore cleanup error */ }
    }
    this.schedule();
    this.onReconciled?.();
  }
  async close() {
    this.closed = true;
    clearInterval(this.historyTimer);
    await this.watchdog.close();
    const pending = [...this.active.values()];
    for (const handle of pending) { handle.cancelled = true; handle.cancelReason = 'CANCELLED'; handle.run?.cancel('CANCELLED'); }
    await Promise.allSettled(pending.map(handle => handle.done));
    await Promise.allSettled(this.quotaRequests.values());
  }
}
