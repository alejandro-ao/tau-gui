# Development

## Toolchain (pinned)

| Tool                  | Version           | Why                                                           |
| --------------------- | ----------------- | ------------------------------------------------------------- |
| Electron              | 43.4.0            | current stable line with sandbox + context isolation defaults |
| electron-vite         | 5.0.0             | builds main/preload/renderer with one config                  |
| Vite                  | 7.3.6             | highest version electron-vite 5 supports                      |
| React                 | 19.2.8            | renderer UI                                                   |
| TypeScript            | 5.9.3             | strict mode; TS 7 is not yet supported by typescript-eslint   |
| Vitest                | 4.1.11            | unit, reducer, and adapter contract tests                     |
| Playwright            | 1.62.1            | Electron end-to-end tests                                     |
| zod                   | 4.4.3             | runtime validation of every IPC payload                       |
| marked + highlight.js | 18.0.10 / 11.12.0 | incremental Markdown without raw HTML                         |
| electron-builder      | 26.15.3           | macOS/Windows/Linux packaging                                 |

Direct dependencies are pinned exactly (no `^`), including tooling such as
`@eslint/js`. Review `package-lock.json` diffs on every dependency change.

Shipped renderer code (`react`, `react-dom`, `marked`, `highlight.js`) lives in
`dependencies`; build- and test-only packages stay in `devDependencies`. Vite
bundles the renderer into `out/renderer`, so `electron-builder.yml` excludes
`node_modules/**` from the package and the packaged output is unchanged by that
classification.

## Commands

```bash
npm install         # install pinned dependencies
npm run dev         # electron-vite dev server + Electron
npm run verify      # format:check + lint + typecheck + unit/contract tests
npm run test        # vitest only
npm run test:e2e    # build, then Playwright Electron tests (functional only)
npm run test:visual # build, then VISUAL=1 screenshot comparisons
npm run test:visual:update  # regenerate the platform-specific baselines
npm run test:smoke:real     # optional smoke against a real installed runtime
npm run build       # typecheck + production bundles into out/
npm run package     # unpacked platform build into release/
npm run dist        # installers/artifacts into release/
```

## Layout

```text
src/shared/       application-domain types + IPC contract (both processes)
src/main/         window, security, IPC routing, services, RPC transport, adapters
  rpc/            strict JSONL framing and correlated request client
  runtime/        AgentRuntime adapter, wire normalization, launch specs
  services/       settings, filesystem completion, runtime manager
src/preload/      narrow context-isolated bridge
src/renderer/     React UI, reducer state, transcript, composer, pickers
test/             unit + contract tests, deterministic fake JSONL runtime
e2e/              Playwright Electron tests
docs/             architecture, UI principles, RPC reference, roadmap status
```

## Testing model

- **Unit** — framing, request correlation/timeouts, normalization, reducer,
  settings, filesystem completion and traversal bounds, IPC handlers (with
  Electron mocked), the CSP source of truth, and the `RuntimeManager` state
  machine. No Electron app, no real runtime binaries.
- **Streaming** — `test/runtime-stream.test.ts` drives
  `test/fake/burst-runtime.mjs` to assert stdout flow control and stdin
  backpressure never lose or reorder records.
- **Contract** — `test/runtime-contract.test.ts` runs the same
  application-domain expectations against the `tau` and `pi` adapter
  configurations using `test/fake/fake-runtime.mjs`.
- **Electron E2E** — Playwright drives the built main process with the fake
  runtime injected through settings, covering startup, streaming, cancellation,
  steering/follow-ups, tool expansion, errors, model selection, sessions, modal
  focus, runtime crash/restart, shell mode, and preload isolation. Each launch
  gets throwaway `userData` and AO session directories through the
  `AO_USER_DATA_DIR` and `AO_AGENT_DIR` main-process hooks, so developer
  settings and sessions are never touched. The deprecated `TAU_GUI_*` aliases
  remain supported during the transition.
- **Visual regression** — `e2e/visual.spec.ts` compares fixed-size screenshots
  of every theme, transcript role, tool state, diff, picker, layout, and sidebar
  mode. It is gated behind `VISUAL=1` because baselines are platform-specific;
  see `e2e/README.md` for regeneration.

The fake runtime replays deterministic scripts keyed off prompt text
(`tool`, `thinking`, `error`, `compact`, `slow`), so CI never needs provider
credentials. Optional smoke tests against a real installed `tau`/`pi` are run
manually.

## Conventions

- The renderer only imports from `src/shared/**` and `src/renderer/**`.
- New runtime capabilities must be added to `RuntimeCapabilities`, gated in the
  adapter, and reflected in the UI as disabled-with-reason.
- Any new IPC action needs a zod schema entry, a result-map entry, and a handler.
- Update `docs/roadmap-status.md` when behavior changes.
