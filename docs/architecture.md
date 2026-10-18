# Architecture and acceptance boundary

One local Node process owns configuration, the SQLite task database, write-only
custom API secret files, quota/plan snapshots, admission and its own web dashboard.
MCP tools are equally available to Codex, Claude, Antigravity or any MCP client.
Remote access (mobile/VPN/tunnels) is explicitly out of scope: users access their
coding environments remotely through their host tools' native remote features, while
CLI Agent Pool strictly manages the local model and CLI pool on `127.0.0.1`.

## Decisions

1. Reuse official CLIs (`codex`, `claude`, `opencode`, `qwen`, `mmx`). No host plugin is required.
2. Support five explicit billing/plan declarations per route:
   - `subscription`: Official vendor CLI subscription (`codex`, `claude.ai`, etc.).
   - `token_plan`: Fixed-quota coding/token plans (e.g. Qwen/DashScope Coding Plan on Claude Code or OpenCode, MiniMax Token Plan).
   - `free_credits`: Daily or promotional credit balances (e.g. MiniMax `mmx` daily credits when no monthly token plan is active).
   - `free`: Zero-cost models discovered from OpenCode (`cost.input === 0 && cost.output === 0`) or free tiers.
   - `paid_api`: Metered pay-per-token API routes. Never used as an implicit fallback; excluded from automatic selection unless `routeId` is explicitly requested or the owner opts in with `autoSelect: true`, and always ranked behind non-metered routes.
3. Support custom API providers through two protocol slots without building a custom HTTP agent loop:
   - **Anthropic-compatible (`api.protocol = 'anthropic'`)**: executed via Claude Code (`claude`) with per-process `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` injected from the write-only local secret store (`<CLI_AGENT_POOL_HOME>/secrets/<secretRef>.key`).
   - **OpenAI-compatible (`api.protocol = 'openai'`)**: executed via OpenCode (`opencode`) with per-process `OPENCODE_CONFIG_CONTENT` configuring `@ai-sdk/openai-compatible` and enforcing read/write tool permissions.
4. Keep provider credentials out of `config.json`, MCP responses and browser responses. Custom API keys are write-only via `/api/secrets`.
5. Use one Streamable HTTP MCP owner and a lightweight `stdio` proxy so every coding tool shares one SQLite task owner.
6. Prefer missed work requiring review (`needs_review`) over automatic repeated file changes.

## State and recovery

`queued -> starting -> running -> succeeded | failed | timed_out`
Cancellation passes through `cancelling`; a confirmed process-tree teardown ends
the read/text task in `cancelled`. Failed, cancelled or timed-out write tasks are
quarantined as `needs_review`, retaining the workspace reservation.
On restart, previously `starting/running/cancelling` tasks become `needs_review`.
Queued tasks are revalidated against the current route and canonical workspace in strict FIFO (`rowid`) order.

## Trust and persistence

Single-user local service on `127.0.0.1`. Model/tool results are untrusted text.
The panel renders them only through DOM `textContent` and never executes returned content.
Workspaces, prompts, results and write-only API secrets live in the local application data
directory (`%LOCALAPPDATA%\cli-agent-pool` or `~/.local/share/cli-agent-pool`), never in the repository.

Configuration changes use schema validation, revision conflicts, fsync and atomic
rename. Quota snapshots include observation time, expire for routing after 60 seconds
and are cached for at least 15 seconds. Missing token-plan subscriptions (`subscription: 'none'`)
block `subscription` and `token_plan` routes but allow `free_credits` routes (such as MiniMax daily credits).

## Verified capabilities

- Local Windows verification with real installed CLIs (`codex` 0.153, `claude` 2.1, `opencode` 1.18, `qwen` 0.21, `mmx` 1.0):
  - Real Codex model discovery and live MCP task execution.
  - OpenCode JSONL event parsing, automatic free model catalog discovery (`opencode models --verbose --pure`), and OpenAI-compatible custom API execution via `OPENCODE_CONFIG_CONTENT`.
  - Claude Code subscription verification (`claude.ai`), token-plan / third-party Coding Plan support (`billing: 'token_plan'`), and Anthropic-compatible custom API execution via isolated environment variables.
  - MiniMax `mmx` daily credits (`billing: 'free_credits'`) vs active token plan (`billing: 'token_plan' | 'subscription'`) differentiation and quota inspection.
  - Qwen Code `stream-json` result envelope parsing with writes disabled.
  - Gemini CLI removed.
  - Standalone dashboard verified in headless Edge at 360 px and 1440 px with CLI route setup, Custom API (Anthropic/OpenAI slot) setup, plan/credit badges, and CLI login guidance.
