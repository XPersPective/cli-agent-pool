// Director profile glue for Pool: preflight runs, admission, per-run task
// tokens (lease) and worker links. See docs/director-tasks.md.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { PoolError, allowedWorkspace, overlaps } from './config.js';
import { agyProjectMatches } from './agy-project.js';
import { profileHome } from './profiles.js';
import { serviceHelp } from './service-help.js';
import {
  CAPABILITIES, PREFLIGHT_RETRY_MS, PREFLIGHT_TIMEOUT_SECONDS, assertDirectorRoute, validateReadPaths, normalizeCapabilities,
  preflightKey, cachedUsable, gitFacts, poolRemoteDigest, createProbe, writeProbe, probePrompt, verifyProbe, cleanupProbe,
  probeDirectory, fixFor, projectFileFor, summarize, defaultReadRoots,
} from './preflight.js';

const sha = value => createHash('sha256').update(value).digest('hex');
const sameSecret = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export const preflightSchema = z.object({
  routeId: z.string().min(1).max(100),
  modelId: z.string().max(100).optional(),
  effort: z.string().max(100).optional(),
  workspace: z.string().min(1).max(4096),
  capabilities: z.array(z.enum(CAPABILITIES)).max(6).optional(),
  readPaths: z.array(z.string().min(1).max(4096)).max(8).optional(),
  force: z.boolean().optional(),
}).strict();

// Resolves everything a preflight result is keyed on, without running a model.
export async function preflightScope(pool, input, options = {}) {
  const request = preflightSchema.parse(input);
  const route = pool.config.routes.find(item => item.id === request.routeId);
  assertDirectorRoute(route);
  const workspace = allowedWorkspace(request.workspace);
  const model = pool.select({ kind: 'write', mode: 'execute', routeId: route.id, ...(request.modelId ? { modelId: request.modelId } : {}), effort: request.effort }, options).selected;
  const capabilities = normalizeCapabilities(request.capabilities);
  const readPaths = validateReadPaths(request.readPaths || [], pool.config.directorReadRoots || defaultReadRoots());
  const effort = request.effort || model.defaultEffort || null;
  if (model.billing === 'paid_api') throw new PoolError('PAID_ROUTE_DENIED', 'Directors cannot use a paid model billing override.');
  const scope = JSON.stringify([route.id, model.id, effort, workspace, capabilities, readPaths]);
  const key = await preflightKey({ route, modelId: model.id, effort, workspace, capabilities, readPaths, directory: pool.directory, python: pool.config.python });
  return { request, route, model, effort, workspace, capabilities, readPaths, scope, key };
}

