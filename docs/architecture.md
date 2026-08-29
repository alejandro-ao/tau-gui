# Architecture

Tau GUI is a self-contained desktop coding-agent application, not an embedded terminal. It recreates Tau's terminal-inspired interface with native web layout while embedding Pi's SDK behind Electron's main-process boundary.

## Layers

```text
Renderer
  UI components, normalized reducer state, virtualized transcript
       ↓ typed IPC
Preload
  minimal context-isolated API
       ↓ Electron IPC
Main process
  per-session prompt scheduler, runtime pool/managers, settings, filesystem, notifications
       ↓ normalized embedded-Pi adapter
Pinned Pi SDK
  one AgentSession/AgentSessionRuntime owner per live desktop session
```

## Core rule

The renderer never consumes Pi SDK objects or raw Pi events. The embedded adapter normalizes them into stable application-domain types. This preserves a narrow, validated IPC contract and keeps credentials, environment data, tools, extensions, and filesystem access out of the sandboxed renderer.

## Session boundary

Runtime session files remain main/Pi-owned. The adapter metadata-preflights a finite set, delegates JSONL interpretation to public `SessionManager` listing APIs, and emits tagged records with unique opaque catalog IDs—never file paths or Pi objects. Renderer state uses a persisted/ephemeral flag; active backing paths and remembered legacy paths stay in main-owned runtime/settings records. React keys use main-issued catalog identity while activity uses runtime session identity; renderer fallback never synthesizes IDs. `sessionList: true` is metadata-only: the rail can display records and native records can be exported, but persisted resume is unavailable. Native opaque and main-settings legacy activation are rejected before runtime resolution or any Pi pathname open, for live switch, startup/new-manager, and restart routes. Import is disabled before source selection, and clone before artifact creation, for the same activation reason. Pi 0.84.2 exposes only path-following, potentially mutating `SessionManager.open`/switch behavior; a fresh catalog or artifact preflight cannot bind what Pi later reopens. Older-build retained artifacts are never automatically path-deleted; every marker suffix counts toward the capacity of 32. A main application service keyed by the Pi agent directory keeps path-free recovery health/reveal available without a selected owner and across stopped, failed, and restarting runtimes, collapsing all filesystem failures to generic unavailable results. Portable export accepts only fresh complete catalog-owned native records; active export additionally requires its current full physical generation to match the fresh catalog, so legacy external active records fail closed. The native-dialog export destination is the sole intentional session-related path returned to renderer status UI. Working directories remain GUI-owned settings, and the rail groups bounded metadata without filesystem access.

`RuntimePool` keeps a separate `RuntimeManager` for each live session created during the current app lifetime. Concurrent fresh bootstrap requests share one startup handshake, so development StrictMode cannot replace a newly launched process. Runtime lifecycle transitions are serialized. Fresh in-memory/new persisted sessions remain supported: opening a working directory creates a new Pi manager, and a busy manager stays in the background when another fresh or spawned session starts. The catalog exposes completeness explicitly, and any skipped directory, omitted/dropped record, conflict, or truncation blocks identity-sensitive export until a complete rescan succeeds. Persisted catalog rows cannot activate an old or newly substituted session. Only the active manager's transcript/status events reach the renderer; global settings updates still propagate. Every streamed agent event carries its immutable runtime/session identity, and the renderer applies it only when that identity matches the latest active snapshot. All processes are stopped during app shutdown.

Editable prompts entered during a running turn are owned by a per-session main-process scheduler, not by the renderer or native runtime queue. Enter creates a priority `steering` item and Alt+Enter creates a `follow-up` item. At `agent_settled`, or at a normalized post-acceptance `runtime_error` for which no settle follows, the scheduler atomically claims steering FIFO before follow-up FIFO and sends the item as a fresh runtime prompt; each resulting terminal boundary drains one more item. Empty-composer Up atomically pops the newest follow-up, otherwise newest steering item, through typed IPC. Stable item IDs make duplicate text safe. Dispatch failures reinstate the claimed item at its queue front, and queued state survives process crashes for the same runtime/session identity. Native `queue_update` events remain normalized for adapter compatibility but are not authoritative for GUI submissions.

Session-scoped commands are addressed, not implied. Every renderer request may carry the `{ runtime, sessionId }` transcript it was issued for, and the pool routes prompts, steering, aborts, reads, model/thinking changes, naming, tree navigation, labeling, compaction, export, and direct shell commands to the process that owns that session. Authoritative reads are bound to the same identity and rejected by the reducer when they describe another transcript. An empty session never reuses a runtime that is mid-run: `new_session` swaps the session underneath the live agent, so the remainder of that turn would be written into the new transcript and both would be corrupted; busy runtimes stay in the background and the new session gets its own process. Persisted-session activation does not enter this routing layer.

## Migration state

Production uses the embedded Pi adapter. Metadata-only session listing, fresh session creation, in-place tree navigation/labels, active HTML export, and native portable JSONL export have bounded desktop flows. Resume, clone, and import are disabled on one public SDK activation blocker. Every JSONL export requires a fresh complete native catalog; active export also matches the live full generation, and legacy paths outside catalog roots are rejected. Tree navigation offers no summary, default summary, or bounded custom-focus summary (plus an optional label) through public `navigateTree()`, with cancellation/failure retaining retry UI. Pi 0.84.2's inactive HTML helper is internal and not exported from the public package entry point, so the app does not deep-import or fake that operation. The required upstream surface is one root-public operation that consumes the exact manager, immutable bytes, or an already-open no-follow handle; enforces the expected logical ID and complete physical generation; and activates that exact input without a later pathname reopen. Import may use Pi-owned atomic exclusive adoption, but must activate the exact adopted bytes. This unified API is required for resume, import, and clone; a parser or preflight-only API is insufficient. Other SDK surfaces remain capability-gated until each has bounded domain types and tests.

The JSONL adapter remains only as an explicitly enabled deterministic E2E/contract-test harness (`TAU_GUI_TEST_RPC_RUNTIME=1`). It is not selected by application settings and is scheduled for removal once tests inject fake Pi sessions/services directly. Third-party Pi extensions are disabled in the embedded loader until extension trust and desktop UI contracts are implemented.
