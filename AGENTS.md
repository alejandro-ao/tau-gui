# Tau GUI Agent Instructions

## Product goal

Build a secure Electron desktop frontend that can drive Tau or Pi through a shared RPC adapter. Preserve Tau's terminal-inspired visual design and interaction model.

## Architecture

Keep these boundaries explicit:

```text
renderer → preload IPC contract → main-process services → runtime adapter → RPC subprocess
```

- Renderer: UI and frontend-only state. No Node integration or process access.
- Preload: narrow typed IPC bridge with runtime validation.
- Main: subprocesses, strict JSONL framing, filesystem access, notifications, logs, and settings.
- Runtime adapters: normalize Tau/Pi protocol differences into application-domain commands, events, and snapshots.
- Never parse Tau or Pi session JSONL directly; use RPC commands.

## Security

- Enable context isolation and renderer sandboxing.
- Disable Node integration in the renderer.
- Apply a strict Content Security Policy.
- Validate all IPC and RPC payloads.
- Treat model Markdown, links, tool output, and extension content as untrusted.
- Spawn argument arrays directly; never interpolate runtime settings into shell commands.
- Keep credentials and environment details out of renderer state and logs.

## Development workflow

- Use pinned direct dependencies and review lockfile changes.
- Add deterministic unit tests for reducers/transports and Electron integration tests for user flows.
- Keep runtime-independent behavior in shared application-domain modules.
- Use fake RPC processes in CI; paid provider access must never be required.
- Implement work in focused commits and update roadmap/docs when behavior changes.
- Always commit with a clear, detailed after making a change to the codebase.
