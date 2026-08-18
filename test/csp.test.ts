import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CSP_META_PLACEHOLDER, buildCsp } from '../src/shared/csp.js';

const INDEX_HTML = fileURLToPath(new URL('../src/renderer/index.html', import.meta.url));

describe('Content-Security-Policy', () => {
  it('includes every hardening directive in production', () => {
    const policy = buildCsp(false);
    for (const directive of [
      "default-src 'none'",
      "script-src 'self'",
      "connect-src 'self'",
      "form-action 'none'",
      "base-uri 'none'",
      "object-src 'none'",
    ]) {
      expect(policy).toContain(directive);
    }
    expect(policy).not.toContain('localhost');
  });

  it('only relaxes connect-src and the react-refresh preamble in dev', () => {
    const dev = buildCsp(true).split('; ');
    const production = buildCsp(false).split('; ');
    const differing = dev.filter((directive, index) => directive !== production[index]);
    expect(differing).toEqual([
      "script-src 'self' 'sha256-Z2/iFzh9VMlVkEOar1f/oSHWwQk3ve1qk/C2WdsC4Xk='",
      "connect-src 'self' ws://localhost:* http://localhost:*",
    ]);
    // The dev policy must never fall back to unsafe-inline scripts.
    expect(buildCsp(true)).not.toContain("script-src 'self' 'unsafe-inline'");
  });

  it('keeps the document meta policy generated from the same source', () => {
    const html = readFileSync(INDEX_HTML, 'utf8');
    expect(html).toContain(`content="${CSP_META_PLACEHOLDER}"`);
    // No hand-written policy may live in the document.
    expect(html).not.toContain('default-src');
  });
});
