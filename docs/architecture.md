# Architecture and acceptance boundary

One local Node process owns configuration, the SQLite task database, write-only
custom API secret files, quota/plan snapshots, admission and its own web dashboard.
MCP tools are equally available to Codex, Claude, Antigravity or any MCP client.
Remote access (mobile/VPN/tunnels) is explicitly out of scope: users access their
coding environments remotely through their host tools' native remote features, while
CLI Agent Pool strictly manages the local model and CLI pool on `127.0.0.1`.

## Decisions

1. Discover and reuse all installed AI CLIs on the host machine (`codex`, `claude`, `opencode`, `zcode`, `qwen`, `mcode`, `mmx`, `kimi`, `mimo`, `agy`, `omniroute`, `lmstudio`, `ollama`, `aider`, `kilocode`, `hermes`) plus arbitrary user-defined CLIs via `adapter: 'custom'` (`argsTemplate`). No host plugin is required.
2. Read local model catalogs directly from each tool's non-secret configuration (`~/.zcode/v2/config.json`, `~/.qwen/settings.json`, `~/.config/opencode/opencode.json`, `~/.codex/models_cache.json`, `~/.minimax/config.yaml`, `~/.kimi-code/config.toml`, `~/.ollama/models`, `lms ls --json`) without ever copying or exposing credentials, and allow one-click bulk import (`scan-import`).
3. Support five explicit billing/plan declarations per route:
   - `subscription`: Official vendor CLI subscription (`codex`, `claude.ai`, `agy`, etc.).
   - `token_plan`: Fixed-quota coding/token plans (e.g. Z.AI GLM Coding Plan on `zcode`, Qwen/DashScope Coding Plan on `qwen`/`claude`/`opencode`, MiniMax Token Plan on `mcode`/`mmx`, Kimi Coding Plan on `kimi`).
   - `free_credits`: Daily or promotional credit balances (e.g. MiniMax `mmx` daily credits when no monthly token plan is active).
   - `free`: Zero-cost models discovered from OpenCode (`cost.input === 0 && cost.output === 0`), `:free` models on ZCode/OpenRouter, or local models (`lmstudio`, `ollama`).
   - `paid_api`: Metered pay-per-token API routes. Never used as an implicit fallback; excluded from automatic selection unless `routeId` is explicitly requested or the owner opts in with `autoSelect: true`, and always ranked behind non-metered routes.
4. Support custom API providers through two protocol slots without building a custom HTTP agent loop:
   - **Anthropic-compatible (`api.protocol = 'anthropic'`)**: executed via Claude Code (`claude`) with per-process `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` injected from the write-only local secret store (`<CLI_AGENT_POOL_HOME>/secrets/<secretRef>.key`).
   - **OpenAI-compatible (`api.protocol = 'openai'`)**: executed via OpenCode (`opencode`) with per-process `OPENCODE_CONFIG_CONTENT` configuring `@ai-sdk/openai-compatible` and enforcing read/write tool permissions.
5. Keep provider credentials out of `config.json`, MCP responses and browser responses. Custom API keys are write-only via `/api/secrets`.
6. Use one Streamable HTTP MCP owner and a lightweight `stdio` proxy so every coding tool shares one SQLite task owner.
7. Prefer missed work requiring review (`needs_review`) over automatic repeated file changes.

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

- Local Windows system-wide discovery across 16 CLI adapters (13 installed CLIs and 64 models discovered automatically on the host, including `codex`, `claude`, `opencode`, `zcode`, `qwen`, `mcode`, `mmx`, `kimi`, `mimo`, `agy`, `omniroute`, `lmstudio`, `hermes`):
  - ZCode (`C:\Program Files\ZCode\resources\glm\zcode.cjs`) discovery, `GLM-5.3` / `GLM-5.2` / `GLM-5-Turbo` model extraction from `~/.zcode/v2/config.json`, `stream-json` result parsing, read-only tool disallowing, and live Z.AI quota windows via `cclimits`.
  - Real Codex model discovery and live MCP task execution.
  - OpenCode JSONL event parsing, automatic free model catalog discovery (`opencode models --verbose --pure`), and OpenAI-compatible custom API execution via `OPENCODE_CONFIG_CONTENT`.
  - Claude Code subscription verification (`claude.ai`), token-plan / third-party Coding Plan support (`billing: 'token_plan'`), and Anthropic-compatible custom API execution via isolated environment variables.
  - MiniMax Code (`mcode`) and MiniMax CLI (`mmx`) daily credits (`billing: 'free_credits'`) vs active token plan (`billing: 'token_plan' | 'subscription'`) differentiation and quota inspection.
  - Qwen Code `~/.qwen/settings.json` multi-provider model discovery and `stream-json` result envelope parsing with writes disabled.
  - Kimi Code (`kimi`), Xiaomi MiMoCode (`mimo`), Google Antigravity (`agy`), OmniRoute (`omniroute`), LM Studio (`lmstudio`), Ollama (`ollama`), and Custom CLI (`argsTemplate`) support.
  - Gemini CLI removed.
  - Standalone dashboard verified with one-click system scan/import (`scan-import`), CLI route setup, Custom API (Anthropic/OpenAI slot) setup, Custom CLI template setup, plan/credit badges, and CLI login guidance.
