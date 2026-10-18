# Pool 1.1.0 / Project Brain 3.3.0 delivery

The UI/workspace/model requirements remain tracked in [the UI checklist](ui-pool-checklist.md).
This delivery keeps two repositories and two independently distributed skills.

- [x] Separate Brain planning/evidence and Pool discovery/execution responsibilities.
- [x] Automatic service startup through editor-neutral JSON stdin / MCP.
- [x] Owner high/medium/low pools, mandatory effort and same-pool quota alternatives.
- [x] Brain task tiers and supported automatic effort; strict/manual boundaries.
- [x] Raising-only 10% worker / 25% lead/reviewer quota reserves.
- [x] Task-bound idempotent recovery, immutable review strength and nested-worker guard.
- [x] Visible application version matching the CLI/MCP package version.
- [x] Freebuff standard MCP client configuration and transport check (11 tools and policy readback).
- [x] Full source tests, syntax, secret scan and dependency audit.
- [x] Compact catalog rework: 24 models/page, four columns at 1440 px, local scrolling and collapsed quota details.
- [x] Pool 1.1.0 installed; both managed skills updated across 40 targets each, all source hashes matched.
- [ ] Commit/push both repositories and verify remote commit readback.
- [ ] Repeat installed integration and browser usability checks after push.

Freebuff is connected as a supported MCP client. Its installed 0.2.29 CLI does not
expose headless prompt/model/effort execution and is not advertised as a Pool model
provider. Unsupported quota/version metadata stays unknown. Real speech hardware
recognition has not been proven; browser speech/keyboard/error flows are covered.

Pre-push verification: 37 Pool node:test checks, complete Brain offline suite, real installed-daemon synthetic worker integration (including nested-delegation refusal), Python 3.8 grammar parsing of 19 files, browser pool/workspace/voice-event/keyboard/dark/responsive flows and zero installed-console errors. Native Windows folder selection/cancellation were verified in the preceding UI pass.