const quote = value => /[\s"]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
export function preflightCommand(scope) {
  return ['cli-agent-pool preflight', `--route ${scope.route.id}`, `--model ${quote(scope.model.id)}`, ...(scope.effort ? [`--effort ${quote(scope.effort)}`] : []), `--workspace ${quote(scope.workspace)}`,
    ...scope.readPaths.map(item => `--read-path ${quote(item)}`),
    ...(scope.capabilities.length === CAPABILITIES.length ? [] : scope.capabilities.map(item => `--capability ${item}`))].join(' ');
}

// Admission decision for a director on one route/model/workspace.
export function admission(pool, scope, now = Date.now()) {
  const cached = cachedUsable(pool.store.preflight(scope.scope), scope.key, now);
  if (!cached) return { ready: false, code: 'PREFLIGHT_REQUIRED', message: `No current preflight for route ${scope.route.id} / ${scope.model.id} in ${scope.workspace} (missing, expired, or native settings/CLI version changed). Run: ${preflightCommand(scope)}` };
  if (cached.status === 'ready') return { ready: true, entry: cached };
  const failures = Object.entries(cached.capabilities || {}).filter(([, value]) => value.status === 'failed').map(([name, value]) => `${name}: ${value.fix || value.detail || 'failed'}`);
  const retry = cached.retryAfter && Date.parse(cached.retryAfter) > now ? ` Retry after ${cached.retryAfter}.` : '';
  return { ready: false, code: 'PREFLIGHT_FAILED', entry: cached, retryPending: Boolean(retry),
    message: `Preflight failed for route ${scope.route.id} / ${scope.model.id}${cached.runError ? ` (${cached.runError}: ${cached.runMessage || serviceHelp(cached.runError).action})` : ''}. ${failures.join(' | ')}${retry} After fixing, run: ${preflightCommand(scope)} --force`.slice(0, 1800) };
}

export async function preflight(pool, input) {
  const scope = await preflightScope(pool, input);
  const decision = admission(pool, scope);
  if (!scope.request.force && (decision.ready || decision.retryPending)) return { cached: true, current: true, ready: decision.ready, ...summarize(decision.entry) };
  for (const [taskId, probe] of pool.probes) if (probe.scope === scope.scope) return { cached: false, id: taskId, taskId, state: pool.get(taskId).state };
  const facts = await gitFacts(scope.workspace, pool.config.python);
  // Scope/version/git discovery yields; another request may have registered meanwhile.
  for (const [taskId, probe] of pool.probes) if (probe.scope === scope.scope) return { cached: false, id: taskId, taskId, state: pool.get(taskId).state };
  const task = pool.submit({
    prompt: 'CLI Agent Pool preflight probe (steps are supplied at run time).', workspace: scope.workspace, kind: 'write', mode: 'execute',
    profile: 'director', routeId: scope.route.id, modelId: scope.model.id, effort: scope.effort || undefined, capabilities: scope.capabilities, readPaths: scope.readPaths,
    clientLabel: 'Preflight', timeoutSeconds: PREFLIGHT_TIMEOUT_SECONDS, idempotencyKey: `preflight-${randomUUID()}`,
  }, false, { owner: true, preflight: true });
  const probe = createProbe({ taskId: task.id, workspace: scope.workspace, port: pool.config.port, capabilities: scope.capabilities, readPaths: scope.readPaths, facts });
  Object.assign(probe, { scope: scope.scope, key: scope.key, route: scope.route });
  pool.probes.set(task.id, probe);
  pool.nonces.set(probe.mcpNonce, { probe, capability: 'poolMcp' });
  pool.nonces.set(probe.serviceNonce, { probe, capability: 'poolService' });
  return { cached: false, id: task.id, taskId: task.id, state: task.state };
}

export async function preflightStatus(pool, input) {
  const scope = await preflightScope(pool, { ...input, force: undefined }, { ignoreQuota: true });
  const entry = pool.store.preflight(scope.scope);
  const decision = admission(pool, scope);
  return { ...(summarize(entry) || {}), current: Boolean(cachedUsable(entry, scope.key)), ready: decision.ready, ...(decision.ready ? {} : { code: decision.code, message: decision.message }) };
}

export function preflightAck(pool, nonce, token) {
  const entry = typeof nonce === 'string' ? pool.nonces.get(nonce) : null;
  if (!entry || entry.capability !== 'poolMcp') throw new PoolError('NOT_FOUND', 'Unknown or expired preflight nonce.');
  const run = token ? pool.taskTokens.get(sha(token)) : null;
  entry.probe.acks.set('poolMcp', { at: Date.now(), token: Boolean(run && run.taskId === entry.probe.taskId) });
  return { acknowledged: true };
}

export function serviceAck(pool, nonce, secret) {
  const entry = typeof nonce === 'string' ? pool.nonces.get(nonce) : null;
  if (!entry || entry.capability !== 'poolService' || !sameSecret(secret, entry.probe.secrets.service)) return false;
  pool.nonces.delete(nonce);
  entry.probe.acks.set('poolService', { at: Date.now() });
  return true;
}

export async function submitDirector(pool, input, options = {}) {
  const identity = pool.directorIdentity(input);
  const existing = pool.store.byKey(input.idempotencyKey);
  if (existing) {
    if (JSON.parse(existing.request).directorIdentity !== identity) throw new PoolError('IDEMPOTENCY_CONFLICT', 'This key belongs to different task content.');
    return pool.get(existing.id);
  }
  const { readPaths, capabilities, routeId, modelId, workspace, effort } = input;
  if (!routeId) throw new PoolError('INVALID_REQUEST', 'A director task pins routeId (and usually modelId).');
  const scope = await preflightScope(pool, { routeId, modelId, effort, workspace, capabilities, readPaths });
  const decision = admission(pool, scope);
  if (!decision.ready) throw new PoolError(decision.code, decision.message);
  return pool.submit({ ...input, profile: 'director', kind: 'write', mode: 'execute', modelId: scope.model.id, readPaths: scope.readPaths, capabilities: scope.capabilities }, false, { owner: true, ...options, directorIdentity: identity });
}

// Every running task has a memory-only token. Invalid/stale tokens fail closed.
export function linkedDirector(pool, token) {
  if (!token) return null;
  const run = pool.taskTokens.get(sha(token));
  if (!run) throw new PoolError('TASK_TOKEN_LOST', 'The parent task is no longer running.');
  return run;
}

export function checkLinkedWorker(pool, parent, request, model) {
  if (model.billing === 'paid_api') throw new PoolError('PAID_ROUTE_DENIED', 'Workers started by a director use non-metered routes only.');
  if (parent.workspace && overlaps(parent.workspace, request.workspace))
    throw new PoolError('WORKSPACE_HELD_BY_PARENT', 'The director holds this workspace. Start workers in a worktree outside it (for example a sibling folder created with git worktree add).');
  const route = pool.config.routes.find(item => item.id === model.routeId);
  if (route?.adapter === 'agy' && route.runtime !== 'wsl') {
    const agyHome = pool.directory ? profileHome(route, pool.directory) : undefined;
    if (agyProjectMatches(request.workspace, agyHome).length === 0 && agyProjectMatches(request.workspace).length === 0)
      throw new PoolError('PROJECT_REQUIRED', `No Antigravity project maps ${request.workspace}; a worker would run without the owner's grants. Add the worktrees' parent folder to an Antigravity project first.`);
  }
}

// Runs inside Pool.run after the workspace snapshot, before the CLI starts.
export async function beforeRun(pool, taskId, request, context, handle) {
  const token = randomBytes(32).toString('hex');
  const tokenHash = sha(token);
  context.token = token;
  context.taskId = taskId;
  handle.redact = text => typeof text === 'string' ? text.split(token).join('[LEASE]') : text;
  const run = { taskId, workspace: request.workspace, director: request.profile === 'director', preflight: Boolean(request.preflight) };
  pool.taskTokens.set(tokenHash, run);
  handle.release = () => { pool.taskTokens.delete(tokenHash); };
  if (!request.preflight) return;
  const probe = pool.probes.get(taskId);
  if (!probe) throw new PoolError('PREFLIGHT_EXPIRED', 'Preflight secrets were lost (service restart). Run preflight again.');
  probe.remoteBefore = probe.facts.origin ? await poolRemoteDigest(probe.workspace, pool.config.python) : null;
  writeProbe(probe);
  context.promptOverride = probePrompt(probe);
  context.watch = { scope: path.basename(probe.dir), markers: ['shell-a', 'shell-b', 'shell-c'], events: probe.markers, reads: probe.reads };
  handle.beforeSettle = outcome => settlePreflight(pool, taskId, outcome);
}

// Queued tasks never created probe files; persist their failure synchronously.
export function failQueuedPreflight(pool, taskId, error) {
  const probe = pool.probes.get(taskId);
  if (!probe || probe.created) return;
  const capabilities = Object.fromEntries(probe.capabilities.map(name => [name, { status: 'failed', detail: `Preflight run failed: ${error}.` }]));
  const entry = savePreflight(pool, probe, { capabilities, runError: error });
  pool.store.event(taskId, 'preflight', JSON.stringify(summarize(entry)));
  pool.probes.delete(taskId);
  pool.nonces.delete(probe.mcpNonce);
  pool.nonces.delete(probe.serviceNonce);
}

export async function settlePreflight(pool, taskId, outcome) {
  const probe = pool.probes.get(taskId);
  if (!probe || probe.settled) return;
  probe.settled = true;
  try {
    const verdict = await verifyProbe(probe, { python: pool.config.python, remoteBefore: probe.remoteBefore, outcome });
    const entry = savePreflight(pool, probe, verdict);
    pool.store.event(taskId, 'preflight', JSON.stringify(summarize(entry)));
  } finally {
    if (probe.created) cleanupProbe(probe.dir, probe.reads.length);
    pool.probes.delete(taskId);
    pool.nonces.delete(probe.mcpNonce);
    pool.nonces.delete(probe.serviceNonce);
  }
}

export function savePreflight(pool, probe, verdict) {
  const projectFile = projectFileFor(probe.route, probe.workspace, pool.directory);
  const capabilities = Object.fromEntries(Object.entries(verdict.capabilities).map(([name, value]) => [name,
    value.status === 'failed' ? { ...value, fix: verdict.runError ? (verdict.runMessage || serviceHelp(verdict.runError).action) : fixFor(probe.route, name, { workspace: probe.workspace, projectFile }) } : value]));
  const failed = Boolean(verdict.runError) || Object.values(capabilities).some(value => value.status === 'failed');
  const entry = { key: probe.key, status: failed ? 'failed' : 'ready', capabilities, singleInvocation: verdict.singleInvocation, taskToken: verdict.taskToken,
    runError: verdict.runError, ...(verdict.runMessage ? { runMessage: verdict.runMessage.slice(0, 600) } : {}), taskId: probe.taskId, observedAt: new Date().toISOString(),
    ...(failed && verdict.runError ? { retryAfter: new Date(Date.now() + PREFLIGHT_RETRY_MS).toISOString() } : {}) };
  pool.store.savePreflight(probe.scope, entry);
  return entry;
}

// Startup cleanup for a preflight interrupted by a restart.
export function cleanupInterrupted(request, taskId) {
  if (!request.preflight) return;
  cleanupProbe(probeDirectory(request.workspace, taskId));
}
