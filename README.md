# Tau GUI

A self-contained, terminal-inspired Electron coding-agent application powered
by an embedded, pinned Pi SDK. Its desktop experience remains modeled after
Tau's Textual TUI — transcript-first, no permanent header or shortcut footer,
vertical role bars, and keyboard-first pickers.

Pi runs in Electron's main process behind validated preload IPC. Renderer
components never import Pi or gain Node, process, credential, or filesystem
access.

## Status

The first slice of the Pi embedding migration is implemented and tracked in
[issue #17](https://github.com/alejandro-ao/tau-gui/issues/17). Ordinary runtime
operations now use Pi's SDK directly; remaining Pi-native sessions, auth,
extension UI, and removal of the legacy deterministic RPC test adapter are
tracked there. See [docs/roadmap-status.md](docs/roadmap-status.md).

## What works

- Manage working directories in the collapsible left rail, with each directory's
  sessions grouped beneath it. The rail plus button or `Shift+Ctrl+N`
  (`Shift+Cmd+N` on macOS) opens the native folder chooser; `/new` starts in the
  active session's directory without prompting.
- Prompt and watch text, thinking, and tool activity stream live.
- Let an agent start independent background sessions with the app-owned
  `spawn_session` tool. A target may be the current directory or another existing
  directory/worktree; spawned work appears in the sessions rail without changing
  the transcript being viewed.
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
- Discover Pi skills and custom prompts from project-root and home `.pi`/`.agents`
  locations, plus user-selected skill or prompt directories; browse with `/prompts`
  or `/skills`, then invoke them from the composer.

Optional protocol surfaces that one runtime lacks are shown disabled with the
reason. Nothing is faked.

## Architecture

```text
Electron renderer      React UI, normalized reducer state, virtualized transcript
        ↓ typed, zod-validated IPC
Electron preload       narrow context-isolated bridge (invoke + subscribe)
        ↓ Electron IPC
Electron main          app services + normalized embedded-Pi adapter
        ↓ direct typed SDK calls/events
Pinned Pi SDK           sessions, models, resources, tools, providers
```

The renderer has no Node integration, spawns nothing, never reads credentials or
session files, and consumes only normalized application-domain events. Details:
[docs/architecture.md](docs/architecture.md),
[docs/security.md](docs/security.md),
[docs/rpc-protocol.md](docs/rpc-protocol.md),
[docs/ui-principles.md](docs/ui-principles.md).

## Requirements

- Node.js 22+ for development.
- Provider credentials configured through Pi's standard agent directory for real
  model requests. No separately installed Tau or Pi executable is required.

## Quick start

```bash
npm install
npm run dev       # Electron + Vite dev server
npm run verify    # format, lint, strict typecheck, unit + contract tests
npm run test:e2e  # build, then Playwright Electron tests (fake runtime)
```

Full command list and testing model: [docs/development.md](docs/development.md).
