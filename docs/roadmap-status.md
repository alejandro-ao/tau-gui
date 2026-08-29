# Roadmap status

Issue #1 is the historical Tau/Pi RPC roadmap. The active architecture migration is [issue #17](https://github.com/alejandro-ao/tau-gui/issues/17).

## Embedded Pi migration — initial slice ✅

- Pinned `@earendil-works/pi-coding-agent` as an application dependency; production no longer requires an installed runtime executable.
- Added `EmbeddedPiRuntime`, preserving normalized application-domain events and the renderer/preload/main security boundary.
- Pi SDK now owns production sessions, models, thinking, compaction, bash, tree navigation, labels, cloning, HTML/native-catalog JSONL export, bounded session catalogs, resources, and context-file metadata. Import is explicitly blocked.
- The app injects a trusted `spawn_session` SDK tool that creates an independently
  running session in the current directory or another existing directory. The
  main-process runtime pool owns its queue, lifecycle, and sidebar activity.
- Removed runtime/binary/provider/argument/trust controls from the active settings UI and migrated persisted runtime selection to Pi.
- Removed Tau/Pi switch entries from the command palette.
- Third-party extensions are deliberately disabled pending the trust and desktop extension-UI work tracked in #17.
- The strict JSONL runtime remains only as an explicit fake adapter for deterministic unit, contract, and Electron tests; production cannot select it.
- Remaining provider auth, images, retries, extension UI, test-fake conversion, compatibility-code deletion, and inactive-session HTML export remain tracked in #17. Pi 0.84.2 implements inactive HTML export internally but does not export that function from the package's public entry point.

## Active desktop contract audit

A capability is `true` only when this version of the app can execute it through
all required layers:

```text
Pi SDK or app service → AgentRuntime → validated IPC/preload → renderer flow → tests
```

SDK support by itself is not a desktop capability. Pi-native listing and cloning
are now complete desktop slices; auth, resources reload, tools, system prompts,
images, retries, import, and extensions remain disabled until the app exposes bounded
domain operations and usable desktop flows.
`CAPABILITY_RUNTIME_METHODS` in `src/main/runtime/agent-runtime.ts` records the
minimum runtime operation for every capability; IPC, renderer, and test coverage
are additional requirements.

| Capability               | Runtime operation                    | IPC / renderer   | Advertised | Next action                                       |
| ------------------------ | ------------------------------------ | ---------------- | ---------- | ------------------------------------------------- |
| text prompts             | `prompt`                             | complete         | yes        | maintain contract tests                           |
| steering / follow-ups    | `steer`, `followUp`                  | complete         | yes        | maintain queue and E2E coverage                   |
| direct bash              | `runShell`                           | complete         | yes        | maintain contract tests                           |
| cancellable bash         | `abortShell`                         | no renderer flow | no         | add cancellation UX and E2E coverage              |
| session tree / fork      | bounded rows, `navigateTree`, labels | complete         | yes        | maintain cancellation/adversarial coverage        |
| image prompts            | no image-bearing prompt operation    | missing          | no         | add bounded attachment DTOs and UI                |
| retry controls           | retry events only                    | missing          | no         | add policy, progress, and cancellation operations |
| session clone            | public branch create + switch        | complete         | yes        | maintain cleanup/lifecycle coverage               |
| session import           | path-following/mutating open only    | fail-closed UI   | no         | upstream immutable handle/bytes validator         |
| session listing          | preflight + `SessionManager.listAll` | complete         | yes        | upstream abortable bounded listing API            |
| extension dialogs        | extensions intentionally disabled    | missing          | no         | define trust and isolation first                  |
| provider login/logout    | Pi SDK primitive only                | missing          | no         | add main-owned auth flows                         |
| resource reload          | loader exists; no reload operation   | missing          | no         | add counts, diagnostics, and refresh flow         |
| system prompt inspection | active prompt exists only in main    | missing          | no         | add bounded local-only inspection                 |
| tool catalog             | active tools exist only in main      | missing          | no         | add bounded schemas/origins and picker            |

The next implementation order is:

1. expose system-prompt inspection, tool-catalog inspection, and resource reload
   as complete vertical slices;
2. expose inactive-session HTML export if Pi adds a public root export; portable
   JSONL export remains limited to fresh complete native catalog records;
3. add provider authentication and Pi-owned retry/settings controls;
4. add images and extension interactions after their security boundaries are
   defined;
5. enable import only after Pi exposes immutable handle/bytes validation and
   activation without a path reopen;
6. remove the compatibility runtime and JSONL test infrastructure, then finish
   release hardening.

