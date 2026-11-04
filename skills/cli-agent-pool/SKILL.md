---
name: cli-agent-pool
description: Query CLI Agent Pool categories or catalog and run bounded model tasks. Starts the local service automatically.
---

# CLI Agent Pool

Use connected MCP tools or the installed cli-agent-pool CLI. No source scan,
provider discovery, full inventory or separate policy query is needed.
Caller instructions decide whether to use a category or the catalog.

- Map: pool_help {}.
- Categories: pool_list_pools {} returns IDs/names/counts;
  pool_list_pools {group:"id"} returns that category's model page.
- Catalog: pool_catalog {} returns source counts;
  pool_catalog {billing:"free"}, {adapter:"qoder"}, {query:"flash"} or
  {view:"models"} returns model pages. Catalog access needs no category.
- Pages default to 12; use nextOffset as offset only when more are needed.
  Entries include exact routeId/modelId, tool kinds, effort and cached quota.
  Each CLI account is its own route; `account` names a non-default one. The
  caller decides when to move to another account; pin it with routeId.

If IDs/category are known, submit directly: pool_submit with prompt, absolute
workspace, kind and a durable idempotencyKey. group selects a category;
routeId/modelId pins a catalog model. Omit group for catalog selection.
For implementation use kind:write, mode:execute; review uses kind:read;
reasoning uses kind:text. Category effort is a default; the caller may choose
another supported effort. Disabled/hidden models remain excluded.

CLI examples (substitute the actual workspace and bounded task):

~~~sh
cli-agent-pool pools
cli-agent-pool pools --group research
cli-agent-pool catalog --billing free --limit 8
cli-agent-pool run --mode execute --workspace "/absolute/project" --route qoder-local --model Qwen3.8-Flash --prompt "Implement the requested change and run relevant checks"
~~~

Poll pool_get_task {taskId}; results are compact by default. Keep the returned ID.
Lost response: reuse identical request content/key. Queued/running means resume;
never duplicate a started write. Inspect actual files and reported checks.
For problems, pool_help {code:"AUTH_REQUIRED"} gives a short recovery action;
pool_get_quotas {routeId} reads live provider status. Load detailed diagnostics
only for that error, or request pool_get_task {taskId,compact:false} if necessary.

Native CLI tools/permissions, billing, quota reserves and workspace locks apply.
No paid API fallback, copied credentials or native permission bypass. Parallel
writers use distinct caller-prepared worktrees. Inspect needs_review before owner
resolution; do not clear unrelated locks or recursively delegate into Pool.
Execute reports use JSON: status(completed|partial|blocked), summary, files,
checks, research, blockers; target 200 words, maximum 6000 characters.

For setup, provider limitations and recovery only, read
[operations](references/operations.md). Project Brain owns its own instructions;
Pool serves categories/catalog and has no Project Brain dependency.
