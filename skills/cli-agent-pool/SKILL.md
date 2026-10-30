---
name: cli-agent-pool
description: Dispatch bounded coding, review, analysis, or text tasks to the local CLI Agent Pool (Codex, Claude Code, OpenCode, ZCode/Z.AI GLM, Qwen, MiniMax Code, MiniMax CLI, Kimi, MiMoCode, Antigravity, OmniRoute, LM Studio, Ollama, and custom API/CLI routes). Automatically starts the local pool service on demand if it is not already running. Use whenever the user asks to run a task on the pool, delegate work to another installed CLI/model, check model quotas/plans, or open the CLI Agent Pool dashboard.
---

# CLI Agent Pool Skill

`cli-agent-pool` manages all locally installed AI CLIs, subscriptions, coding/token plans (`token_plan`), daily free credits (`free_credits`), free models (`free`), and custom Anthropic/OpenAI API slots on `127.0.0.1`.

**Automatic Wake-Up:** You do **not** need to ask the user to start the pool server first. Both the `cli-agent-pool` CLI commands (`status`, `select`, `run`, `open`, `ensure`) and the `cli-agent-pool stdio` MCP bridge automatically start the background pool daemon if it is not already running.

## 1. Communicating via MCP Tools (Preferred when connected)

If the `cli-agent-pool` MCP server is connected in your environment, use its native tools directly:
- `pool_list_connections` — List configured CLI and API routes with billing mode (`subscription`, `token_plan`, `free_credits`, `free`, `paid_api`).
- `pool_list_pools` — Read high/medium/low memberships, exact model IDs, fixed effort and cached quota windows in one call.
- `pool_list_models` — List all available models, manual groups, supported task kinds (`text`, `read`, `write`), and reasoning efforts.
- `pool_get_policy` — Read owner grouping mode and current configuration revision.
- `pool_assign_groups` — Only when `groupingMode` is `agent`, upsert memberships with `{ revision, assignments: [{ routeId, modelId, group, effort? }] }` or remove one with `remove: true`. Other memberships survive. This never grants permission to alter routes or billing.
- `pool_get_quotas` — Inspect live remaining quota percentages and subscription/credit status for a `routeId`.
- `pool_select` — Select the highest-priority available route/model for a task `kind` (`read`, `write`, `text`) without starting a task.
- `pool_submit` — Submit a bounded task (`prompt`, `workspace`, `kind`, `idempotencyKey`, and optional `routeId`, `modelId`, `group`, `effort`).
- `pool_get_task` — Poll or retrieve task state (`queued`, `running`, `succeeded`, `failed`, `needs_review`) and output (`result`).

## 2. Communicating via CLI Commands (Works from any Agent or Terminal)

When MCP tools are not loaded in the current session, invoke `cli-agent-pool` directly using shell/command execution. Every command outputs machine-readable JSON and automatically wakes up the background service if stopped:

### Check Pool Status, Connections, and Models
```bash
cli-agent-pool status
```

### Recommend the Best Available Model
```bash
cli-agent-pool select --kind read
cli-agent-pool select --kind read --group medium
cli-agent-pool select --kind write --route zcode-local
```

### Strength groups and quota-aware selection

Read `pool_list_pools` and `pool_get_policy` first. In `selectionMode: manual`, a strength group is mandatory even for a pinned route/model. Use the owner's existing memberships. Standard strength groups
are `high`, `medium`, `low`; reasoning effort is a separate field. For a medium task,
select/submit with `group: "medium"` (CLI: `--group medium`) and leave route/model
unpinned so the pool can choose another eligible model in that group when a route's
quota is exhausted. Selection and admission refresh quota snapshots using a short
cache. Unknown quotas remain unknown. A membership’s `fixedEffort` is mandatory; omit request effort or use that exact value. Never replay a started task automatically. Exact versioned model IDs are distinct from family aliases. `pool_get_task` returns selected modelId, group, effort and reportedModel (null unless the CLI reported its runtime identity).

Preserve the owner's classifications. If asked to classify and grouping is enabled,
read `pool_get_policy`, then send only the requested model group assignments with
its current revision. On conflict re-read policy and models before reconsidering.
Do not treat model-name suggestions as measured capability scores.

