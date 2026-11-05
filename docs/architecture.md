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
   - `free_credits`: Daily or promotional account credits, such as MiniMax Code `mcode` account credits. MiniMax `mmx` is a separate Token Plan CLI and does not expose those Code credits.
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
block `subscription` and `token_plan` routes but allow `free_credits` routes (such as MiniMax Code account credits). The `mmx` quota endpoint reports Token Plan usage, not MiniMax Code daily/account credits.

## Verified capabilities

- Local Windows system-wide discovery across 16 CLI adapters (13 installed CLIs and 64 models discovered automatically on the host, including `codex`, `claude`, `opencode`, `zcode`, `qwen`, `mcode`, `mmx`, `kimi`, `mimo`, `agy`, `omniroute`, `lmstudio`, `hermes`):
  - ZCode (`C:\Program Files\ZCode\resources\glm\zcode.cjs`) headless `-p --json` execution with its bundled provider catalog supplied through `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE`, the single ZCode default model (ZCode `-p` has no model flag), read-only tool disallowing, and native Z.AI monitor quota.
  - Native quota layer (`src/quotas.js`): Claude OAuth usage, Z.AI monitor, Antigravity Cloud Code, Kimi Code, MiniMax Coding Plan and OpenRouter key/credits; no external quota tool. Credentials are read from each CLI's own store into memory for one request only.
  - Real Codex model discovery and live MCP task execution.
  - OpenCode JSONL event parsing, automatic free model catalog discovery (`opencode models --verbose --pure`), and OpenAI-compatible custom API execution via `OPENCODE_CONFIG_CONTENT`.
  - Claude Code subscription verification (`claude.ai`), token-plan / third-party Coding Plan support (`billing: 'token_plan'`), and Anthropic-compatible custom API execution via isolated environment variables.
  - MiniMax Code (`mcode`) account credits (`billing: 'free_credits'`) vs Token Plan billing; MiniMax CLI (`mmx`) Token Plan auth/quota inspection. The latter does not expose the former's account-credit balance.
  - Qwen Code `~/.qwen/settings.json` multi-provider model discovery and `stream-json` result envelope parsing with request-scoped native plan/auto-edit tools.
  - Kimi Code (`kimi`), Xiaomi MiMoCode (`mimo`), Google Antigravity (`agy`), OmniRoute (`omniroute`), LM Studio (`lmstudio`), Ollama (`ollama`), and Custom CLI (`argsTemplate`) support.
  - Gemini CLI removed.
  - Standalone dashboard verified with one-click system scan/import (`scan-import`), CLI route setup, Custom API (Anthropic/OpenAI slot) setup, Custom CLI template setup, plan/credit badges, and CLI login guidance.

## Pool grouping and workspace dashboard

Categories are owner-editable data with stable IDs and display names, not access
policies. The UI can create, rename and remove arbitrary categories and manage
model memberships with a default effort per category. Removing membership keeps
catalog access. Removing a category removes only those membership references.
Legacy selectionMode/groupingMode inputs migrate out of saved/public config;
existing explicit memberships and free-category membership are preserved once.

The caller chooses category or catalog. A category request filters by its members;
a catalog request needs no membership/group. A supported requested effort overrides
the category default. Hidden models, disabled routes/models, native permissions,
capabilities, explicit paid billing, quota reserves and workspace locks still apply.
Legacy non-paid autoSelect flags do not act as a caller selection authority.

pool_help provides a short map and per-error recovery. pool_list_pools without a
group returns category summaries; a group yields a bounded model page. pool_catalog
without filters returns source summaries; filters or view:models yield a deduplicated
model page. Default page size is 12, maximum 40, with nextOffset. Cached model quota
summaries accompany entries; live quota is queried separately. Compatibility list
aliases are bounded. Task results default to compact. Caller instructions govern
selection; no policy-query/assignment-permission roundtrip is required. Owner UI
category edits retain revision conflict checks and preserve unrelated drafts.
Multiple MCP clients share one local service and existing workspace scheduling;
this is not a remote multi-tenant identity system.

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
Completed records and events expire after seven days or 500 completed entries;
admission keys expire with history. Cleanup runs on completion and hourly; owner UI can clear terminal records. Active tasks and quarantine survive cleanup. Active jobs are prioritized in snapshots.
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

Execution subagent protocol v1 is opt-in per write task (`mode: execute`), separate
from billing and strength grouping. It injects implementation/check/report
instructions through every native prompt transport (stdin, JSON stdin or argv).
Claude exposes Bash and ZCode stops imposing the Pool Bash deny list in this mode;
native permission policies still apply. Other verified tool-capable adapters keep
their write sandbox/mode. Catalog executionModes uses effective native kinds; configured policy retains explicit model limits.
Compact retrieval omits prompt/events and explicitly marks bounded report truncation.
Reports remain untrusted and require the caller to inspect artifacts.

