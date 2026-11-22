# Security

Do not include provider API keys, OAuth credentials, runtime configuration,
prompt/result databases or diagnostic dumps in issues or PRs.
Report a vulnerability privately to the repository owner through GitHub.

## Local Pool Service (`127.0.0.1:43127`)

The core Pool service binds only to `127.0.0.1` loopback and rejects foreign
browser `Origin` headers and foreign `Host` authorities.
- **Unauthenticated read-only discovery on loopback**: `GET /api`, `/api/health`,
  `/api/catalog`, `/api/pools`, `/api/quotas` (cached only), `/api/model`,
  `/api/select` (cached only), `/api/help`, `/api/capabilities` and
  `/api/connections` are readable from `127.0.0.1` without a Bearer token so
  local agents can query metadata with zero MCP overhead. Account identifiers
  such as `email` are stripped from unauthenticated responses.
- **Authenticated operations**: live CLI quota queries (`?live=1`), task
  submission/inspection/cancellation (`/api/tasks`, `/mcp`, `/api/tools/*`)
  require a 256-bit local `access-token` Bearer capability.
- **Owner management**: policy changes, secret storage and service lifecycle
  require a separate `management-token` that is never given to agent MCP clients.
  The standalone dashboard exchanges a single-use launch link for a persistent,
  rolling HMAC-signed, port-bound `HttpOnly; SameSite=Strict` cookie.

## Optional Remote PWA (`remote/`, `:43128`)

`cli-agent-pool remote` runs an optional companion web bridge that proxies to
the local Pool over `127.0.0.1`. It defaults to `127.0.0.1` only; `--host tailscale`
additionally binds the detected Tailscale CGNAT interface (`100.64.0.0/10`) and
pins allowed `Host` authorities to loopback and the configured/detected HTTPS
Tailscale hostname.
- Pairing uses 5-minute single-use codes (`/?pair=<code>` via `POST /r/redeem`)
  and issues HMAC-signed `HttpOnly; SameSite=Lax` device cookies with server-side
  expiration and per-device revocation.
- All mutating `/r/*` endpoints enforce `Content-Type: application/json` and
  same-origin `Origin` / `Sec-Fetch-Site` checks against CSRF.
- `/r/manage` and `/r/folders/pick` accept only direct loopback connections
  (proxied Tailscale Serve requests with forwarding headers are rejected).
- File reading (`GET /r/file`) is restricted to configured/shared/chat workspace
  roots, rejects binary files, and explicitly denies sensitive paths
  (`CLI_AGENT_POOL_HOME`, `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gh`).

## Storage and Credentials

On Windows, initialization restricts inherited application-directory permissions to
the current user's SID. On POSIX, new directories/files use `0700`/`0600`.
Changing `CLI_AGENT_POOL_HOME` must never point into a shared, synced or repository folder.

The Pool reuses official CLI authentication across its built-in adapters
(`codex`, `claude`, `opencode`, `zcode`, `qwen`, `qoder`, `mcode`, `mmx`, `kimi`,
`mimo`, `agy`, `omniroute`, `lmstudio`, `ollama`, `aider`, `kilocode`, `hermes`)
plus user-defined `custom` templates.
When a user configures a custom API provider (Anthropic-compatible or OpenAI-compatible),
the API key is written exclusively to `<CLI_AGENT_POOL_HOME>/secrets/<secretRef>.key`
via an owner-only write-only management operation (`/ui` / `/manage`). Secret values
are never stored in `config.json`, never logged, and never returned to browser clients
or MCP tools; only a boolean `hasSecret` status is exposed.
Child CLI processes receive a sanitized environment with ambient API keys stripped, plus
only the explicit route's secret when a custom `api` route is executed. When mirroring
native Antigravity `mcp_config.json` into isolated account profiles, `env` and `headers`
fields are stripped so MCP secrets are not copied.

## Native CLI Permission Scopes

- **Codex**: uses its native `read-only` / `workspace-write` sandbox (`--ignore-user-config`).
- **Claude**: `write` uses `--permission-mode acceptEdits`; `mode: 'execute'` enables
  `Bash` alongside file tools within Claude's native permission rules, while non-execute
  `write`, `read` and `text` restrict tools accordingly.
- **OpenCode / MiMo**: `OPENCODE_CONFIG_CONTENT` denies all tools (`{'*':'deny'}`) for
  `text`, denies write/patch/bash/network tools for `read`, denies `bash` for non-execute
  `write`, and allows workspace tools for `write + mode: 'execute'`.
- **Qwen**: supports `text`/`read` (`--approval-mode plan`) and `write` (`--approval-mode auto-edit`).
- **Qoder / Antigravity**: preserve native CLI plan/accept-edits and owner project grants;
  permission bypass flags are never enabled.
- **MiniMax Code (`mcode`)**: `text` uses `lightweight`; `write` uses `standard` with
  `--permission full` because `mcode` requires that flag for headless workspace writes
  (`read` is excluded from standalone `mcode`).
- **Kimi / Aider**: `kimi` enables `--auto` only for `write + mode: 'execute'`; `aider`
  never passes `--yes-always` and uses `--chat-mode ask` for non-write tasks.

## Scanning and Billing Policy

The local scanner checks working-tree and staged git index content for common
credential patterns and rejects private filenames/binaries. Pre-commit, pre-push
and CI repeat it.
Never solve rate limits by silently switching to a metered `paid_api` route unless the
user explicitly selected that route or enabled `autoSelect: true` directly on that
`paid_api` route.
