# Roadmap status

Tracks issue #1. Update this file whenever behavior changes.

## Phase 0 — foundation ✅

- Pinned Electron/Vite/React/TypeScript toolchain documented in
  `docs/development.md`.
- `src/main`, `src/preload`, `src/renderer`, `src/shared`, `test/`, `e2e/`
  scaffolded.
- ESLint (type-checked), Prettier, strict `tsc`, Vitest, Playwright, and GitHub
  Actions CI configured.
- Secure `BrowserWindow` defaults, header + meta CSP, permission and navigation
  handlers (`docs/security.md`).
- Application-domain protocol types and `RuntimeCapabilities`
  (`src/shared/domain.ts`).
- Deterministic fake JSONL runtime (`test/fake/fake-runtime.mjs`).
- Strict LF-only JSONL framing + correlated request client with timeouts
  (`src/main/rpc/*`).
- Startup, shutdown, crash, and stderr diagnostics through `RuntimeManager`.

## Phase 1 — usable Tau chat ✅

- `tau --mode rpc` launched from the main process with argument arrays only.
- Text and thinking streaming, authoritative `message_end` replacement.
- Safe Markdown + syntax highlighting without raw HTML.
- Tool lifecycle blocks, composer, cancellation, error blocks, connection states.
- `tau-dark` theme and the transcript-first layout.

## Phase 2 — Tau visual parity ✅

- Role-based transcript styling with vertical role bars.
- Tool grouping, progress, previews, patch/diff rendering, expansion
  (global `Ctrl+O` plus per-block).
- Sidebar and compact status row.
- Transcript virtualization with scroll anchoring and a new-output affordance.
- `tau-light` and `high-contrast` themes; responsive sidebar drawer.
- Clipboard actions and allowlisted external links.

## Phase 3 — interaction parity ✅

- Steering and follow-up queueing with pending state.
- Command palette (`Ctrl+K`) and slash completion merging RPC commands,
  frontend commands, skills, and prompt templates through one command registry
  (`src/renderer/src/components/modals/commands.ts`). Slash completion accepts
  with Enter (run) or Tab (complete text); unknown slash input is sent as a
  normal prompt.
- Capability-gated commands (`/tools`, `/system`, `/reload`, `/login`,
  `/logout`, `/scoped-models`, `/clone`) are listed as unavailable with the
  reason instead of failing silently.
- One accessible picker framework (`Modal` + `Picker`) with focus trapping,
  Escape cancellation, keyboard/mouse parity, fuzzy filtering, and selection
  that stays stable across async refreshes.
- `@` file completion through the constrained main-process service, debounced in
  the renderer, inserting quoted display paths at the cursor.
- Composer drafts live in the store, so they survive modals, session switches,
  and runtime switches.
- `!`/`!!` direct shell mode with amber prompt styling.
- Drag/drop path insertion with quoting.
- Native completion notifications and `τ | session [| running]` window titles.
- Hotkey reference modal.

## Phase 4 — models, context, sessions ✅

- Model picker with full RPC metadata and `Ctrl+P` cycling.
- Thinking level picker, `Shift+Tab` cycling, `Ctrl+T` visibility.
- Session details, usage/cache/context sidebar with cost or `$N/A`.
- App-owned recent-session picker with per-entry forget (no runtime index
  parsing); the UI states that cross-session listing needs `list_sessions`.
- New/switch/name, tree browser with fork (forked text is prefilled into the
  composer), compaction, HTML export, settings and diagnostics modals.

## Phase 5 — Tau/Pi runtime switching ✅

- One `JsonlAgentRuntime` adapter serves both runtimes; only launch specs and
  capability tables differ (`src/main/runtime/spec.ts`).
- `test/runtime-contract.test.ts` runs the same contract for `tau` and `pi`.
- Runtime selector plus per-runtime binary/provider/model/extra-args settings.
- Startup differences normalized (Tau `--session` id vs Pi deferred
  `switch_session` path; Pi inherits cwd from the spawn).
- Optional controls gated by capability with explanatory disabled states.
- GUI settings and composer drafts survive a runtime switch.

## Testing ✅

- Unit/contract suites (`npm run verify`) plus a Playwright Electron suite in
  `e2e/` covering startup, streaming, tools, cancellation, steering/follow-ups,
  errors, model selection, sessions, modal focus, runtime crash/restart, shell
  mode, and preload isolation against the fake JSONL runtime.
- Screenshot regression for themes, roles, tool states, diffs, pickers, and
  layouts behind `VISUAL=1` (`e2e/README.md`), plus an optional real-runtime
  startup smoke behind `TAU_GUI_REAL_RUNTIME=1`.

## Phase 6 — missing RPC surfaces ⏳ upstream

Capability flags exist and are `false` until both adapters can implement them
with conformance tests:

| Surface                          | Flag                     | Status                                                          |
| -------------------------------- | ------------------------ | --------------------------------------------------------------- |
| portable session listing         | `sessionList`            | missing in both runtimes; GUI keeps app-owned recent references |
| cancellable direct bash          | `abortBash`              | Pi only                                                         |
| queue modes / retry controls     | `retryControls`          | Pi only                                                         |
| session clone                    | `sessionClone`           | Pi only                                                         |
| image prompts                    | `imagePrompt`            | Pi only; GUI drop previews deferred                             |
| extension dialogs/status/widgets | `extensionDialogs`       | Pi subprotocol only; Tau routes extension UI to stderr          |
| provider login/logout            | `providerLogin`          | neither                                                         |
| resource reload                  | `resourceReload`         | neither                                                         |
| system prompt inspection         | `systemPromptInspection` | neither                                                         |
| tool catalog                     | `toolCatalog`            | neither                                                         |
| scoped models                    | `scopedModels`           | neither; all-model cycling is not labelled scoped               |
| interactive project trust        | n/a                      | headless RPC; exposed as launch-time approve/decline            |

## Phase 7 — packaging and release ⏳ partial

- ✅ Runtime binary discovery (`src/main/services/discovery.ts`, `detect` in the
  settings dialog) with first-run failure messaging, bounded diagnostics,
  `electron-builder` config for dmg/nsis/AppImage/deb, unsigned packaging in CI.
- ⏳ Requires credentials or hardware and is therefore not wired up here: macOS
  signing/notarization secrets, Windows code signing, update strategy, and
  clean-machine release smoke tests.
- ⏳ Accessibility and performance audit passes.
