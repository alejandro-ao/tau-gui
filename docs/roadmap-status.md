# Roadmap status

Issue #1 records the historical Tau/Pi RPC roadmap. Issue #17 is the accepted embedded-Pi architecture.

## Embedded Pi foundation complete

- Production constructs the pinned Pi SDK directly in Electron main.
- Renderer → validated preload IPC → main services → embedded Pi is the only production route.
- Pi owns session files and transcript persistence. The GUI keeps only bounded recent-session metadata and never implements an alternative session store or parses Pi JSONL.
- Runtime selectors, Tau/Pi launch specs, executable probing, binary/provider/argument launch settings, RPC framing/client code, compatibility capability tables, and JSONL fake subprocesses are removed.
- Deterministic CI injects `FakePiRuntime` at the application-domain boundary; no provider, paid access, process protocol, or runtime executable is required.
- GUI settings migration drops obsolete runtime/binary fields while preserving Pi favourite models, UI settings, working directories, resource directories, and app-owned recent-session metadata.
- Tau attribution remains intentionally visual: transcript-first layout, role bars, compact CLI composer, and `tau-*` theme names. It no longer describes a runtime dependency.

## Integrated desktop capabilities

The current desktop contract includes:

- Pi-native bounded session catalog, resume, tree navigation/labels, clone, import, active HTML export, and active/inactive portable JSONL export;
- independently owned live/background sessions, spawn-session recursion limits, queue routing, restart/recovery, and bounded graceful shutdown;
- bounded multi-image prompts;
- provider authentication, retry progress/cancellation, and public-setter-backed Pi preferences;
- system-prompt/tool introspection and in-place resource reload;
- extension metadata, fail-closed execution policy, isolated utility supervisor, and bounded extension UI broker;
- session usage analytics and collapsible compaction summaries;
- slash/prompt completion with explicit keyboard selection.

Capabilities are advertised only when the embedded adapter, validated IPC/preload contract, renderer flow, and deterministic tests all exist. Third-party extension execution remains blocked until Pi exposes a public serializable remote-host adapter. Cancellable direct-bash UI and inactive-session HTML export remain incomplete.

## Release hardening

`npm run verify`, `npm run test:e2e`, and `npm run package:smoke` are repository gates. Clean-machine, accessibility, performance, signing, notarization, and platform/hardware procedures are documented in [release-testing.md](release-testing.md). Hardware/provider checks are reported only when actually run.
