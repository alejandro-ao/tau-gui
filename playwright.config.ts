import { defineConfig } from '@playwright/test';

/**
 * Electron end-to-end configuration.
 *
 * The suite drives the built app in `out/`, so run `npm run build` first
 * (`npm run test:e2e` does both). Visual specs are gated behind `VISUAL=1`;
 * see e2e/README.md.
 */
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  expect: {
    timeout: 15_000,
    toHaveScreenshot: {
      // Font rasterization differs slightly between runs on the same machine.
      maxDiffPixelRatio: 0.01,
      animations: 'disabled',
      caret: 'hide',
      // CSS pixels, so HiDPI displays do not double the baseline size.
      scale: 'css',
    },
  },
  // Electron launches are serialized: each test owns a real app process.
  fullyParallel: false,
  workers: 1,
  reporter: process.env['CI'] ? 'list' : 'line',
  retries: process.env['CI'] ? 1 : 0,
  use: {
    trace: 'retain-on-failure',
  },
});
