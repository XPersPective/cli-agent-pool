# Architecture and acceptance boundary

Release 1.1.0 keeps Project Brain separate: its stdlib Python bridge invokes the
Pool's bounded, agent-only JSON RPC stdin command. Normal Brain scans/selections
and task dispatch use this backend; plans and evidence remain in Brain. Caller
quota reserves can only raise owner minimums. Freebuff connects as an ordinary
stdio MCP client through its supported `.agents/mcp.json` configuration. It is not
a provider adapter without a verified headless execution/model-selection contract.

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
  - ZCode (`C:\Program Files\ZCode\resources\glm\zcode.cjs`) headless `-p --json` execution with its bundled provider catalog supplied through `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE`, the single ZCode default model (ZCode `-p` has no model flag), read-only tool disallowing, and native Z.AI monitor quota.
  - Native quota layer (`src/quotas.js`): Claude OAuth usage, Z.AI monitor, Antigravity Cloud Code, Kimi Code, MiniMax Coding Plan and OpenRouter key/credits; no external quota tool. Credentials are read from each CLI's own store into memory for one request only.
  - Real Codex model discovery and live MCP task execution.
  - OpenCode JSONL event parsing, automatic free model catalog discovery (`opencode models --verbose --pure`), and OpenAI-compatible custom API execution via `OPENCODE_CONFIG_CONTENT`.
  - Claude Code subscription verification (`claude.ai`), token-plan / third-party Coding Plan support (`billing: 'token_plan'`), and Anthropic-compatible custom API execution via isolated environment variables.
  - MiniMax Code (`mcode`) and MiniMax CLI (`mmx`) daily credits (`billing: 'free_credits'`) vs active token plan (`billing: 'token_plan' | 'subscription'`) differentiation and quota inspection.
  - Qwen Code `~/.qwen/settings.json` multi-provider model discovery and `stream-json` result envelope parsing with writes disabled.
  - Kimi Code (`kimi`), Xiaomi MiMoCode (`mimo`), Google Antigravity (`agy`), OmniRoute (`omniroute`), LM Studio (`lmstudio`), Ollama (`ollama`), and Custom CLI (`argsTemplate`) support.
  - Gemini CLI removed.
  - Standalone dashboard verified with one-click system scan/import (`scan-import`), CLI route setup, Custom API (Anthropic/OpenAI slot) setup, Custom CLI template setup, plan/credit badges, and CLI login guidance.

## Pool grouping and workspace dashboard

The three strength pools are the primary navigation. CLI/API catalogs are a
secondary picker beneath the selected pool. A model can belong to several pools
through `memberships`, with a separate optional mandatory effort on each membership.
An empty membership list removes the model from all strength pools. Legacy group
and default effort fields are read only when memberships are absent.

`selectionMode: manual` requires a strength pool even for explicit route/model
requests. Only its members are eligible. Fixed membership effort cannot be overridden
by the requester. In `auto` mode ungrouped catalog selection is also permitted;
explicit groups remain hard filters. Auto is the compatibility default.
`groupingMode` separately controls whether agents may edit membership. Agents
cannot change selection mode, billing, native CLI permission policy.

Selection/admission refreshes quota snapshots before running the existing selector.
Shared account windows and model-specific windows remain distinguishable. Numeric
quota is never fabricated. Execution retains the existing no-retry/no-replay policy.
Started task metadata records the selected group/effort and any model ID reported
by CLI events. It never claims unreported runtime identity was verified.

Claude catalogs come from its control initialization response without submitting a
user message. Resolved model IDs replace ambiguous aliases while preserving owner
memberships. The same merge routine serves CLI refresh and browser import. Owner
drafts are merged against their original saved base after catalog scans, preserving
unsaved changes independently of newly persisted catalog metadata.

Only the authenticated owner UI may open the Windows folder picker. A content-hashed
GUI helper is compiled from packaged C# using the inbox .NET Framework compiler into
the private application data directory. It uses the Windows IFileDialog folder mode,
returns only a validated selected path, and does not write recent-file history.
Its compiler and GUI process use the existing supervisor/Job Object ownership and
bounded output/timeout. No generated executable or runtime copy is committed to the repo.
The C# source is shipped; generated executables and copies remain outside the repo.

