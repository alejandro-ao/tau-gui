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

/**
 * In development, @vitejs/plugin-react injects a small inline preamble
 * (react-refresh bootstrap). Inline scripts are otherwise forbidden, so the
 * dev policy pins its exact sha256 instead of allowing 'unsafe-inline'.
 * If the plugin version changes, Chrome's CSP console error prints the new
 * expected hash; update this constant.
 */
// Hash sources must be single-quoted; an unquoted sha256-… is an invalid source.
const REACT_REFRESH_PREAMBLE_SHA256 = "'sha256-Z2/iFzh9VMlVkEOar1f/oSHWwQk3ve1qk/C2WdsC4Xk='";

export function buildCsp(isDev: boolean): string {
  return [
    "default-src 'none'",
    `script-src 'self'${isDev ? ` ${REACT_REFRESH_PREAMBLE_SHA256}` : ''}`,
    `style-src 'self' 'unsafe-inline'`,
    "img-src 'self' data:",
    "font-src 'self' data:",
    `connect-src ${isDev ? DEV_CONNECT_SOURCES : "'self'"}`,
    "form-action 'none'",
    "base-uri 'none'",
    "object-src 'none'",
  ].join('; ');
}
