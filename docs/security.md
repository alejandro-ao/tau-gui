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
- Inbound events are shape-checked in the preload before reaching React.

## Subprocess safety

- The runtime is spawned with an argument array, `shell: false`. Binary paths,
  provider names, models, and extra args are never interpolated into a shell
  string.
- `--approve`/`--no-approve` is the only trust signal the GUI passes. Project
  trust controls ambient resource loading in the runtime; it is **not** a
  sandbox, and OS/container isolation remains a separate concern.
- Runtime stdout is parsed with strict LF-only JSONL framing and a 16 MiB record
  cap; malformed or oversized records are dropped with a diagnostic instead of
  crashing the session.
- stdin writes honour backpressure (queued in order until `drain`) and stdout is
  paused while the undecoded backlog exceeds a high-water mark, so a chatty
  runtime cannot grow unbounded memory. Record order is preserved.
- stderr is captured into a bounded diagnostics ring (500 lines) surfaced in the
  diagnostics modal. Runtime stderr may contain provider error text (endpoints,
  request ids, prose from failed calls). It is bounded, held in memory only,
  never persisted to settings or a log file, and dropped when the app exits.

## Untrusted content

- Model Markdown is tokenized and rendered as React elements. Raw HTML from the
  model is displayed as text; nothing from the model becomes markup.
- The only injected HTML is highlight.js output, which escapes its input.
- Remote images are not fetched; alt text is shown.
- Links open only through `ui.openExternal`, restricted to `https:`, `http:`,
  and `mailto:` after URL parsing.
- Tool output, patches, and extension content are rendered as plain text.

## Secrets

- Credentials live in the runtime's own configuration. The GUI never reads,
  stores, or forwards provider keys.
- `process.env` is passed to the child process but never sent to the renderer or
  written to logs.
- Settings persisted by the GUI contain only binary paths, provider/model names,
  UI preferences, and session references.

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
- Session JSONL files are never read by the GUI; all session data comes from RPC.