Workspace reservations use shared read/text locks and exclusive write/review locks.
FIFO conflicting queued tasks prevent a later reader from starving a writer.
Parallel writes use caller-prepared distinct worktrees; integration is a separate
serialized task with no implicit merge or replay. Independent CLI wait budgets
return resumable queued/running state instead of inventing a failed task. Worker
promise failures after write execution begins retain needs_review quarantine.

1.8 separates adapter capabilities from historical model inventory: native coding
CLIs default to text/read/write, and toolPolicy configured preserves explicit owner
kinds restrictions. Qwen uses auto-edit/plan; Antigravity workspace tasks retain
native plan/accept-edits without disabling skills. Permission bypass flags are never
added. Antigravity text tasks select plan through session-only `agentMode` because
`--mode plan` is ignored while slash expansion is disabled; native request-review
permissions remain unchanged. Chat CLI adapters remain text-only; arbitrary templates own their tool scopes.

1.8.2 uses MiniMax Code standard mode for write tasks; lightweight mode has no
workspace tools. Native smart permissions are not read-only, so standalone mcode
read requests are excluded from effective kinds and rejected before execution.
Text remains lightweight. ZCode print mode rejects model IDs other than
zcode-default instead of silently ignoring model selection. Additional usage-credit
requirements and stdout-only vendor failures remain explicit errors. Cookie headers
are redacted before diagnostics are persisted.

Antigravity workers explicitly select the closest existing native project whose
workspace resource contains the task directory. Both native folder and gitFolder
file URIs are supported; real paths and directory boundaries prevent sibling
matches. Missing/malformed project records leave native selection unchanged; ambiguous
deepest project mappings now fail PROJECT_AMBIGUOUS before execution. This only reuses owner permissions: submitting a task never creates a
project, edits grants or bypasses native checks. Owner-authorized local project
grants are separate from Pool task admission and read/write scope.

1.9.0 adds cached, filtered and paginated `pool_catalog` metadata discovery. Known
pool/model requests submit directly; submit replies default to compact and CLI
polling always uses compact results. Full diagnostics remain opt-in. Skill entry
instructions use this path; provider/setup details load only from a reference.
Qoder uses the installed official CLI, exact native model names, native status
without account identifiers, zero model request retries, strict empty worker MCP
configuration and scoped native tool lists. Execute uses native accept_edits and
session allow grants for file tools/Bash; native deny rules still apply. Read
excludes edits/commands, text disables tools. Native permission denials override
successful result envelopes. Account credit quotas remain unknown unless reported.
ZCode token-plan runs use an immutable, secret-free account-only provider config.
Personal API providers and legacy import are excluded, so an unavailable native
Starter/Individual account cannot silently use another billing source. Account
selection is configured through native login/default-model selection; the native
CLI must still provision that account. Credentials remain in the official store.

2.1.0 removes global/per-route worker count and queued-job caps. The caller
controls parallelism through submissions; workspace reader/writer fairness and
review locks remain. Retired concurrency/maxConcurrent inputs migrate away.
Task timeout is caller-supplied (default 300s), bounded only by Node timer range,
not a one-hour product ceiling. Waiting expiry still returns a durable task ID.

Account profiles let one official CLI account live in each route. Codex and
Claude routes with `profile` run with their own `CODEX_HOME` / `CLAUDE_CONFIG_DIR`
under the private data directory; quota, login check, catalog and login window
use the same profile. Native Windows `agy` routes with `profile` run with their
own `USERPROFILE` / `HOME` under `<data dir>/profiles/agy/<profile>`; agy keeps its
login as the file `.gemini/antigravity-cli/antigravity-oauth-token` there, so any
number of Antigravity accounts run in parallel without WSL. Legacy
`runtime: 'wsl'` routes remain readable but are no longer created. Quota comes from
the CLI's own `agy -p /usage --output-format json` (Gemini and Claude/GPT weekly and
5-hour windows with reset times, plus the separate Gemini 4 Argon weekly limit) and
falls back to the Cloud Code quota service; the account email is read from the
profile token in memory. Owner actions (login, catalog refresh, service start,
explicit sync) mirror native project records, file grants and trusted folders into
the profile; task submission never creates grants and credentials are never
copied. Account choice and switching thresholds
belong to the caller; routes expose `account` and per-route quota.


2.2.0 adds optional pb-director/1 mechanisms, with no Project Brain dependency.
The caller alone owns relay records and successor selection. Pool owns a native
non-paid director profile, HMAC/tool-event verified cached preflight, task-token
worker linking, ack/start/idle deadlines, memory-only PB_ secret environment,
change-aware failed-write lock release and durable owner exit hooks. Hook claims
are persisted before shell-free dispatch after final lock state; exit 75 alone
retries. Interrupted writes require two equal fingerprints 60 seconds apart.
Unknown/changed/WSL fingerprints preserve quarantine. See director-tasks.md for
trust boundaries and at-most-once crash limits.
