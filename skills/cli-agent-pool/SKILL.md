---
name: cli-agent-pool
description: Query CLI Agent Pool categories, catalog, or live/cached quotas and run bounded model tasks. Starts the local service automatically.
---

# CLI Agent Pool

Use the fast local HTTP API (`http://127.0.0.1:43127/api`), connected MCP tools, or the `cli-agent-pool` CLI.
Never scan source files, inspect provider stores, dump the full inventory, or read `operations.md` for normal usage.

## Fast HTTP API (0 MCP overhead, read-only open on 127.0.0.1)

If connection is refused, run `cli-agent-pool ensure` once to auto-start the daemon.

- `GET /api` — short endpoint map (`GET /api/health` for liveness/counts)
- `GET /api/catalog` — sources/providers; add `?billing=free`, `?adapter=qoder`, `?q=flash`, `?kind=write`, or `?view=models` for model pages (limit 12, max 40; pass `nextOffset` as `offset`)
- `GET /api/pools` — category IDs/names/counts; `GET /api/pools/<id>` returns that category's model page
- `GET /api/quotas` — cached quota & remaining% for all enabled connections in one call (no CLI spawn); `GET /api/quotas/<routeId>` for cached windows (add `?live=1` with `Authorization: Bearer <access-token>` to query the vendor CLI live)
- `GET /api/model?route=<routeId>&model=<modelId>` — one model with cached quota, efforts, and tool kinds
- `GET /api/select?kind=write&mode=execute[&group=<id>]` — recommend an allowed model without starting a task
- `GET /api/help` or `GET /api/help?code=AUTH_REQUIRED` — short map or error recovery

## MCP & CLI Equivalents

- MCP: `pool_help`, `pool_list_pools`, `pool_catalog`, `pool_quota_overview`, `pool_get_quotas`, `pool_select`, `pool_submit`, `pool_get_task`.
- Submit tasks with `pool_submit` (or `cli-agent-pool run` / `POST /api/tasks` with `Authorization: Bearer <access-token>`): `prompt`, absolute `workspace`, `kind` (`write`+`mode:execute` to edit/check, `read` to review, `text` for reasoning), and a durable `idempotencyKey`. `group` selects a category; `routeId`+`modelId` pins a catalog model.
- Each CLI account is its own route (`routeId`, `account`, and `email` when authenticated via MCP/CLI/Bearer). Disabled, hidden, and settings-filtered models stay excluded.

~~~sh
cli-agent-pool ensure
cli-agent-pool quotas
cli-agent-pool quotas --route codex-local --live
cli-agent-pool pools --group research
cli-agent-pool catalog --billing free --kind write --limit 8
cli-agent-pool model --route qoder-local --model Qwen3.8-Flash
cli-agent-pool run --mode execute --workspace "/absolute/project" --route qoder-local --model Qwen3.8-Flash --prompt "Implement the requested change and run relevant checks"
cli-agent-pool stop
~~~

Poll `pool_get_task {taskId}` (or `GET /api/tasks/<id>`); results default to `compact:true`.
Lost response: reuse identical content/key; `queued`/`running` means resume, never duplicate a started write.
Problems: `GET /api/help?code=<CODE>` or `pool_help {code}`; load `compact:false` only when compact diagnostics are insufficient.

Native CLI tools/permissions, billing, and quota reserves apply. No paid API fallback, copied credentials, or native permission bypass. Pool does not impose workspace locks or `needs_review` quarantine; callers coordinate concurrent writers (e.g. distinct worktrees) and avoid recursive Pool delegation.
Execute reports use JSON: `status(completed|partial|blocked)`, `summary`, `files`, `checks`, `research`, `blockers`; prompt target 200 words / 6000 chars (parser ceiling 32,768 chars).

For unattended directors, read `pool_capabilities` (or `GET /api/capabilities`) and follow the caller's relay contract (`profile:director` requires verified preflight). See [operations](references/operations.md) ONLY for setup, director internals, or provider limitations.
