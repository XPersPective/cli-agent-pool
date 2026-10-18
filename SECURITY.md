# Security

This repository is private. Do not include provider API keys, OAuth credentials,
runtime configuration, prompt/result databases or diagnostic dumps in issues or PRs.
Report a vulnerability privately to the repository owner through GitHub.

The service defaults to loopback and requires a 256-bit local capability. It rejects
browser Origin headers and foreign Host authorities. Policy management requires a
different capability, which must not be given to agent MCP clients. DSH authenticates
its browser separately; the plugin keeps Pool capabilities in its host process.

On Windows, initialization restricts inherited application-directory permissions to
the current user's SID. On POSIX, new directories/files use 0700/0600. Administrators
and other processes running as the same OS user remain inside the trust boundary.
Changing `CLI_AGENT_POOL_HOME` must never point into a shared/synced/repository folder.

The Pool does not extract vendor credentials or proxy OAuth tokens to vendor APIs.
It starts official CLI executables. Review the native CLI's settings, plugins and
hooks before enabling it; native approval policies are not an OS isolation claim.
Codex uses its native read-only/workspace-write sandbox. Claude write mode permits
native file edits; Bash is not exposed by this adapter. Gemini/Qwen write mode is
rejected. No adapter enables dangerous permission bypass flags.

The local scanner checks working-tree and staged text for common credential patterns
and rejects private filenames/binaries. It never prints matching values. Pre-commit,
pre-push and CI repeat it. Pattern scanning and a private repository do not replace
security review; do not commit secrets even temporarily. If a secret is committed,
rotate it and remediate history before any push.

Run `npm ci --ignore-scripts`, tests and audit before using a changed dependency set.
Provider and DSH releases change quickly. Keep adapters disabled until the relevant
auth, billing and permission flow has been tested against the installed version.
Never solve rate limits by changing account identity or silently switching to a paid API.
