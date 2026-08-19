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
  runtime pool/managers, settings, filesystem, notifications, diagnostics
       ↓ strict JSONL
Runtime processes
  one `tau --mode rpc` or `pi --mode rpc` process per live session
```

## Core rule

The renderer never consumes raw runtime events. Runtime adapters normalize wire messages into stable application-domain types. This allows the runtime to be selected through configuration without spreading Tau/Pi branches through UI components.

## Session boundary

Runtime session files remain runtime-owned. The GUI uses RPC for messages, entries, trees, statistics, switching, compaction, naming, and export. GUI-owned recent-session metadata may reference runtime IDs or paths but must not reinterpret persisted transcripts.

`RuntimePool` keeps a separate `RuntimeManager` and subprocess for each live session. Concurrent bootstrap requests share one startup handshake, so development StrictMode cannot replace a newly launched process. Session ownership is assigned from the requested reference rather than inferred from a process's transient startup state, and even idle sessions retain their own process instead of being switched in place. Selecting another recent session activates its existing process or launches one without stopping the previously viewed process. Only the active manager's transcript/status events reach the renderer; global settings updates still propagate. Every streamed agent event also carries its immutable runtime/session identity, and the renderer applies it only when that identity matches the latest active snapshot. In-flight transcript hydration is generation-scoped and discarded when navigation starts. These boundaries reject queued events and stale RPC responses after a switch, preventing background streams from being mixed into the visible transcript. All processes are stopped during app shutdown.

## Initial runtime limitations

The common RPC surface supports text prompting, streaming, tools, steering, follow-ups, cancellation, model/thinking controls, direct bash, compaction, session inspection, tree/fork, naming, and HTML export. Optional behavior such as image prompts, cancellable direct bash, queue/retry controls, cloning, extension dialogs, login/logout, resource reload, and system-prompt/tool inspection must be capability-gated until both runtime adapters support it.
