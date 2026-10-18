# CLI Agent Pool

Read README.md and docs/architecture.md before changing behavior.
The product is standalone. No DeepSeek Harness/Hermes or other host integration is required.
Reuse installed official CLI authentication; never copy credential contents.
Runtime state belongs outside this repository in the local application data directory.
Never enable API billing or disable native CLI permission checks as a fallback.
Use shell-free process invocation and preserve conservative retry behavior.
Non-trivial logic must have a runnable node:test check. Run npm test, npm run check,
npm run secrets, and npm audit before pushing. Never commit runtime configuration,
account identifiers, prompts, task results, browser artifacts or tokens.
Do not use Store Automation or Project Brain as dependencies or project workflows.
