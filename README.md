# Tau GUI

A terminal-inspired Electron desktop frontend for the Tau and Pi coding-agent
runtimes.

Tau GUI launches either runtime over its strict JSONL RPC mode and presents one
shared desktop experience modeled after Tau's Textual TUI — transcript-first, no
permanent header or shortcut footer, vertical role bars, keyboard-first pickers.

```json
{
  "agent_runtime": "tau"
}
```

Switching `agent_runtime` to `pi` preserves the ordinary coding-agent workflow.
Renderer components never branch on which runtime is attached.

## Status

Phases 0–5 of [issue #1](https://github.com/alejandro-ao/tau-gui/issues/1) are
implemented: foundation, usable chat, Tau visual parity, interaction parity,
models/context/sessions, and Tau/Pi interchangeability. Phase 6 waits on upstream
RPC surfaces; Phase 7 packaging is configured but signing, updates, and
clean-machine release smoke tests still need credentials and hardware. See
[docs/roadmap-status.md](docs/roadmap-status.md).

## What works

- Manage working directories in the collapsible left rail, with each directory's
  sessions grouped beneath it. The rail plus button or `Shift+Ctrl+N`
  (`Shift+Cmd+N` on macOS) opens the native folder chooser; `/new` starts in the
  active session's directory without prompting.
- Prompt and watch text, thinking, and tool activity stream live.
- Cancel (`Esc`), steer (`Enter` while running), or queue follow-ups
  (`Alt+Enter`) without waiting for the current run.
- Inspect exact tool commands, arguments, output, and patches through collapsed
  or expanded blocks (`Ctrl+O` toggles everything).
- Switch models (`Ctrl+P`) and thinking levels (`Shift+Tab`).
- Scope favourite models with `/scoped-models`: the app stores the list per
  runtime, and `Ctrl+P` cycles only scoped models once two are scoped.
- Run direct shell commands with `!` (adds output to context) and `!!` (does not).
- Compact, name, branch, resume, and export sessions.
- Keyboard-first command palette (`Ctrl+K`), slash completion, `@` file
  completion, drag/drop paths, three themes, and native completion notifications.
- Discover Tau custom prompts and skills from user/project `.tau` and `.agents`
  directories; browse with `/prompts` or `/skills`, then invoke them from the composer.

Optional protocol surfaces that one runtime lacks are shown disabled with the
reason. Nothing is faked.

## Architecture

```text
Electron renderer      React UI, normalized reducer state, virtualized transcript
        ↓ typed, zod-validated IPC
Electron preload       narrow context-isolated bridge (invoke + subscribe)
        ↓ Electron IPC
Electron main          runtime manager, settings, filesystem, notifications, diagnostics
        ↓ strict LF-only JSONL
Runtime subprocess     tau --mode rpc | pi --mode rpc
```

The renderer has no Node integration, spawns nothing, never reads credentials or
session files, and consumes only normalized application-domain events. Details:
[docs/architecture.md](docs/architecture.md),
[docs/security.md](docs/security.md),
[docs/rpc-protocol.md](docs/rpc-protocol.md),
[docs/ui-principles.md](docs/ui-principles.md).

## Requirements

- Node.js 22+ for development.
- An installed `tau` and/or `pi` binary on `PATH` (settings can point at an
  absolute path; the settings dialog has a `detect` check).

## Quick start

```bash
npm install
npm run dev       # Electron + Vite dev server
npm run verify    # format, lint, strict typecheck, unit + contract tests
npm run test:e2e  # build, then Playwright Electron tests (fake runtime)
```

Full command list and testing model: [docs/development.md](docs/development.md).
