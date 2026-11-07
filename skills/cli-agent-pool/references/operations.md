# Pool setup and diagnosis

Do not load this reference for normal dispatch; use pool_help {code} for a short
recovery action. Categories and catalog are independent. There is no selection
mode, category access permission or agent/owner selection switch. Category CRUD
and model membership/default effort are edited in the owner UI. Agents follow
their caller's instructions when choosing an entrypoint/model/category.

The service starts automatically through CLI, stdio MCP or RPC. RPC accepts one
{ "tool": "pool_catalog", "arguments": { "query": "flash" } } on stdin. Prompts
can use pool_submit over RPC without entering command arguments. mcp-config prints
credential-free stdio settings. Runtime state is in the installed runtime locator,
not the repository; desktop and CLI share it. Do not copy provider credentials.

Native tools follow kind:text/read/write; mode:execute implements/checks files and
returns a structured report. Native/model support is reported as kinds. A text
reply alone does not certify tools. Native permission denial, unsupported model,
missing login and exhausted credit are different errors. pool_help {code} and
pool_get_quotas {routeId} distinguish the next action. Unknown quota means unknown,
not zero or unlimited. Never automatically replay a started write.

Qoder uses native login and exact --list-models names. Desktop login alone does
not authenticate CLI. Free billing requires native zero-billable evidence. MiniMax
account credits use mcode/free_credits; mmx uses Token Plan and cannot consume them.
Insufficient balance (1008) is a balance/quota error. No implicit API fallback.
ZCode account-only projection excludes personal API providers. Its installed CLI
must actually provision the requested Individual/Starter account; missing account
models return MODEL_UNAVAILABLE. Never substitute another provider/plan silently.
Freebuff is an interactive MCP client; installed 0.2.35 has no supported headless
worker model/output contract. Do not extract private desktop endpoints/credentials.

Owner-hidden models and disabled routes stay excluded from both discovery and
execution. Removing category membership keeps catalog availability. Effort per
category is a default. Native supported effort, capability, billing and quota
validation remain; no agent-selection authority setting is required.

The caller controls concurrency through its submissions; Pool imposes no worker count cap. Overlapping readers
share; writers exclude other access. needs_review quarantine survives restarts.
Resolve only an inspected stopped task through cli-agent-pool resolve with a note.
No automatic worktree creation, merge or cleanup. CLI --timeout bounds the worker;
--wait bounds the caller, preserving task identity and resume information.

Execute final report has six required fields: status(completed|partial|blocked),
summary, files:[{path,change}], checks:[{command,outcome:passed|failed|not_run}],
research:[{source,finding}], blockers:[string]. Use empty arrays when absent,
maximum 6000 characters, target 200 words. Invalid/partial reports retain evidence.
Retrieve full task only when compact diagnostics are insufficient.


## Director execution (pb-director/1)

Query pool_capabilities before sending optional fields. Owner sessions may run
pool_preflight {routeId,modelId?,effort?,workspace,readPaths?,capabilities?} or:

~~~sh
cli-agent-pool preflight --route ROUTE --model MODEL --workspace "/project" --read-path "/skills/project-brain"
~~~

Poll returned id via pool_get_task and inspect preflight.ready, or query
pool_preflight_status (read-only, lock-free). The key includes effort, CLI version
and native settings. Missing/expired keys return PREFLIGHT_REQUIRED; failures
include per-capability fixes. Probes take the ordinary write lock; run them before
the director, or from owner recovery after the old director stops. Model reports
alone never prove permission readiness. readOutside requires a native Read tool
event and exact random line; shell-only readers cannot certify that capability.

Submit profile:director, kind:write, mode:execute, pinned route/model and the same
readPaths/capabilities/effort. Native Claude/Codex/Antigravity are supported;
WSL, custom/API and paid_api routes are refused. Codex stays workspace-write;
shell network needs explicit route sandboxNetwork:true. Pool does not broaden
native shell grants. Antigravity duplicate deepest project mappings fail
PROJECT_AMBIGUOUS with the files to repair. Workers in sibling worktrees need a
native project mapping the worktrees' parent folder; submission creates no grants.

Optional director fields: onExit:{argv:[absolute executable,args...],
timeoutSeconds:300}, ackDeadlineSeconds:60..3600, startDeadlineSeconds:60..86400,
idleTimeoutSeconds:300..86400, stopOnQuotaBarrierPercent:1..50,
supersedesTaskId:uuid, secretEnv:{PB_RELAY_TOKEN:value}. Values are memory
only, never stored or included in idempotency content. Queued secret-bearing tasks
fail SECRET_LOST after restart. Do not place secrets in prompts or hook argv.
CLI_AGENT_POOL_TASK_ID and the per-run TASK_TOKEN reach native tasks; CLI/stdin
MCP bridges forward the token and worker marker automatically. Keep them when
calling Pool from a wrapper. A running director can ack itself and submit a
preflight-ready successor; ordinary workers cannot create directors/hooks.
Owner preflight/resolve are refused inside task bridges. Arbitrary shell access
under the same OS user remains owner-equivalent; this is no multi-user sandbox.

pool_ack_task {taskId} is idempotent while running. Linked workers keep idle
liveness and expose parentTaskId; they cannot overlap the parent workspace or use
paid_api. Start and ack expiry return START_TIMEOUT/ACK_TIMEOUT; idle returns
IDLE_TIMEOUT only after process-tree teardown. stopOnQuotaBarrierPercent cancels a
running director with QUOTA_BARRIER when live remaining quota reaches the barrier;
supersedesTaskId cancels a predecessor still running 90s after successor admission
with SUPERSEDED_BY_HANDOFF. A failed write releases its lock
only if conservative before/after fingerprints match. Unknown or changed state
and WSL keep needs_review. Owner pool_resolve_task {taskId,reviewed:true,note}
acknowledges inspection without reverting files and preserves originalError. Never resolve unrelated tasks.

onExit runs from the service environment after the final lock decision, with
CAP_TASK_ID/STATE/ERROR, closed stdin and no worker/token/secret env. It may call
Pool. Bare code 75 retries three times (30s apart); code 75 with CAP_WAKE_AT <ISO>
or CAP_RETRY_AFTER <seconds> schedules extended wakeups (5s..3600s, up to 200 cycles)
for quota-reset or network-outage recovery. Last 2KB output is retained;
CAP_NOTIFY lines appear in task notifications. Pending hooks recover at restart;
a launch interrupted at an uncertain point is not replayed blindly. Relay recover
should be idempotent and also callable manually. Watchdog works only while the
service runs; Pool stores no relay record and never selects a successor.
