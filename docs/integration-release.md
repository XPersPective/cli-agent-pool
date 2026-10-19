# Pool 1.2.0 / Project Brain 3.3.0 delivery

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
- [x] Compact catalog: no pagination, local scrolling to the final model, readable quota details open by default.
- [x] Pool 1.2.0 installed; both managed skills updated across 40 targets each, all source hashes matched.
- [x] Both repositories committed/pushed; remote main/master and Brain working branch read back at the release commits.
- [x] Post-push: 39 Pool tests, complete Brain suite, installed synthetic-worker integration, real 13-route/65-model discovery, compact catalog wheel/end-of-catalog, installed browser and responsive checks all passed.

Freebuff is connected as a supported MCP client. Its installed 0.2.29 CLI does not
expose headless prompt/model/effort execution and is not advertised as a Pool model
provider. Unsupported quota/version metadata stays unknown. Real speech hardware
recognition has not been proven; browser speech/keyboard/error flows are covered.

Pre-push verification: 39 Pool node:test checks, complete Brain offline suite, real installed-daemon synthetic worker integration (including nested-delegation refusal), Python 3.8 grammar parsing of 19 files, browser pool/workspace/voice-event/keyboard/dark/responsive flows and zero installed-console errors. Native Windows folder selection/cancellation were verified in the preceding UI pass.

Both skills were updated via Skills Manager with IDs, Default preset and existing 40 deployment targets preserved. All 25 Brain files and the Pool skill matched the central library and every deployed target by SHA-256. The installed Pool reports 1.2.0; Brain reports 3.3.0. Freebuff uses its supported global MCP configuration; native trust/reload remains under Freebuff control.

1.1.1 follow-up: the model card has a small Ekle action; its dialog chooses destination pool and effort without changing the top pool view. Explicit light/dark/system theme is persisted locally. The addition flow, independent efforts, theme persistence and OS override were browser-verified.

Windows test cleanup now awaits the standard fs/promises.rm retry policy across temporary test directories; process-tree assertions remain unchanged and the full 39-test suite passes.

1.2.0 follow-up: separate Settings page with initially collapsed connection/forms,
compact neutral pool toolbar, default-open readable quotas with global/per-card controls,
no catalog pagination, preserved scroll position, explicit project selection and clean
save/discard state. Duplicate membership additions preserve effort by default; busy
rerenders keep action buttons disabled until the pending operation completes.
Brain 3.3.0 remains a separate unchanged skill; its installed integration is checked
against the updated Pool. No provider prompts or paid model usage are needed for QA.