## Roadmap reconciliation notes

The embedded foundation already uses Pi's `AgentSessionRuntime`, session manager,
model services, and default resource loader. Issue #17 checklist items describing
those foundations should be treated as complete; their remaining desktop UI and
IPC work is tracked separately in the audit above. Historical references below
describe how the app reached its current architecture and are not active feature
claims.

## Historical RPC roadmap

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
- One answer per turn: reasoning and pre-tool narration stay on the activity
  rail, which collapses into a duration summary before the answer.
- Tool grouping, progress, previews, patch/diff rendering, expansion
  (global `Ctrl+O` plus per-block).
- Sidebar and compact status row.
- Transcript virtualization with scroll anchoring and a new-output affordance.
- `tau-light` and `high-contrast` themes; responsive sidebar drawer.
- Clipboard actions and external links: only `http`, `https`, and `mailto` hrefs
  are rendered as links (anything else becomes inert text), and opening goes
  through the main-process allowlist.

## Phase 3 — interaction parity ✅

- Main-process, per-session editable prompt queues: Enter during a run queues
  priority guidance, Alt+Enter queues a follow-up, and settled turns drain
  steering FIFO before follow-up FIFO as fresh prompts. Empty-composer Up
  atomically removes newest follow-up then newest guidance for editing; stable
  IDs preserve duplicate text and native runtime queues are not authoritative.
- Command palette (`Ctrl+K`) and slash completion merge RPC-reported and GUI
  commands through one registry (`src/renderer/src/components/modals/commands.ts`).
  Slash completion accepts with Enter (run) or Tab (complete text); unknown slash
  input is sent as a normal prompt. Registered commands are parsed locally before
  prompting because RPC `prompt` does not execute TUI commands. Arguments work for
  `/name`, `/resume`, `/compact`, `/export`, `/model`, `/thinking`, and `/theme`.
  Runtime-reported built-ins are deduplicated against GUI handlers.
- Skills and prompt templates come from the embedded Pi SDK's authoritative
  resource loader. The desktop adapter supplies project-root and home
  `.pi`/`.agents` skill and prompt locations (including the standard
  `~/.pi/agent` directories), plus separately persisted user-selected skill and
  prompt directories. Changing a custom directory restarts the active session so
  Pi reloads the actual expansion catalog. `/skills` and `/prompts` open searchable
  pickers, and selected invocations are
  sent through Pi for authoritative expansion. Slash completion mirrors Pi's
  categories: typing `/` lists builtins and custom prompt templates under
  separate headings; individual skills are offered only once `/skill:` has been
  typed.
  The sidebar summarizes the aggregate skill footprint as an approximate token
  count (for example, `~2k tokens`), preserving the deterministic
  one-token-per-four-characters estimate over each `SKILL.md`. Only bounded
  metadata, including that numeric estimate, crosses IPC; resource contents
  remain in main-process filesystem access.
- A leading `/skill:<name>` or custom-prompt token in the draft is highlighted as a
  coloured pill, drawn by a mirrored backdrop behind the composer textarea
  (`src/renderer/src/components/completion/directives.ts`). Only names present in
  the catalog match, so the pill distinguishes runtime expansions from GUI commands
  before Enter is pressed. Slash completion entries use the same colours.
- Commands with no GUI implementation (`/tools`, `/system`, `/reload`, `/login`,
  `/logout`, `/clone`, and extension commands that RPC can list but not execute)
  are listed as unavailable with the reason instead of being sent incorrectly to
  the model. `/clone` stays unavailable even on Pi, where the runtime supports it,
  because the desktop app has no clone flow yet.
  The registry enforces this: an entry without a handler must declare a reason,
  and running it reports that reason instead of doing nothing.
- One accessible picker framework (`Modal` + `Picker`) with focus trapping,
  Escape cancellation, keyboard/mouse parity, fuzzy filtering, and selection
  that stays stable across async refreshes.
- `@` file completion through the constrained main-process service, debounced in
  the renderer, inserting quoted display paths at the cursor.
- Composer drafts live in the store, so they survive modals, session switches,
  and runtime switches. Local undo/redo history also covers programmatic clears
  and prompt-history replacements.
- `!`/`!!` direct shell mode with amber prompt styling.
- Drag/drop path insertion with quoting.
- Native completion notifications (only while the window is unfocused and
  `turnNotification` is `desktop`, keyed on a settle counter so repeated
  identical answers still notify) and `τ | session [| running]` window titles.
  Both are covered by renderer tests and an Electron end-to-end test.
