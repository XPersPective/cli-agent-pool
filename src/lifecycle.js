// pb-director/1 service mechanisms. Relay ownership stays with the caller.
import path from 'node:path';
import { lstatSync } from 'node:fs';
import { z } from 'zod';
import { PoolError } from './config.js';
import { runProcess } from './process.js';

export const lifecycleShape = {
  onExit: z.object({ argv: z.array(z.string().min(1).max(4096).refine(v => !v.includes('\0'))).min(1).max(64), timeoutSeconds: z.number().int().min(1).max(600).default(300) }).strict().optional(),
  ackDeadlineSeconds: z.number().int().min(60).max(3600).optional(),
  startDeadlineSeconds: z.number().int().min(60).max(86400).optional(),
  idleTimeoutSeconds: z.number().int().min(300).max(86400).optional(),
  secretEnv: z.record(z.string().regex(/^PB_[A-Z_]{1,32}$/), z.string().min(1).max(4096)).refine(v => Object.keys(v).length <= 16).optional(),
};
export const directorFeatures = { contracts: ['pb-director/1'], features: ['directorProfile', 'preflight', 'onExit', 'ack', 'idle', 'secretEnv', 'resolve', 'releaseLockOnFailure'] };
export const terminal = state => ['succeeded', 'failed', 'timed_out', 'cancelled', 'needs_review'].includes(state);
export const hasLifecycle = request => Object.keys(lifecycleShape).some(key => request[key] !== undefined);

export function validateHook(hook) {
  if (!hook) return;
  const file = hook.argv[0];
  let regular = false;
  try { const info = lstatSync(file); regular = info.isFile() && !info.isSymbolicLink(); } catch { /* invalid */ }
  if (!path.isAbsolute(file) || !regular || /\.(cmd|bat|ps1)$/i.test(file))
    throw new PoolError('INVALID_REQUEST', 'onExit.argv[0] must be an absolute existing native executable (invoke scripts through their interpreter).');
}

export class TaskWatchdog {
  constructor(pool, { now = Date.now, autoTick = true, runHook = runProcess } = {}) {
    this.pool = pool;
    this.now = now;
    this.runHook = runHook;
    this.hooks = new Map();
    this.closed = false;
    if (autoTick) { this.timer = setInterval(() => { void this.tick().catch(() => {}); }, 1000); this.timer.unref(); }
  }
  ack(taskId) {
    const task = this.pool.store.get(taskId);
    if (!task) throw new PoolError('NOT_FOUND', 'Task not found.');
    const handle = this.pool.active.get(taskId);
    if (task.state !== 'running' || !handle) throw new PoolError('INVALID_STATE', 'Only a running task can acknowledge takeover.');
    if (!handle.acked) { handle.acked = true; this.pool.store.event(taskId, 'ack', 'Takeover acknowledged.'); }
    return { acknowledged: true, taskId };
  }
  async tick() {
    if (this.closed || this.evaluating) return;
    this.evaluating = true;
    try {
      const now = this.now();
      for (const task of this.pool.store.queued()) {
        const request = JSON.parse(task.request);
        if (request.startDeadlineSeconds && now - Date.parse(task.created) >= request.startDeadlineSeconds * 1000) this.pool.cancel(task.id, 'START_TIMEOUT');
      }
      for (const [id, handle] of this.pool.active) {
        if (!handle.startedAt || handle.cancelled) continue;
        const request = JSON.parse(this.pool.store.get(id).request);
        if (request.ackDeadlineSeconds && !handle.acked && now - handle.startedAt >= request.ackDeadlineSeconds * 1000) {
          this.pool.cancel(id, 'ACK_TIMEOUT'); continue;
        }
        const workerRunning = this.pool.store.children(id).some(child => ['starting', 'running', 'cancelling'].includes(child.state));
        if (workerRunning) handle.activity = now;
        if (request.idleTimeoutSeconds && !workerRunning && now - handle.activity >= request.idleTimeoutSeconds * 1000) this.pool.cancel(id, 'IDLE_TIMEOUT');
      }
      // Reconciliation fixes startup lock state before a hook can call back into Pool.
      if (!this.pool.reconciliationComplete) return;
      for (const row of this.pool.store.pendingHooks(now)) {
        if (this.pool.active.has(row.task_id) || this.hooks.has(row.task_id)) continue;
        if (!this.pool.store.claimHook(row.task_id)) continue;
        const pending = this.invoke(row).catch(() => { this.pool.store.finishHook(row.task_id); }).finally(() => this.hooks.delete(row.task_id));
        this.hooks.set(row.task_id, pending);
      }
    } finally { this.evaluating = false; }
  }
  async invoke(row) {
    const task = this.pool.store.get(row.task_id);
    const request = JSON.parse(row.request);
    try { validateHook(request.onExit); }
    catch { this.pool.store.event(task.id, 'on_exit', 'Hook executable unavailable.'); this.pool.store.finishHook(task.id); return; }
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^PB_|^CAP_TASK_|^CLI_AGENT_POOL_(WORKER|TASK_TOKEN|TASK_ID)$/i.test(key)));
    let notices = 0;
    const handle = this.runHook({ argv: request.onExit.argv, cwd: task.workspace, python: this.pool.config.python,
      extraEnv: { ...env, CLI_AGENT_POOL_HOME: this.pool.directory, CAP_TASK_ID: task.id, CAP_TASK_STATE: task.state, CAP_TASK_ERROR: task.error || '' },
      timeoutMs: request.onExit.timeoutSeconds * 1000, maxBytes: 1_048_576,
      onLine: line => { if (line.startsWith('CAP_NOTIFY ') && notices++ < 10) this.pool.store.event(task.id, 'notification', line.slice(11, 611)); } });
    const result = await handle.done;
    const output = Buffer.from(`${result.output || ''}\n${result.stderr || ''}`).subarray(-2048).toString('utf8');
    this.pool.store.event(task.id, 'on_exit', JSON.stringify({ attempt: row.attempts + 1, code: result.code, error: result.stopReason, output }));
    this.pool.store.finishHook(task.id, !result.stopReason && result.code === 75 && row.attempts < 3 ? this.now() + 30_000 : null);
  }
  async close() { this.closed = true; clearInterval(this.timer); await Promise.allSettled(this.hooks.values()); }
}
