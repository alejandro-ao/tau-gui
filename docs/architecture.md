# Architecture

Tau GUI is a desktop frontend, not an embedded terminal. It recreates Tau's terminal-inspired interface with native web layout while driving coding-agent runtimes as subprocesses.

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
       ↓ runtime adapter + strict JSONL
Runtime processes
  one `tau --mode rpc` or `pi --mode rpc` process per live session
```

## Core rule

The renderer never consumes raw runtime events. Runtime adapters normalize wire messages into stable application-domain types. This allows the runtime to be selected through configuration without spreading Tau/Pi branches through UI components.

## Session boundary

Runtime session files remain runtime-owned. The GUI uses RPC for messages, entries, trees, statistics, switching, compaction, naming, and export. GUI-owned recent-session metadata may reference runtime IDs or paths but must not reinterpret persisted transcripts. Working directories are also GUI-owned settings: the renderer requests Electron's native folder chooser through the validated `fs.pickDirectory` IPC action, then persists only the returned path through `settings.rememberWorkingDirectory`. It asks the main-process runtime pool to open the fresh session through `runtime.openSession`; that pool retains a busy current process in the background and replaces an idle, stopped, or failed one. The left rail groups metadata by the stored `cwd`; it never reads directories or launches processes itself.

`RuntimePool` keeps a separate `RuntimeManager` and subprocess for each live session. Concurrent bootstrap requests share one startup handshake, so development StrictMode cannot replace a newly launched process. Runtime lifecycle transitions are serialized, failed activations always stop their partially started subprocess, and session ownership is assigned from the requested reference rather than inferred from a process's transient startup state. This prevents duplicate processes from writing the same session and orphaning the process that is still executing its tools. Even idle sessions retain their own process instead of being switched in place. Selecting another recent session activates its existing process or launches one without stopping the previously viewed process. Only the active manager's transcript/status events reach the renderer; global settings updates still propagate. Every streamed agent event also carries its immutable runtime/session identity, and the renderer applies it only when that identity matches the latest active snapshot. In-flight transcript hydration is generation-scoped and discarded when navigation starts. Session selection is an atomic renderer view transition: the previous transcript and run state are cleared immediately, a centered thread spinner replaces runtime notices and empty-state copy, and transcript-scoped stream/status events are gated until the target's authoritative snapshot and messages have hydrated. This closes the interval where the newly highlighted session could still display the previous session's run indicator, existing tool blocks, or newly queued tool events while main-process activation is pending. These boundaries reject queued events and stale RPC responses after a switch, preventing background streams from being mixed into the visible transcript. All processes are stopped during app shutdown.

Editable prompts entered during a running turn are owned by a per-session main-process scheduler, not by the renderer or native runtime queue. Enter creates a priority `steering` item and Alt+Enter creates a `follow-up` item. At `agent_settled`, or at a normalized post-acceptance `runtime_error` for which no settle follows, the scheduler atomically claims steering FIFO before follow-up FIFO and sends the item as a fresh runtime prompt; each resulting terminal boundary drains one more item. Empty-composer Up atomically pops the newest follow-up, otherwise newest steering item, through typed IPC. Stable item IDs make duplicate text safe. Dispatch failures reinstate the claimed item at its queue front, and queued state survives process crashes for the same runtime/session identity. Native `queue_update` events remain normalized for adapter compatibility but are not authoritative for GUI submissions.

Session-scoped commands are addressed, not implied. Every renderer request may carry the `{ runtime, sessionId }` transcript it was issued for, and the pool routes prompts, steering, aborts, reads, model/thinking changes, naming, forking, compaction, export, and direct shell commands to the process that owns that session. Session-scoped IPC is not serialized against lifecycle transitions, so resolving through "whatever is selected right now" lets a switch already in flight redirect a prompt or a transcript read into the wrong session. Authoritative reads are bound to the same identity and rejected by the reducer when they describe another transcript, and submissions are refused while a session is still opening because their transcript is not yet known. An empty session never reuses a runtime that is mid-run: `new_session` swaps the session underneath the live agent, so the remainder of that turn would be written into the new transcript and both would be corrupted; busy runtimes stay in the background and the new session gets its own process. A failed activation is reconciled instead of silently leaving the cleared view attached to a still-streaming background runtime.

## Initial runtime limitations

The common RPC surface supports text prompting, streaming, tools, steering, follow-ups, cancellation, model/thinking controls, direct bash, compaction, session inspection, tree/fork, naming, and HTML export. Optional behavior such as image prompts, cancellable direct bash, queue/retry controls, cloning, extension dialogs, login/logout, resource reload, and system-prompt/tool inspection must be capability-gated until both runtime adapters support it.