- Hotkey reference modal.

## Phase 4 — models, context, sessions ✅

- Model picker with full RPC metadata and `Ctrl+P` cycling; scoped models are
  badged in the picker.
- App-owned scoped ("favourite") models: `/scoped-models` opens a
  keyboard/mouse picker that toggles scope without calling `set_model`. The
  selection is persisted per runtime by the main process
  (`AppSettings.scopedModels`, keyed by collision-safe JSON provider/model
  tuples) through an atomic validated settings IPC action, never by renderer
  storage. Once two scoped models are
  reported by the runtime, `Ctrl+P` cycles only those (through `set_model`);
  otherwise it falls back to the runtime's own `cycle_model`, so stale or empty
  scopes cannot trap the user.
- Thinking level picker, `Shift+Tab` cycling, `Ctrl+T` visibility.
- Session details plus a focused sidebar with activity counts, usage/cache, and
  discovered context files. The cache hit figure is derived from reported token
  counts, so it is shown as an estimate (`~`). Context lists the actual
  `AGENTS.md` files loaded by Pi, including its global agent file and the files
  discovered while walking up from the session working directory. Discovery
  stays in the main process; only bounded labels and paths cross IPC.
- Pi-native session picker and working-directory rail use metadata-budgeted
  `SessionManager.listAll` records with bounded opaque catalog identities bound to
  the complete physical generation; app recents are tagged main-resolved fallbacks;
  backing paths are absent from all
  renderer settings/state/status DTOs and renderer fallback never creates IDs.
- New/switch/name, bounded flat-row tree navigation with explicitly truncated editable user turns,
  labels, no/default/custom branch summaries, clone, fresh-native-catalog portable
  export, HTML export, fail-closed import explanation, compaction, settings, and diagnostics modals.
  Renderer-visible runtime/settings state and every bounded bridge event variant
  are schema-parsed in main and preload.
- Concurrent live sessions through a main-process runtime pool: selecting a
  session no longer switches or stops a running session process, and background
  stream events cannot leak into the active transcript.

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
  mode, desktop notifications, and preload isolation against the fake JSONL
  runtime.
- Screenshot regression for themes, roles, tool states, diffs, pickers, and
  layouts behind `VISUAL=1` (`e2e/README.md`), plus an optional real-runtime
  startup smoke behind `TAU_GUI_REAL_RUNTIME=1`.

## Phase 6 — missing RPC surfaces ⏳ upstream

Capability flags exist and are `false` until both adapters can implement them
with conformance tests:

| Surface                          | Flag                     | Status                                                     |
| -------------------------------- | ------------------------ | ---------------------------------------------------------- |
| portable session listing         | `sessionList`            | production embedded Pi provides a bounded native catalog   |
| cancellable direct bash          | `abortBash`              | Pi only                                                    |
| queue modes / retry controls     | `retryControls`          | Pi only                                                    |
| session clone                    | `sessionClone`           | production embedded Pi provides the complete `/clone` flow |
| image prompts                    | `imagePrompt`            | Pi only; GUI drop previews deferred                        |
| extension dialogs/status/widgets | `extensionDialogs`       | Pi subprotocol only; Tau routes extension UI to stderr     |
| provider login/logout            | `providerLogin`          | neither                                                    |
| resource reload                  | `resourceReload`         | neither                                                    |
| system prompt inspection         | `systemPromptInspection` | neither                                                    |
| tool catalog                     | `toolCatalog`            | neither                                                    |
| interactive project trust        | n/a                      | headless RPC; exposed as launch-time approve/decline       |

## Phase 7 — packaging and release ⏳ partial

- ✅ Runtime binary discovery (`src/main/services/discovery.ts`, `detect` in the
  settings dialog) with first-run failure messaging, bounded diagnostics,
  `electron-builder` config for dmg/nsis/AppImage/deb, unsigned packaging in CI.
- ⏳ Requires credentials or hardware and is therefore not wired up here: macOS
  signing/notarization secrets, Windows code signing, update strategy, and
  clean-machine release smoke tests.
- ⏳ Accessibility and performance audit passes.

## Verified manually

- A real `tau --mode rpc` session completes a coding turn in the packaged
  renderer, including a built-in `read` tool call
  (`TAU_GUI_REAL_RUNTIME=1 TAU_GUI_REAL_PROMPT=1 npx playwright test e2e/smoke.real.spec.ts`).
- A real `pi --mode rpc` session starts, reports state, and its extension UI
  requests are dismissed instead of stalling the stream.
- `npm run package` produces an unsigned macOS arm64 app bundle.
