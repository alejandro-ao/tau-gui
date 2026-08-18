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
  frontend commands, skills, and prompt templates.
- `@` file completion through the constrained main-process service.
- `!`/`!!` direct shell mode with amber prompt styling.
- Drag/drop path insertion with quoting.
- Native completion notifications and `τ | session [| running]` window titles.
- Hotkey reference modal.

## Phase 4 — models, context, sessions ✅

- Model picker with full RPC metadata and `Ctrl+P` cycling.
- Thinking level picker, `Shift+Tab` cycling, `Ctrl+T` visibility.
- Session details, usage/cache/context sidebar with cost or `$N/A`.
- App-owned recent-session picker (no runtime index parsing).
- New/switch/name, tree browser with fork, compaction, HTML export.

## Phase 5 — Tau/Pi runtime switching ✅

- One `JsonlAgentRuntime` adapter serves both runtimes; only launch specs and
  capability tables differ (`src/main/runtime/spec.ts`).
- `test/runtime-contract.test.ts` runs the same contract for `tau` and `pi`.
- Runtime selector plus per-runtime binary/provider/model/extra-args settings.
- Startup differences normalized (Tau `--session` id vs Pi deferred
  `switch_session` path; Pi inherits cwd from the spawn).
- Optional controls gated by capability with explanatory disabled states.
- GUI settings and composer drafts survive a runtime switch.

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

- ✅ Runtime binary discovery/first-run failure messaging, bounded diagnostics,
  `electron-builder` config for dmg/nsis/AppImage/deb, unsigned packaging in CI.
- ⏳ Requires credentials or hardware and is therefore not wired up here: macOS
  signing/notarization secrets, Windows code signing, update strategy, and
  clean-machine release smoke tests.
- ⏳ Accessibility and performance audit passes.
