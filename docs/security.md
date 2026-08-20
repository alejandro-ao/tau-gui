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

## Application data and test hooks

- `AO_USER_DATA_DIR` (read once at startup in `src/main/index.ts`) redirects the
  Electron `userData` tree so end-to-end runs never read or write real settings.
  `TAU_GUI_USER_DATA_DIR` remains a deprecated alias, and the AO value wins.
- `AO_AGENT_DIR` redirects AO-owned session storage, defaulting to
  `~/.ao-agent`; `TAU_GUI_AGENT_DIR` is its deprecated alias. This path is
  never passed to Pi as its agent directory.
- `AO_TEST_RPC_RUNTIME` enables only the deterministic test adapter;
  `TAU_GUI_TEST_RPC_RUNTIME` remains a deprecated alias. These hooks relocate
  or select main-process test services; they grant no additional renderer
  capability and are ignored when unset.

Pi's standard `getAgentDir()` path remains independent and owns authentication,
models, skills, and prompts. AO-created session files are copied during legacy
migration without parsing or rewriting their JSONL contents. Configured AO/user-data roots and legacy settings paths reject stable symlink components; migration
uses exclusive same-directory temporary files, fsync/close, opaque-byte
verification, and atomic no-overwrite installation. Explicit session aliases are
physically checked before AO catalogs them. Node/Electron do not expose a
portable descriptor-relative, no-follow traversal API on every supported
platform, so these checks are fail-closed for stable configuration and are not a
sandbox against a concurrent same-user attacker replacing a checked component;
operations revalidate boundaries immediately around filesystem use and use
`O_NOFOLLOW` where Node provides it.

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
- A dedicated Electron utility process remains planned before enabling untrusted
  extensions by default, to recover crash isolation previously supplied by a
  subprocess.
- Strict JSONL framing/backpressure code remains available only to the explicit
  deterministic test adapter (`AO_TEST_RPC_RUNTIME=1`), never through user
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
- Session JSONL files are never parsed or rewritten by AO; session data comes
  from Pi's public SessionManager API and normalized runtime calls. Deliberate
  Pi session opening/import remains path-based and does not implicitly catalog
  every Pi session.
