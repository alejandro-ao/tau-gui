# Electron end-to-end tests

Playwright drives the **built** app (`out/main/index.js`) through
`_electron.launch`. Every launch is isolated and credential-free.

## How the harness works

- `helpers.ts` creates a temporary `userData` directory per launch and passes it
  to the main process through the `TAU_GUI_USER_DATA_DIR` environment hook
  (`src/main/index.ts`). Developer settings are never read or written.
- A `settings.json` is seeded into that directory pointing the runtime binary at
  `test/fake/fake-runtime.mjs` with `cwd` set to a temporary project directory,
  so no provider credentials are ever needed.
- Prompt keywords select the fake runtime's deterministic scripts: default,
  `tool`, `thinking`, `error`, `compact`, `slow`. `FAKE_RUNTIME_DELAY_MS` paces
  the stream when a test needs to observe a running turn.
- Each launch appends a unique `--e2e-marker <id>` to the runtime arguments, so
  `killRuntime()` can find and SIGKILL exactly that launch's child process for
  the crash/restart test.

## Running

```bash
npm run build            # required: the tests use out/
npx playwright test      # functional specs (visual + real-runtime are skipped)
npm run test:e2e         # build + functional specs

npm run test:visual         # VISUAL=1, compares against the committed baselines
npm run test:visual:update  # VISUAL=1 --update-snapshots, regenerates baselines

npm run test:smoke:real  # optional, needs a real installed `tau` on PATH
```

## Visual regression

`visual.spec.ts` is skipped unless `VISUAL=1`. It fixes the window size,
disables animations/transitions/caret blink, forces `prefers-reduced-motion`,
and masks volatile regions (temp paths, session ids, session file, git branch,
picker timestamps, tool elapsed times).

Transcript states a live stream cannot hold still for — tool _running_, tool
_failure_, long output — are produced by pushing domain events down the real
`main → renderer` event channel (`injectAgentEvent`), so the production preload
validation and reducer paths still run.

**Baselines are platform-specific.** Playwright stores them as
`e2e/visual.spec.ts-snapshots/<name>-<platform>.png`; fonts, DPI, and the GPU
stack all change rasterization, so a Linux CI run cannot reuse macOS baselines.
Regenerate the baselines for your platform with:

```bash
npm run test:visual:update
```

Review the resulting PNG diff before committing new baselines. On a platform
with no committed baselines, run the suite without `VISUAL=1` (the default) or
generate them first; the gate exists exactly so CI on other platforms can skip
the suite.

## Optional real-runtime smoke

`smoke.real.spec.ts` runs only with `TAU_GUI_REAL_RUNTIME=1`. It starts the real
runtime (`TAU_GUI_REAL_BINARY`, default `tau`; `TAU_GUI_REAL_KIND=pi` for Pi) and
asserts startup plus `agent.state` retrieval only. It never sends a prompt, so
it costs nothing and cannot depend on provider availability.

## Coverage map

| Spec                 | Flow                                                              |
| -------------------- | ----------------------------------------------------------------- |
| `startup.spec.ts`    | window, runtime connection, sidebar session/model, status cwd     |
| `prompting.spec.ts`  | streaming text and finalization, thinking block                   |
| `tools.spec.ts`      | read/edit/bash blocks, success state, Ctrl+O + per-block expand   |
| `cancel.spec.ts`     | Esc aborts the slow run, composer stays usable                    |
| `steering.spec.ts`   | Enter steers, Alt+Enter queues a follow-up, settles once          |
| `errors.spec.ts`     | error block rendering, composer still usable                      |
| `models.spec.ts`     | model picker from the status row and the palette, status updates  |
| `sessions.spec.ts`   | Ctrl+N and `/new` clear the transcript, recent-session picker     |
| `modals.spec.ts`     | focus trap, Escape closes, draft preserved                        |
| `crash.spec.ts`      | runtime SIGKILL → disconnected → restart keeps the draft          |
| `preload.spec.ts`    | no Node integration, narrow bridge surface, IPC validation        |
| `shell.spec.ts`      | `!echo hi` shell mode output                                      |
| `visual.spec.ts`     | themes, roles, tool states, diff, pickers, layouts, sidebar modes |
| `smoke.real.spec.ts` | optional real-runtime startup smoke                               |

## Real-runtime smoke tests

`smoke.real.spec.ts` is skipped unless `TAU_GUI_REAL_RUNTIME=1`:

```bash
# startup + state only (no provider call)
TAU_GUI_REAL_RUNTIME=1 npx playwright test e2e/smoke.real.spec.ts

# also complete one real coding turn (spends provider credit)
TAU_GUI_REAL_RUNTIME=1 TAU_GUI_REAL_PROMPT=1 npx playwright test e2e/smoke.real.spec.ts

# point at another runtime/binary or customize the prompt
TAU_GUI_REAL_KIND=pi TAU_GUI_REAL_BINARY=$(which pi) \
TAU_GUI_REAL_PROMPT_TEXT="…" TAU_GUI_REAL_PROMPT_EXPECT="…" \
TAU_GUI_REAL_RUNTIME=1 npx playwright test e2e/smoke.real.spec.ts
```

These never run in CI.
