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
- Inbound events are shape-checked in the preload before reaching React.
- Introspection and reload responses are independently parsed in both main and preload. Requests accept no renderer payload beyond the existing session address, so the renderer cannot supply a path, prompt, schema, or loader option.

## Embedded agent safety

- Production imports a pinned Pi SDK in Electron's main process; no user-selected
  runtime executable or shell-built launch command exists.
- Pi events and objects are normalized before IPC. SDK sessions, credentials,
  provider headers, environment values, resource contents, and extension
  implementations never enter renderer state.
- Third-party Pi extensions are disabled by the embedded resource loader until a
  desktop trust decision and bounded UI contract exist. Extensions execute
  arbitrary Node.js and are not a sandbox.
- Provider/tool diagnostics use the existing bounded in-memory ring (500 lines)
  and are dropped when the app exits.
- `/system` reads `AgentSession.systemPrompt` directly into bounded renderer-only modal state (256 KiB maximum). It never creates a transcript block, invokes `prompt()`, or writes a session entry. Copying requires an explicit user action through the existing clipboard IPC.
- `/tools` treats the returned array, every descriptor, names, descriptions, origins, and parameter schemas as untrusted. Main reflects guarded own data descriptors before reading catalog values; array/descriptor accessors, malformed source metadata, duplicate normalized names, and throwing or revoked Proxies are omitted with bounded diagnostics. Parameter schemas additionally bound recursive depth, node/property/array counts, strings, and serialized UTF-8 bytes; preload independently enforces the resulting DTO. JavaScript cannot identify a Proxy without initiating internal Proxy operations: `Array.isArray` and descriptor reflection can invoke `ownKeys`/`getOwnPropertyDescriptor` traps. Those traps may begin and have arbitrary side effects, but a throw is caught and no ordinary `get` trap or accessor is intentionally invoked. SDK tool objects, implementations, output handlers, and filesystem authority never cross IPC.
- Live/restored tool and shell output uses a 65,536 UTF-16-character limit (not a byte or KiB claim); the truncation marker is included inside that limit. Restored entry/tree DTOs omit raw SDK entries, cap message fields, identifiers (including `leafId`), collection depth/count, and recursively bound tool arguments/details. The complete entry/tree wrapper, not only its collection, stays within a 1 MiB serialized UTF-8 budget and is strictly parsed in both main and preload. Direct-shell results are also strictly parsed at both boundaries.
- `/reload` uses public `AgentSession.reload()` in place. A per-target reservation is acquired synchronously before reload enters the lifecycle transition queue. Direct prompts claim the same work gate through `RuntimePool`; queued, settle-triggered, and background-target scheduling defer while reload owns it. Conversely, a prompt/work claim makes reload reject as active. Reservations are released on success and failure, after which retained queue work may resume. Reload remains serialized with reload, stop, restart, new-session, switch, and replacement transitions and verifies exact runtime/session identity after awaits. Only bounded category counts and diagnostics cross IPC; resource contents and extension implementations remain main-owned. Extensions remain disabled by policy after reload.
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
- Session JSONL files are never read by the GUI; all session data comes from RPC.
