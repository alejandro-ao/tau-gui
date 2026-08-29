# Security boundary

## Electron settings

`src/main/index.ts` creates every window with:

- `contextIsolation: true`
- `sandbox: true`
- `nodeIntegration: false`, `nodeIntegrationInWorker: false`
- `webviewTag: false`
- a preload script exposing exactly two functions
- a strict Content-Security-Policy response header plus an identical in-document
  meta CSP. Both are generated from one source (`src/shared/csp.ts`): the main
  process sends it as a header, and the build injects the same string into
  `src/renderer/index.html` in place of the `__CSP_POLICY__` placeholder, so the
  two can never drift.

  Production policy:
  `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; form-action 'none'; base-uri 'none'; object-src 'none'`
  (production; in development `connect-src` additionally allows the Vite dev
  server and `script-src` pins the sha256 of the react-refresh inline preamble —
  see `src/shared/csp.ts`)

  Development builds differ in exactly one directive —
  `connect-src 'self' ws://localhost:* http://localhost:*` — so the Vite dev
  server and its HMR websocket work. Packaged builds never contain it.

- `setPermissionRequestHandler` denying every optional permission
- `setWindowOpenHandler` denying all popups and routing `https:` links to the OS
- `will-navigate` blocked except for the dev server URL

## Test-only hooks

- `TAU_GUI_USER_DATA_DIR` (read once at startup in `src/main/index.ts`)
  redirects the Electron `userData` tree so end-to-end runs never read or write
  real settings. It only relocates app-owned storage; it grants no additional
  capability to the renderer and is ignored when unset.

## IPC

- One invoke channel and one event channel.
- Every request is validated with a zod discriminated union
  (`src/shared/ipc.ts`) before a handler runs; invalid payloads never reach
  services.
- Handlers return `{ ok, value | error }`; exceptions become error strings and
  never leak stack traces to the renderer.
- The renderer can never name an executable. `runtime.probe` takes at most a
  runtime `kind`; the binary always comes from persisted settings, and the
  reported version is reduced to the first line, stripped of control
  characters, and truncated to 80 characters before it leaves the main process.
- Renderer-visible runtime/settings state and the complete bounded `BridgeEvent`
  union are strictly parsed in main before send and again in preload before React.
  Every agent-event variant, nested message, tool payload, queue, activity,
  diagnostic, settings record, and null lifecycle result is checked; malformed,
  extra-field, deeply nested, or oversized payloads are rejected. Session-target
  IDs are capped at 128 characters with no extra fields. Session names are capped
  at 500 characters before mutation, normalized, stripped of control/formatting/
  surrogate characters, trimmed, and paired with a strictly parsed null result.

## Embedded agent safety

- Production imports a pinned Pi SDK in Electron's main process; no user-selected
  runtime executable or shell-built launch command exists.
- Pi events and objects are normalized before IPC. Session catalogs contain at
  most 500 bounded metadata records and omit session-file paths. Native and
  remembered records are tagged; native resume/export uses a bounded opaque ID
  hashing a canonical encoding of the complete observed physical generation
  (path, device/inode key, size, mtime, and ctime), while legacy paths remain only in main-owned settings (renderer
  settings redact them). Runtime snapshots, status events, agent state, and
  details expose only a persisted/ephemeral flag, never the backing session path.
  Conflicting logical IDs or physical files are omitted.
  SDK sessions, credentials, provider headers, environment values, resource
  contents, and extension implementations never enter renderer state.
- Third-party Pi extensions are disabled by the embedded resource loader until a
  desktop trust decision and bounded UI contract exist. Extensions execute
  arbitrary Node.js and are not a sandbox.
- Provider/tool diagnostics use the existing bounded in-memory ring (500 lines)
  and are dropped when the app exits.
- A dedicated Electron utility process remains planned before enabling untrusted
  extensions by default, to recover crash isolation previously supplied by a
  subprocess.
- Strict JSONL framing/backpressure code remains available only to the explicit
  deterministic test adapter (`TAU_GUI_TEST_RPC_RUNTIME=1`), never through user
  settings.

## Untrusted content

- Model Markdown is tokenized and rendered as React elements. Raw HTML from the
  model is displayed as text; nothing from the model becomes markup.
- The only injected HTML is highlight.js output, which escapes its input.
- Remote images are not fetched; alt text is shown.
- Links open only through `ui.openExternal`, restricted to `https:`, `http:`,
  and `mailto:` after URL parsing.
- Tool output, patches, and extension content are rendered as plain text.

## Secrets

- Credentials are owned by Pi's main-process model runtime and standard agent
  configuration. The renderer never reads, stores, or forwards provider keys.
- `process.env` is passed to the child process but never sent to the renderer or
  written to logs.
