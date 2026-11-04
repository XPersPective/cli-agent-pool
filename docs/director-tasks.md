# Director mechanisms (Pool 2.2.0)

Status: implemented; independent review accepted, 2026-11-05.
Authoritative cross-repo contract: Project Brain
`skills/project-brain/references/director-contract.md` (`pb-director/1`).
Pool remains standalone; no Project Brain runtime dependency.

## Architecture

Project Brain owns relay records, candidate selection, handoff and recovery.
Pool owns director execution, verified readiness, workspace locks, deadlines,
secret delivery and terminal exit hooks. Pool has no relay table or successor
selector. A service watchdog evaluates deadlines and durable pending exit hooks.

Director is `profile: director`, `kind: write`, `mode: execute`, pinned to a native
Claude/Codex/Antigravity non-paid route. The directorProfile feature advertises this explicit profile; lifecycle fields
require it. Owner MCP/CLI can submit; ordinary worker bridges cannot create director
lifecycle hooks, preflight or resolve. A valid running director token can submit
a preflight-ready successor and acknowledge its own task. This is a
single-user boundary: arbitrary native shell access remains owner-equivalent.

Readiness uses fixed probes and normal exclusive workspace locks. HMAC files
verify shell steps, native events distinguish split commands, a prompt-only MCP
nonce plus the task token verifies the bridge, a single-use loopback POST checks
shell access, random-line reads check external paths, and git object writes and
non-interactive ls-remote check git. Results key on version, route, model, effort,
canonical workspace, requested capabilities/read roots, CLI version and native
settings hashes. Seven-day expiry; infrastructure failures back off 30 minutes.
Owner-configured directorReadRoots bound additional read-only grants. Codex stays
workspace-write; sandboxNetwork is an explicit per-route director-only opt-in.
Antigravity reuses native projects and rejects ambiguous deepest-root mappings.

Every write snapshots its workspace before execution. Failed/cancelled/invalid
reports release only if a bounded conservative fingerprint is unchanged. Git
fingerprints cover dirty contents, index flags, refs, native settings and git
metadata. Unknown fingerprints and WSL writes retain needs_review. On restart,
interrupted writes require two matching snapshots 60 seconds apart. Owner
resolve acknowledges inspection; it never reverts files.

Director task tokens link child tasks automatically through the stdio/CLI bridge.
Linked workers cannot overlap their parent workspace or use paid_api routes;
Antigravity workers need an existing project mapping their external worktrees.

secretEnv accepts only PB_ names. Values stay in memory, outside persistent
requests and idempotency fingerprints, and are redacted from results/events.
Only the fact that secrets are required is persisted. Restarted queued tasks
without their secrets fail SECRET_LOST. Tokens/secrets are never passed in argv.

Start deadlines include queued time. Ack deadlines start at native execution;
idle deadlines use uncapped native output activity and running linked workers.
Expiration cancels the supervised process tree before lock evaluation. Ack is
idempotent while running and refused after terminal state.

Exit hooks are owner-authorized absolute argv, shell-free, workspace cwd, closed
stdin and service environment without worker/token/secret variables. Final lock
state and active-handle retirement precede dispatch; hooks can call Pool without
deadlock. Durable hook attempts retry only exit 75, at most three retries, 30s
apart. At startup pending terminal hooks are recovered after reconciliation.
A crash during an already launched hook is at-most-once (never replayed blindly);
PB recovery is itself idempotent. Last 2KB output is recorded; CAP_NOTIFY lines
become visible task notifications. Hooks never select a successor themselves.

## Critique and acceptance

Self-critique: removed duplicate relay authority; owner MCP must remain usable
by PB; no broad native permission grants or implicit paid fallback; restart
secret loss must fail closed; early auth/argument failures must settle preflight;
hooks must execute after process teardown and lock reconciliation, outside task
execution. No claims of readiness from model reports alone.

Independent review identified effort/result-shape incompatibility, infrastructure
failures cached ready, missing token checks, and conservative-fingerprint gaps.
These were fixed with regression tests. A final review found queued-preflight
cleanup, atomic hook registration and director replay gaps; all three were
fixed and accepted after regression coverage. Final verification uses temporary
external data/workspace directories and ephemeral ports, followed by npm test,
check, secrets and audit. Local install preserves existing runtime data and
requires no running jobs before service replacement.


Acceptance evidence: npm test 157/157; check, secrets and npm audit passed.
Project Brain integration exercises real HTTP/MCP and Python RPC with a synthetic
native executor, isolated private data/port 0 and scratch git remote. Verified
preflight, permission failure, real onExit recovery, failover, takeover/self-ack,
secret delivery, git commit/local bare push and completion. This is transport and
lifecycle acceptance; it does not certify a live vendor route's native permissions.