### Run a Task on the Pool (Auto-Starts Service & Waits for Result)
```bash
# Let the pool pick the best available subscription / token_plan / free model:
cli-agent-pool run --kind read --workspace "/path/to/project" --prompt "Review src/ for security issues and summarize findings."

# Target a specific CLI route or model (e.g., ZCode GLM-5.3, Qwen, OpenCode, MiniMax, Codex, Claude):
cli-agent-pool run --kind read --route zcode-local --model "builtin:zai-coding-plan/GLM-5.3" --workspace "/path/to/project" --prompt "Analyze architecture."
```

### Scan & Import Newly Installed CLIs
```bash
cli-agent-pool scan-import
```

### Open the Standalone Desktop Dashboard Window
```bash
cli-agent-pool open
```

## Safety & Routing Rules

1. **Billing Priority:** Non-metered routes (`subscription`, `token_plan`, `free_credits`, `free`) are always prioritized ahead of `paid_api`. `paid_api` routes are never selected automatically unless explicitly requested via `--route <id>` / `routeId` or enabled with `autoSelect: true`.
2. **Task Kinds:**
   - `text`: Pure text/reasoning without workspace file tools.
   - `read`: Read-only analysis/review with file modification tools disabled.
   - `write`: Controlled workspace edits; if a write task fails or is interrupted, the workspace enters `needs_review` quarantine to prevent blind retries.
3. **Never Expose Secrets:** Never read or print files inside `%LOCALAPPDATA%\cli-agent-pool\secrets` or `access-token` / `management-token`.

Detailed MCP request examples, transport and error handling are documented in the packaged docs/agent-api.md.

The owner's dashboard uses compact model cards, explicit destination-pool/effort
selection and a readable Calls monitor. Per-card tests use fixed short text probes,
owner policy and isolated runtime workspaces; there is no chat composer. Model and
filter edits persist immediately without committing unrelated settings drafts.
Owner-hidden models/families are excluded from discovery imports and agent selection,
including explicitly pinned requests. Never work around filters. Missing login uses
native CLI login; credential presence alone does not prove a valid session. Provider
restrictions are not authentication failures and never authorize a paid fallback.
Antigravity variants share one canonical model with supported efforts and native ID
mappings. Use the catalog IDs/efforts, not invented suffixes. Provider quota scopes
apply only to the stated model families; unavailable Argon quota remains unknown.
The owner monitor retains bounded completed payloads; admission keys and quarantine
remain durable. A CLI turn alone never proves files were created; inspect artifacts.
On Windows, Codex explicitly selects its Windows sandbox backend and working root,
while preserving workspace-write/read-only scope and ignoring unrelated user config.
Family/source views, sorting and light/dark/system themes are owner browser preferences,
not agent policy.

## Project Brain, editors and Freebuff

Keep Project Brain separate. Brain 3.3.0+ owns task plans, local research, quality
checks and evidence; it connects to this Pool for discovery and execution through
`cli-agent-pool rpc`. Its normal L/M/H tasks select low/medium/high pools. Do not
ask for a second model approval when the owner already configured Pool rules.
Never weaken fixed effort or quota reserves, change billing/native CLI trust, or replay an
interrupted write. Pool owns worker process containment and state recovery.

Any existing absolute local project directory can be submitted directly through MCP
or CLI. No Pool workspace allowlist, dashboard registration or per-project approval
is required. Native CLI permissions and read/write task scopes still apply.

`cli-agent-pool rpc` accepts `{ "tool": "pool_select", "arguments": {...} }` on
stdin and returns one JSON result/error on stdout. Only agent MCP tools are allowed.
`minRemainingPercent` optionally raises (never lowers) owner reserve for select/submit.
Prompts need not appear in argv. The daemon starts automatically.

`cli-agent-pool mcp-config` prints a credential-free stdio configuration for editors.
Freebuff Desktop/CLI reads `~/.agents/mcp.json` and can call Pool as an MCP client.
Preserve existing MCP entries and native trust prompts. Installed Freebuff 0.2.29
has no supported headless model/effort execution contract, so do not represent its
models as Pool workers or extract desktop credentials/private endpoints.