The workspace composer places dictation and submit controls inside the input box.
Speech uses browser recognition only after user interaction. Project/task results
and attached skill instructions are rendered with textContent. Settings are a separate page with initially collapsed connection/form sections.
Catalogs render every model in the chosen route inside a native scrolling region,
without pagination. Quota details default open with readable remaining percentages,
model-specific/global toggles and remaining-value progress bars. Scroll position and
individual disclosure state survive quota refresh. No project is auto-selected from
configuration or the installation directory; native project selection still uses
server-side existing-directory validation. Save/discard controls reflect owner draft state.
The human dashboard formats quota responses; agent MCP/JSON responses are unchanged.

Owner `modelFilters` are persisted alongside configuration and shared by catalog
import/refresh, dashboard and Pool.models(). Thus hidden models cannot be selected
by automatic or explicitly pinned agent requests. A route-scoped model filter is
exact; a global identity filter groups equivalent version/effort spellings, and a
family filter covers versions of the selected named family. These are naming hints,
not strength measurements. Filtering preserves stored memberships for restoration.
Agents cannot edit filters through group assignments.

Antigravity's live `models` command supplies exact cross-vendor IDs; generated
legacy Gemini defaults are removed only if not owner-assigned. Effort-bearing IDs
expose their corresponding effort. Failed discovery preserves owner configuration.
The browser's login operation is owner-only. It starts a fixed Windows platform
script with data-only JSON executable/arguments, sanitized environment and visible
native CLI terminal. It never receives credentials or runs a model prompt. Other
platforms receive the official terminal command. Login checks can force quota
refresh; transient Codex control failures retain known windows without extending
their timestamp, and independently verified missing login is exposed explicitly.

Pool 1.4 uses the same modelCard DOM factory in both catalogs and owner memberships.
Browser preferences remember a validated project root; the server still validates
all task paths. Project task messages are rendered as plain text, with model metadata
in a disclosure; historical prompts are not implicitly replayed into new requests.

Owner-only skills/skill operations enumerate bounded immediate SKILL.md directories
in the selected local project and central Skills Manager library. Project roots
that resolve outside the selected project, symlink files, oversized files and forged
skill IDs are rejected or excluded. No skill executes during discovery. Explicit
attachment sends text plus its source path as task instructions, without installation.
Agent MCP schemas are unchanged. Brain 3.3.1 documents source-relative script resolution.

Codex keeps --ignore-user-config and native sandbox checks, explicitly selects its
working root and Windows elevated sandbox backend when running on Windows. Workspace
write scope is retained; no unrestricted sandbox or native trust bypass is enabled.

Model edits save a model-scoped copy of the last owner configuration through the
existing revision-checked save operation. Pending billing, trust and other settings
stay in the browser draft, rebased onto the saved configuration. Browser storage
retains pending config drafts across reloads; neither credentials nor task prompts
are included. A failed save leaves the draft pending and reports the error.


Pool 1.5 replaces the owner chat composer with a read-only calls monitor and fixed
text probes. Agent submit/skills/folder APIs remain available for compatibility.
Only owner probe_model can mark an internal runtime probe workspace; agent requests
cannot forge that flag. The normal policy, quota and CLI
permission checks still apply. Client labels are self-reported metadata, not identity.
Completed payloads expire after seven days or 500 completed entries; durable keys,
fingerprints and quarantine survive cleanup. Active jobs are prioritized in snapshots.
Antigravity effort variants are canonical catalog entries with exact native ID maps;
merges stage changes atomically and reject conflicting memberships. Provider-declared
quota scopes apply identically in the UI and selector, including explicit Argon groups.


Local project admission accepts any existing absolute directory through CLI and MCP
without registration or configuration writes. Canonical paths preserve workspace
overlap locks and quarantine across junction aliases. Legacy workspaceRoots is
accepted for compatibility only; deleted entries do not prevent startup. Internal
model probes retain explicit containment. Project skill discovery still rejects
paths escaping the selected project. Native CLI sandbox and task scopes remain.


Windows dashboard launches use a native GUI helper with a named mutex and a
dedicated browser profile in private runtime data. Repeated launches restore the
existing Pool window and retire duplicates belonging to that profile. The helper
captures Node service startup output and verifies a visible window before success.
Desktop and Start menu shortcuts target the helper directly, avoiding hidden
VBScript console handles. Personal browser profiles and workers are separate.


The installed runtime locator in the user profile binds CLI and desktop to one
physical runtime across MSIX file virtualization. Explicit CLI_AGENT_POOL_HOME
still overrides it. Antigravity native event/result envelopes are parsed directly;
structured permission failures override a conversational SUCCESS. No prose-only
completion heuristic or automatic write replay is used. Non-paid autoSelect:false
is honored as well as paid_api policy. Queued task details expose workspace review
locks through queueReason and blockedBy. A text probe does not certify write tools.
