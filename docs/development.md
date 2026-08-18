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

Direct dependencies are pinned exactly (no `^`). Review `package-lock.json`
diffs on every dependency change.

## Commands

```bash
npm install         # install pinned dependencies
npm run dev         # electron-vite dev server + Electron
npm run verify      # format:check + lint + typecheck + unit/contract tests
npm run test        # vitest only
npm run test:e2e    # build, then Playwright Electron tests
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
  settings, filesystem completion. No Electron, no runtime binaries.
- **Contract** — `test/runtime-contract.test.ts` runs the same
  application-domain expectations against the `tau` and `pi` adapter
  configurations using `test/fake/fake-runtime.mjs`.
- **Electron E2E** — Playwright drives the packaged main process with the fake
  runtime injected through settings, covering startup, streaming, cancellation,
  tool expansion, pickers, and preload isolation.

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