A route with autoSelect:false is excluded from automatic selection regardless of
billing mode. Do not pin it to work around a failed live test. A successful text
probe proves a reply only, not write tools or task completion. Check structured
errors, queueReason and blockedBy; native permission denials require review.

Use RPC/status to inspect runtime state; do not assume a hard-coded LocalAppData
config path. Desktop and CLI share the installed runtime locator across MSIX hosts.
The pool supports up to 32 parallel tasks across distinct non-overlapping workspace
directories (`concurrency` and per-route `maxConcurrent` up to 32); overlapping
reads share a workspace; overlapping writers remain serialized to protect files.

## Execution subagents and parallel coordination

For an implementation request, default to `kind: "write", mode: "execute"`.
Pass the calling project's absolute workspace, a bounded implementation task,
owner strength group, timeout and a durable idempotency key. Use `read` for reviews
and `text` for reasoning only. Pool injects subagent protocol v1: perform the edits
and checks using native tools; preserve unrelated work; return at most 200 words
covering changed paths/purpose, actual checks/outcomes and blockers. Native trust,
sandbox and permission checks remain enforced. Never promise unrestricted access.
`pool_list_models.executionModes` advertises execute support per model. Effective write capability follows the native/configured policy. Do not pin disabled routes to force execution.

CLI: `cli-agent-pool run --kind write --mode execute --workspace <project> --group high --timeout 600 --wait 3600 --prompt "Implement the bounded task and test it"`.
MCP/RPC: submit with `mode: "execute"`, then poll `pool_get_task` with
`{taskId, compact: true}`. Compact replies omit repeated prompt/events and bound
the report to 6000 characters, explicitly flagging truncation. Review actual files
and checks; a successful turn/model report alone does not prove implementation.

Up to 32 readers can share a workspace. Writes exclude readers/other writers;
a waiting writer blocks later readers to avoid starvation. Review quarantine
remains exclusive. For parallel edits in one project, prepare distinct Git
worktrees and assign non-overlapping responsibilities. Review each diff and use
one serialized integration write. Never run concurrent writers against the same
working tree or assume Pool merges them automatically.

`--timeout` limits the native worker; `--wait` independently bounds queue + caller
waiting. Expiry returns the existing task and `resume` metadata without cancelling
or replaying it. Queued is not failed. A review blocker returns immediately with
`blockedBy`; inspect it before clearing quarantine. Provider quotas cannot be
increased by a worker; caller reserves can only be raised. Keep owner billing and
permissions unchanged. The protocol does not authorize recursive Pool delegation,
commits, pushes, publishing or deployment on its own.

Public modes are `response` (text/read) and `execute` (write); CLI infers the kind
when omitted. Keep using execute by default for implementation requests. Its final
response MUST be one JSON object: `status` (completed|partial|blocked), `summary`,
`files: [{path,change}]`, `checks: [{command,outcome}]` (passed|failed|not_run),
`research: [{source,finding}]`, `blockers: [string]`. All fields required, empty arrays
when absent, all changed paths and research sources included; maximum 6000 characters,
target 200 words. Pool validates the report format, exposes `report`, and compact
retrieval avoids sending a duplicate `result`. Invalid reports retain raw output as
INVALID_REPORT/needs_review; partial/blocked are WORK_INCOMPLETE/needs_review. Inspect
artifacts before resolving; never rerun just to repair a report. Codex execute enables
native live search; Claude execute enables all built-in tools using --tools default.
Native permissions, network policy and provider capabilities still apply.

Native coding CLIs expose effective text/read/write independently of stale imported
model kinds when toolPolicy is native (default). Use request kind/mode to choose
scope; native permission checks remain authoritative. Pool 1.8 supports Qwen native
auto-edit and Antigravity workspace tools. toolPolicy configured is an explicit owner
limit using stored model kinds. Catalog exposes configuredKinds, toolSupport and
permissionAuthority separately; do not equate capability with permission or a live
model guarantee. Chat-only CLI commands (MMX, Ollama/LM Studio, OmniRoute chat) have
no local editing tools. Custom CLI templates must enforce their declared scopes.
