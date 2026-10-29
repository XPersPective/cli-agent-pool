# CLI Agent Pool

Read README.md and docs/architecture.md before changing behavior.
For continuing maintenance, read docs/maintenance-plan.md; keep its checklist and evidence current.
The product is standalone. No DeepSeek Harness/Hermes or other host integration is required.
Reuse installed official CLI authentication; never copy credential contents.
Runtime state belongs outside this repository in the local application data directory.
API billing is allowed only on routes the user explicitly configures as paid_api; never enable API billing as an implicit fallback or disable native CLI permission checks.
Use shell-free process invocation and preserve conservative retry behavior.
Non-trivial logic must have a runnable node:test check. Run npm test, npm run check,
npm run secrets, and npm audit before pushing. Never commit runtime configuration,
account identifiers, prompts, task results, browser artifacts or tokens.
Do not use Project Brain as a dependency or project workflow.
