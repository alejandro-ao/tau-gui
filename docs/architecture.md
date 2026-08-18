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
  runtime manager, settings, filesystem, notifications, diagnostics
       ↓ strict JSONL
Runtime process
  `tau --mode rpc` or `pi --mode rpc`
```

## Core rule

The renderer never consumes raw runtime events. Runtime adapters normalize wire messages into stable application-domain types. This allows the runtime to be selected through configuration without spreading Tau/Pi branches through UI components.

## Session boundary

Runtime session files remain runtime-owned. The GUI uses RPC for messages, entries, trees, statistics, switching, compaction, naming, and export. GUI-owned recent-session metadata may reference runtime IDs or paths but must not reinterpret persisted transcripts.

## Initial runtime limitations

The common RPC surface supports text prompting, streaming, tools, steering, follow-ups, cancellation, model/thinking controls, direct bash, compaction, session inspection, tree/fork, naming, and HTML export. Optional behavior such as image prompts, cancellable direct bash, queue/retry controls, cloning, extension dialogs, login/logout, resource reload, and system-prompt/tool inspection must be capability-gated until both runtime adapters support it.
