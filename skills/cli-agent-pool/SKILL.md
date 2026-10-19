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
- `pool_assign_groups` — Only when `groupingMode` is `agent`, upsert memberships with `{ revision, assignments: [{ routeId, modelId, group, effort? }] }` or remove one with `remove: true`. Other memberships survive. This never grants permission to alter routes, billing or workspace roots.
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

The owner's dashboard uses a compact model **Ekle** action followed by an explicit
destination-pool/effort picker; the currently viewed top pool is not changed by an
addition. Quotas open by default, with individual/global controls; the catalog
scrolls without pagination. Settings is a separate page; unsaved changes support
Save/Discard. Workspace tasks require an explicitly selected project.
Owner-hidden models/families are excluded from discovery imports and agent selection,
including explicitly pinned requests. Do not work around filters or change them via
other tools. Missing login must be completed by the owner through the dashboard's
native CLI login action; never request or copy their credentials.
The workspace plus/slash picker attaches an authorized project/installed SKILL.md
as instructions, including its absolute source path. This does not install skills,
relax CLI permissions, or authorize a worker to recursively delegate. CLI turn success
alone does not prove files were created; inspect artifacts and run task verification.
On Windows, Codex explicitly selects its Windows sandbox backend and working root,
while preserving workspace-write/read-only scope and ignoring unrelated user config.
Family/source views, sorting and light/dark/system themes are owner browser preferences,
not agent policy.

## Project Brain, editors and Freebuff

Keep Project Brain separate. Brain 3.3.0+ owns task plans, local research, quality
checks and evidence; it connects to this Pool for discovery and execution through
`cli-agent-pool rpc`. Its normal L/M/H tasks select low/medium/high pools. Do not
ask for a second model approval when the owner already configured Pool rules.
Never weaken fixed effort or quota reserves, change billing/trust, or replay an
interrupted write. Pool owns worker process containment and state recovery.

`cli-agent-pool rpc` accepts `{ "tool": "pool_select", "arguments": {...} }` on
stdin and returns one JSON result/error on stdout. Only agent MCP tools are allowed.
`minRemainingPercent` optionally raises (never lowers) owner reserve for select/submit.
Prompts need not appear in argv. The daemon starts automatically.

`cli-agent-pool mcp-config` prints a credential-free stdio configuration for editors.
Freebuff Desktop/CLI reads `~/.agents/mcp.json` and can call Pool as an MCP client.
Preserve existing MCP entries and native trust prompts. Installed Freebuff 0.2.29
has no supported headless model/effort execution contract, so do not represent its
models as Pool workers or extract desktop credentials/private endpoints.
