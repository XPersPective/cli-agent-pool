# Security

This repository is private. Do not include provider API keys, OAuth credentials,
runtime configuration, prompt/result databases or diagnostic dumps in issues or PRs.
Report a vulnerability privately to the repository owner through GitHub.

The service binds only to `127.0.0.1` loopback and requires a 256-bit local capability.
Remote network exposure is out of scope. It rejects foreign browser Origin headers and
foreign Host authorities. Policy management requires a separate management capability
that is never given to agent MCP clients. The standalone dashboard exchanges a single-use
launch link for a signed, port-bound HttpOnly / SameSite=Strict cookie.

On Windows, initialization restricts inherited application-directory permissions to
the current user's SID. On POSIX, new directories/files use 0700/0600.
Changing `CLI_AGENT_POOL_HOME` must never point into a shared, synced or repository folder.

The Pool reuses official CLI authentication (`codex`, `claude`, `opencode`, `qwen`, `mmx`).
When a user configures a custom API provider (Anthropic-compatible or OpenAI-compatible),
the API key is written exclusively to `<CLI_AGENT_POOL_HOME>/secrets/<secretRef>.key`
via a write-only endpoint. Secret values are never stored in `config.json`, never logged,
and never returned to browser clients or MCP tools; only a boolean `hasSecret` status is exposed.
Child CLI processes receive a sanitized environment with ambient API keys stripped, plus
only the explicit route's secret when a custom `api` route is executed.

Codex uses its native read-only/workspace-write sandbox. Claude write mode permits
native file edits (`acceptEdits`) without Bash. OpenCode read/text tasks deny `bash`,
`edit`, `write`, `question` and `external_directory` permissions via `OPENCODE_CONFIG_CONTENT`.
Qwen write mode is rejected. No adapter enables dangerous permission bypass flags.

The local scanner checks working-tree and staged text for common credential patterns
and rejects private filenames/binaries. Pre-commit, pre-push and CI repeat it.
Never solve rate limits by silently switching to a metered `paid_api` route unless the
user explicitly selected that route or enabled `autoSelect` on it.
