# Pool setup and diagnosis

Do not load this reference for normal dispatch; use pool_help {code} for a short
recovery action. Categories and catalog are independent. There is no selection
mode, category access permission or agent/owner selection switch. Category CRUD
and model membership/default effort are edited in the owner UI. Agents follow
their caller's instructions when choosing an entrypoint/model/category.

The service starts automatically through CLI, stdio MCP or RPC. RPC accepts one
{ "tool": "pool_catalog", "arguments": { "query": "flash" } } on stdin. Prompts
can use pool_submit over RPC without entering command arguments. mcp-config prints
credential-free stdio settings. Runtime state is in the installed runtime locator,
not the repository; desktop and CLI share it. Do not copy provider credentials.

Native tools follow kind:text/read/write; mode:execute implements/checks files and
returns a structured report. Native/model support is reported as kinds. A text
reply alone does not certify tools. Native permission denial, unsupported model,
missing login and exhausted credit are different errors. pool_help {code} and
pool_get_quotas {routeId} distinguish the next action. Unknown quota means unknown,
not zero or unlimited. Never automatically replay a started write.

Qoder uses native login and exact --list-models names. Desktop login alone does
not authenticate CLI. Free billing requires native zero-billable evidence. MiniMax
account credits use mcode/free_credits; mmx uses Token Plan and cannot consume them.
Insufficient balance (1008) is a balance/quota error. No implicit API fallback.
ZCode account-only projection excludes personal API providers. Its installed CLI
must actually provision the requested Individual/Starter account; missing account
models return MODEL_UNAVAILABLE. Never substitute another provider/plan silently.
Freebuff is an interactive MCP client; installed 0.2.35 has no supported headless
worker model/output contract. Do not extract private desktop endpoints/credentials.

Owner-hidden models and disabled routes stay excluded from both discovery and
execution. Removing category membership keeps catalog availability. Effort per
category is a default. Native supported effort, capability, billing and quota
validation remain; no agent-selection authority setting is required.

The caller controls concurrency through its submissions; Pool imposes no worker count cap. Overlapping readers
share; writers exclude other access. needs_review quarantine survives restarts.
Resolve only an inspected stopped task through cli-agent-pool resolve with a note.
No automatic worktree creation, merge or cleanup. CLI --timeout bounds the worker;
--wait bounds the caller, preserving task identity and resume information.

Execute final report has six required fields: status(completed|partial|blocked),
summary, files:[{path,change}], checks:[{command,outcome:passed|failed|not_run}],
research:[{source,finding}], blockers:[string]. Use empty arrays when absent,
maximum 6000 characters, target 200 words. Invalid/partial reports retain evidence.
Retrieve full task only when compact diagnostics are insufficient.