- Settings persisted by the GUI contain only binary paths, provider/model names,
  UI preferences, session references, and resource-directory paths explicitly
  selected through Electron's native folder chooser.

## Filesystem

- `@` completion runs in the main process, rooted at the session cwd, skipping
  `.git`, `.venv`, `node_modules`, `__pycache__`, `build`, `dist`, and similar
  directories, with bounded breadth and result counts.
- Explicit `../` traversal typed by the user is allowed, but bounded: the search
  root must stay within **two levels above the session cwd** and, when it leaves
  the cwd subtree, inside the user's home directory (an ancestor of the cwd is
  always allowed for projects outside home). Anything further — including
  absolute paths such as `/etc/` — returns an empty result list rather than an
  error.
- Dropped file paths are only relativized for display; the renderer receives no
  filesystem handles.
- Pi reads skills and prompt templates in the main process. Project-root and home
  `.pi`/`.agents` locations are added to Pi's SDK loader, while custom directories
  must be selected explicitly. Only bounded catalog metadata crosses IPC.
- The GUI never parses Pi session JSONL. Public `SessionManager` APIs perform
  validation/listing/tree work. Import validates the selected source's no-follow,
  singly-linked, bounded physical identity, copies from that handle directly to one
  exclusive random final file under `<agent-dir>/imported-sessions`, and only then
  lets `SessionManager.open()` validate or migrate the app-owned final. Pi never
  opens or mutates the external chooser source. The app rejects owned logical IDs
  before switching through the public runtime API. Successful imports create no
  disposable staging copy and never consume recovery capacity. Existing files are
  never overwritten. Node does not expose handle-relative unlink, so the app never
  path-deletes session artifacts after a separate ownership check. Malformed,
  duplicate, migration, replacement, and uncertain-copy failures retain and mark
  any created final; same-user replacements deliberately survive. Retained markers
  are capped at 32. Diagnostics → **reveal import recovery** uses an application
  service keyed by the configured Pi agent directory, so health/reveal remain
  available with no selected owner and while runtimes are stopped, failed, or
  restarting. Neither the directory nor a platform reveal error crosses renderer
  IPC. The default is `~/.pi/agent/imported-sessions`; a configured Pi agent
  directory replaces `~/.pi/agent`. Quit the app before manual recovery. Delete
  only a `*.retained` marker and its matching JSONL after inspecting them; ordinary
  unmarked JSONL files are real imported sessions. Every marker suffix consumes
  one of 32 slots even if replaced by a symlink or unknown entry. Restarting
  preserves files, markers, and capacity; the app never performs automatic or
  path-based cleanup.
- Catalog discovery uses iterative directory handles and directory/file/byte/time
  metadata budgets. Roots, children, and files are lstat/realpath checked for
  containment, symlinks and hardlinks are rejected, SDK calls are sequential,
  and malformed SDK records are isolated. Catalog results carry an explicit
  completeness bit: skipped directories, omitted/malformed/duplicate records,
  identity conflicts, or budget truncation make identity-sensitive import and
  reservation operations fail closed until a later complete scan recovers. Pi
  0.84.2's public `list/listAll` API
  has no file/byte/deadline/AbortSignal parameters, so a same-user filesystem
  mutation between the final metadata recheck and Pi's read cannot be eliminated
  portably. Every approved file is rechecked immediately before each SDK listing
  call; mutation after that recheck remains possible because the API cannot
  consume pre-opened handles. The app fails closed before calls when metadata budgets are exceeded;
  a truly cancellable hard deadline requires an upstream bounded listing API.
- Tree IPC is a flat, iterative, presentation-only row list (2,000 rows, depth
  128, 500-character previews). It never carries images, full messages, tool
  arguments/results, or extension/custom details. Editable navigation text is
  capped at 100,000 characters after Pi mutates the branch and carries an explicit
  truncation flag, so successful mutation is never reported as schema failure.
  Portable export resolves inactive selections through a fresh complete catalog.
  Active export instead binds the runtime's main-only live path, authoritative
  session ID, and physical identity, which also supports main-owned legacy paths
  outside catalog roots. It opens the source no-follow, copies through that handle,
  checks source timestamps/identity/size for stability, and exclusively creates the
  native-dialog destination in a revalidated physical parent. It never overwrites:
  a collision explains the create-new-only rule and reopens the save dialog.
  Renderer requests cannot supply paths. HTML export's weaker boundary is the
  destination path: Pi's public root SDK exposes only `exportToHtml(path)`, not a
  handle-based destination API. Active HTML renders from the live session; it does
  not reopen a source path. The selected export destination is the sole intentional
  session-related path returned to the renderer after the user chose it.
