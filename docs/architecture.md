# Architecture and acceptance boundary

One local Node process owns configuration, the SQLite task database, quota
snapshots, admission and its own web dashboard. MCP tools
are equally available to Codex, Claude or an agent that uses Project Brain.
There is no Store Automation integration, hidden orchestration model or paid API client.

## Decisions

1. Reuse official CLIs. Harness-specific execution and UI were considered; the user
   explicitly chose an independent application on 2026-10-18. No host plugin is required.
2. Use one Streamable HTTP MCP owner instead of starting one stdio queue per client.
3. SQLite and a separate exclusive owner connection prevent two instances from
   recovering the same database concurrently. A second owner fails before recovery.
4. Keep provider credentials in the provider CLI. Only our two local capability
   tokens are read by our own host applications. Agent and management scopes differ.
5. Prefer missed work requiring review over automatic repeated file changes.
6. Use a native HTML/CSS/JavaScript dashboard in the same process. No UI framework,
   external CDN, browser credential store or separate frontend server is required.
7. The stdio MCP connector is a proxy, not another scheduler: every coding tool shares
   one task owner. It reads only the Pool's own local capability, never vendor secrets.

## State and recovery

`queued -> starting -> running -> succeeded | failed | timed_out`
Cancellation passes through `cancelling`; a confirmed process-tree teardown ends
the read/text task in `cancelled`. Failed, cancelled or timed-out write tasks are
quarantined as `needs_review`, retaining the workspace reservation.
On restart, previously `starting/running/cancelling` tasks become `needs_review`.
Queued tasks are revalidated against the current route and canonical workspace.
There is no exactly-once promise for arbitrary external effects. Idempotency only
deduplicates admission; it cannot roll back a CLI's changes.

## Trust and persistence

Single-user service: every valid agent capability can see that user's tasks. This
is not a tenant isolation system. Model/tool results are untrusted text. The panel
renders them only through DOM `textContent` and never executes returned content.
Workspaces, prompts and results are private runtime data in the application data
directory, not repository files. stdout/stderr are bounded and not logged verbatim.
Common token patterns are redacted from results; this is not a general data-loss
prevention engine. Users must not ask an agent to return credentials.

Configuration changes use schema validation, revision conflicts, fsync and atomic
rename. Editing on disk while the service is running requires restart. Panel saves
update live policy after persistence. Existing active tasks retain their route.
Quota snapshots include observation time, expire for routing after 60 seconds and
are cached for at least 15 seconds. Shared account windows are not per-model budgets.

## Verified versus pending

Verified locally on Windows: real Codex model discovery; a real ChatGPT-backed
read-only nonce task through MCP; core test coverage for idempotency, workspace
escape, queue reservations, quota gating, config conflicts, recovery, authentication,
Windows descendant termination and hard parent-exit teardown. Test command output is
the current source of test counts; tests do not make provider calls.

Verified on 2026-10-18 against installed CLIs (no quota consumed):
- Standalone dashboard journey in headless Edge at 360, 768 and 1440 px and 2x scale:
  no horizontal overflow, no visible control under 44 px, first Tab reaches the skip
  link, opening settings moves focus to its heading, one-time login then cookie session.
- Claude Code 2.1: all adapter flags exist. `auth status --json` reports
  `oauth_token`/`firstParty` even when `settings.json` redirects to another vendor's
  endpoint; the adapter therefore requires `claude.ai` and rejects non-Anthropic
  base URLs (`THIRD_PARTY_ENDPOINT`).
- Qwen Code 0.21: `stream-json` ends with the Claude-style `result` envelope; the
  parser follows that contract. Writes stay disabled.
- mmx 1.0: `quota show` states when no token plan is active. Tasks require an
  explicit active plan (`SUBSCRIPTION_REQUIRED`) and a fresh `none` snapshot removes
  the route from selection, so mmx cannot silently fall through to pay-as-you-go.
- Gemini CLI support was removed (product discontinued in favour of Antigravity).
  Existing configs with a `gemini` route fail validation instead of running.

Pending, blocked outside this repository: live Claude/Qwen/mmx tasks need a CLI that
is actually on a confirmed subscription (on the verification machine Claude points to
a third-party endpoint and mmx has no active plan); remote CI readback needs the GitHub
Actions account issue resolved; Android access needs an owner-selected private network.
POSIX parent-crash teardown is covered by the CI test once CI runs.
Live tasks consume quota and must stay bounded.

Not implemented: generic worktree lifecycle, cross-provider session resume,
automatic benchmark grouping, multi-account rotation and post-dispatch fallback.
These are explicit scope limits, not advertised existing features.
