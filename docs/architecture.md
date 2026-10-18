# Architecture and acceptance boundary

One local Node process owns configuration, the SQLite task database, quota
snapshots and admission. DSH is a client, not an execution dependency. MCP tools
are equally available to Codex, Claude or an agent that uses Project Brain.
There is no Store Automation integration, hidden orchestration model or paid API client.

## Decisions

1. Reuse official CLIs. DSH-only execution was considered but its bundled native
   providers do not use the host CLI and have different model/resume boundaries.
2. Use one Streamable HTTP MCP owner instead of starting one stdio queue per client.
3. SQLite and a separate exclusive owner connection prevent two instances from
   recovering the same database concurrently. A second owner fails before recovery.
4. Keep provider credentials in the provider CLI. Only our two local capability
   tokens are read by our own host applications. Agent and management scopes differ.
5. Prefer missed work requiring review over automatic repeated file changes.
6. Keep DSH's browser panel thin. Exact host routes inherit DSH browser authentication;
   only the host communicates with the Pool capability endpoints.

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
renders them with React text escaping and never executes returned content.
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
escape, queue reservations, quota gating, config conflicts, recovery, authentication
and Windows descendant termination. Test command output is the current source of
test counts; tests do not make provider calls.

Production acceptance still requires the real DSH browser journey at narrow/wide
viewports, keyboard/enlarged-text checks, real provider-specific read/write tests,
parent-crash teardown on supported operating systems, remote CI readback and Android
private-network verification. Live tasks consume quota and must stay bounded.

Not implemented: generic worktree lifecycle, cross-provider session resume,
automatic benchmark grouping, multi-account rotation and post-dispatch fallback.
These are explicit scope limits, not advertised existing features.
