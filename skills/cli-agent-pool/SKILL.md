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
- `pool_list_models` — List all available models, manual groups, supported task kinds (`text`, `read`, `write`), and reasoning efforts.
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
cli-agent-pool select --kind read --group free
cli-agent-pool select --kind write --route zcode-local
```

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
