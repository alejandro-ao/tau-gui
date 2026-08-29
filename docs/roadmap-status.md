# Roadmap status

Issue #1 records the historical desktop roadmap. Issue #17 is the accepted self-contained embedded-Pi architecture.

## Embedded Pi foundation complete

- Production constructs the pinned Pi SDK directly in Electron main.
- Renderer → validated preload IPC → main services → embedded Pi remains the only production route.
- Runtime selectors, Tau/Pi launch specs, executable probing, binary/provider/argument launch settings, RPC client/framing, subprocess backpressure, compatibility capability tables, and JSONL fake runtimes are removed.
- Deterministic CI injects `FakePiRuntime` at the application-domain boundary; no provider, paid access, or process protocol is required.
- GUI settings migration drops obsolete runtime/binary fields and preserves Pi favourite models plus app-owned session metadata.
- Tau attribution remains intentionally visual: transcript-first layout, role bars, compact CLI composer, and `tau-*` theme names. It no longer describes a runtime dependency.

## Capability audit

A capability is true only when the embedded adapter, IPC/preload, renderer flow, and deterministic tests all exist. Independent feature branches provide the remaining issue #17 catch-up slices and must be reconciled in order; this branch does not copy them.

| Area                                                                  | Current branch                             |
| --------------------------------------------------------------------- | ------------------------------------------ |
| Embedded Pi text, model, thinking, compaction, shell, tree, resources | complete                                   |
| Injected fake Pi unit/Electron coverage                               | complete                                   |
| JSONL/RPC/runtime-selector compatibility                              | removed                                    |
| Shutdown/session flush                                                | bounded graceful shutdown                  |
| Packaging smoke                                                       | macOS/Windows/Linux CI matrix configured   |
| Signing/notarization                                                  | external credentials required; not claimed |

## Active parallel work

Open PR #21 renames the product and changes app-owned session storage/migration. This branch deliberately does not copy its naming, path migration, package identity, or storage policy. Integration must reconcile PR #21 after choosing the product name and must preserve its user-data migration independently of this compatibility deletion.

## Release hardening

`npm run verify`, `npm run test:e2e`, and `npm run package:smoke` are the repository gates. Clean-machine, accessibility, performance, signing, notarization, and platform/hardware procedures are documented in [release-testing.md](release-testing.md). Hardware/provider checks are reported only when actually run.
