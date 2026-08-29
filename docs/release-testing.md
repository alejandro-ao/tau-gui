# Release and clean-machine testing

## Automated repository gates

Run on every supported development host:

```bash
npm ci
npm run verify
npm run test:e2e
npm run package:smoke
```

`package:smoke` creates an unsigned directory package and verifies the platform executable and `app.asar` exist, are non-empty, and are executable where applicable. CI runs this on current GitHub-hosted macOS, Windows, and Ubuntu images. Electron E2E uses the in-process fake Pi and never requires provider credentials.

## Clean-machine matrix

For each release candidate, install the artifact on a clean VM or physical machine and record the exact OS/hardware:

- macOS: current supported arm64 and x64 releases; launch via Finder and command line; verify Gatekeeper result.
- Windows: current Windows 11 x64; install/uninstall; launch from Start; verify WebView-independent Electron startup.
- Linux: current Ubuntu LTS x64 under X11 and Wayland; install the produced package(s); verify sandbox startup.

On every machine verify: first launch with no existing Pi directory, existing Pi credentials/settings discovery, project chooser, one provider-backed turn supplied by the human tester, cancel/restart, session persistence, external links, notifications, keyboard-only modal navigation, 200% zoom, reduced motion, high contrast, and shutdown with no orphan processes.

## Accessibility and performance checklist

- Complete the whole primary flow by keyboard; focus must return after every modal.
- Inspect transcript/status announcements with VoiceOver, NVDA, or Orca.
- Verify visible focus, high-contrast theme, reduced-motion media query, and 200% zoom without clipped controls.
- Exercise a long virtualized transcript, large bounded tool output, rapid streaming, and multiple background sessions while watching renderer memory and main-process CPU.
- Confirm shutdown waits for runtime/session flush and leaves no Pi subprocess (none should exist in the embedded architecture).

## External release blockers

Repository automation cannot provide or validate Apple Developer ID, notarization credentials, Windows Authenticode certificates, Linux repository signing keys, provider subscriptions, or every hardware/driver combination. Unsigned package success is not a signing/notarization claim. Record those results separately for the release candidate; never place credentials in repository secrets available to pull requests.
