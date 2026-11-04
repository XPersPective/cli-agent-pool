const actions = {
  PREFLIGHT_REQUIRED: ['Owner: run cli-agent-pool preflight for the exact route/model/effort/workspace/readPaths before submitting a director.', 'pool_preflight_status'],
  PREFLIGHT_FAILED: ['Read each failed capability and its native permission fix; owner re-runs preflight after repair.', 'pool_preflight_status'],
  PROJECT_AMBIGUOUS: ['Keep one native Antigravity project mapping the deepest workspace root; the task error names the conflicting files.', 'pool_get_task'],
  PROJECT_REQUIRED: ['Map the external worker worktree parent in an owner Antigravity project before submitting.', 'pool_get_task'],
  PROFILE_UNSUPPORTED: ['Directors require native Claude/Codex/Antigravity non-paid routes; WSL/API/custom routes are unsupported.', 'pool_catalog'],
  OWNER_ONLY: ['Run this operation from the owner session outside a Pool worker.', 'pool_help'],
  SECRET_LOST: ['Queued task secrets were lost at service restart. Inspect the stopped task before a new owner submission.', 'pool_get_task'],
  ACK_TIMEOUT: ['Director did not acknowledge takeover before its deadline. Inspect the stopped task and relay recovery status.', 'pool_get_task'],
  START_TIMEOUT: ['Queued director did not start before its deadline. Inspect blockedBy; resolve only relay-owned inspected locks.', 'pool_get_task'],
  IDLE_TIMEOUT: ['Director produced no native output and had no running linked worker before its idle deadline. Inspect its task.', 'pool_get_task'],
  TASK_TOKEN_LOST: ['Parent execution ended; stop using its old task token. Do not start an unlinked replacement.', 'pool_get_task'],
  WORKSPACE_HELD_BY_PARENT: ['Place workers in caller-prepared sibling worktrees outside their parent director workspace.', 'pool_get_task'],

  AUTH_REQUIRED: ['Complete native CLI login for the route, then query its quota/status.', 'pool_get_quotas'],
  MODEL_UNAVAILABLE: ['Query the model catalog; native CLI may not expose the requested model/account.', 'pool_catalog'],
  BILLING_UNCONFIRMED: ['Owner must configure the route billing/account in Settings.', 'pool_catalog'],
  SUBSCRIPTION_REQUIRED: ['The native provider reports a missing plan; complete native login/plan setup.', 'pool_get_quotas'],
  QUOTA_EXHAUSTED: ['Check the provider reset/balance. Use another model only when caller instructions allow it.', 'pool_get_quotas'],
  CREDITS_REQUIRED: ['Provider requires credits; no paid fallback was enabled.', 'pool_get_quotas'],
  CATEGORY_NOT_FOUND: ['Read current category IDs; catalog models do not require a category.', 'pool_list_pools'],
  NO_ROUTE: ['Check exact model/route or category and cached quota. Disabled/hidden models stay excluded.', 'pool_catalog'],
  PERMISSION_REQUIRED: ['Review the native CLI denied tool for the workspace. Pool does not bypass native permissions.', 'pool_get_task'],
  WORKSPACE_REVIEW_REQUIRED: ['Inspect the interrupted task and actual files before owner resolution. Do not replay it.', 'pool_get_task'],
  INVALID_REPORT: ['Inspect the retained output and files. Do not repeat a write to repair formatting.', 'pool_get_task'],
  WORK_INCOMPLETE: ['Read the report blockers and actual files before deciding the next task.', 'pool_get_task'],
  INVALID_REQUEST: ['Check the tool schema, required fields and supported effort/kind.', 'pool_help'],
  IDEMPOTENCY_CONFLICT: ['A request key belongs to different content. Resume the original task or use a new key for a new task.', 'pool_get_task'],
  TIMEOUT: ['Inspect the existing task; do not automatically replay a started write.', 'pool_get_task'],
  SETTINGS_NOT_TRUSTED: ['Owner should review the native route settings in the UI.', 'pool_get_quotas'],
  PROVIDER_RESTRICTION: ['Native provider/client restrictions apply. Pool does not use another billing source.', 'pool_get_quotas'],
};
export function serviceHelp(code) {
  if (code) {
    const [action, tool] = actions[code] || ['Inspect this task or route. Keep its ID; do not replay a started task.', 'pool_get_task'];
    return { code, action, tool };
  }
  return { entries: { pools: 'pool_list_pools {} -> category summaries; {group:id} -> model page', catalog: 'pool_catalog {} -> sources; {billing,adapter,query} or {view:models} -> model page' },
    run: 'pool_submit: prompt,workspace,kind,idempotencyKey; group optional; routeId/modelId optional; mode execute for implementation',
    result: 'pool_get_task {taskId}; compact by default; keep the returned ID',
    errors: 'pool_help {code}; pool_get_quotas {routeId} for live status',
    pagination: 'limit <= 40 (default 12); nextOffset -> offset',
    permissions: 'Caller chooses catalog/category/model. Disabled/hidden entries and native CLI checks still apply.' };
}
