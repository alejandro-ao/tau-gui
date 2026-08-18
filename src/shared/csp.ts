/**
 * Single source of truth for the Content-Security-Policy.
 *
 * The same policy string is sent as a response header by the main process and
 * injected into the renderer document's meta tag at build time, so the two can
 * never drift. Only `connect-src` differs, and only in development, where the
 * Vite dev server needs its HMR websocket.
 */

/** Placeholder replaced in `src/renderer/index.html` by the build plugin. */
export const CSP_META_PLACEHOLDER = '__CSP_POLICY__';

const DEV_CONNECT_SOURCES = "'self' ws://localhost:* http://localhost:*";

export function buildCsp(isDev: boolean): string {
  return [
    "default-src 'none'",
    "script-src 'self'",
    `style-src 'self' 'unsafe-inline'`,
    "img-src 'self' data:",
    "font-src 'self' data:",
    `connect-src ${isDev ? DEV_CONNECT_SOURCES : "'self'"}`,
    "form-action 'none'",
    "base-uri 'none'",
    "object-src 'none'",
  ].join('; ');
}
