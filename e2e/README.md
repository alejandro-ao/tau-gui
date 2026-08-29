# Electron end-to-end tests

`npm run test:e2e` builds production bundles and drives Electron with Playwright.

Every launch receives isolated temporary `userData`, project, and Pi agent directories. Normal E2E runs set `TAU_GUI_TEST_FAKE_PI=1`, which injects the in-process `FakePiRuntime` at the typed application-domain boundary. It emits deterministic Pi-domain lifecycle, streaming, tool, error, model, shell, queue, and session behavior without credentials, network access, executable discovery, or a JSONL protocol.

`e2e/embedded-pi.spec.ts` omits that flag and verifies production can start the bundled SDK without an external executable or provider request.

Visual tests are gated because font/GPU output is platform-specific:

```bash
npm run test:visual
npm run test:visual:update
```

CI runs functional E2E under Xvfb on Linux. Failed traces and reports are uploaded. Package smoke runs separately on macOS, Windows, and Ubuntu; see `docs/release-testing.md`.
