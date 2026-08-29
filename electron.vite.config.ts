import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { copyFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CSP_META_PLACEHOLDER, buildCsp } from './src/shared/csp.js';

/**
 * Injects the same Content-Security-Policy the main process sends as a header
 * into the document meta tag, so the two policies cannot drift. Only the
 * development build allows the Vite dev-server origins.
 */
function utilityWorkerPlugin(): Plugin {
  return {
    name: 'copy-extension-host-worker',
    closeBundle() {
      copyFileSync(
        resolve(__dirname, 'src/main/extension-host-worker.cjs'),
        resolve(__dirname, 'out/main/extension-host-worker.cjs'),
      );
    },
  };
}

function cspMetaPlugin(): Plugin {
  return {
    name: 'tau-gui-csp-meta',
    transformIndexHtml(html, context) {
      const isDev = Boolean(context.server);
      return html.replaceAll(CSP_META_PLACEHOLDER, buildCsp(isDev));
    },
  };
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), utilityWorkerPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
      },
    },
  },
  preload: {
    // The preload runs sandboxed, where `require` cannot resolve node_modules,
    // so runtime dependencies reached through src/shared must be bundled in.
    plugins: [externalizeDepsPlugin({ exclude: ['zod'] })],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react(), cspMetaPlugin()],
    resolve: {
      alias: { '@shared': resolve(__dirname, 'src/shared') },
    },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') },
      },
    },
  },
});
