# Tau GUI

A terminal-inspired Electron desktop frontend for Tau and Pi coding-agent runtimes.

Tau GUI will launch either runtime over its strict JSONL RPC mode and present one shared desktop experience modeled after Tau's Textual TUI.

```json
{
  "agent_runtime": "tau"
}
```

## Status

Planning. The product roadmap is tracked in this repository's GitHub issues.

## Architectural boundary

```text
Electron renderer → secure preload API → Electron main process → Tau/Pi RPC subprocess
```

The renderer consumes normalized application events. It does not access Node.js, spawn processes, parse runtime session files, or depend directly on Tau/Pi wire payloads.

## Development

The initial roadmap includes repository scaffolding, RPC transport, a fake deterministic runtime, transcript/composer UI, Tau visual parity, sessions/models/context, Tau/Pi switching, and desktop packaging.
