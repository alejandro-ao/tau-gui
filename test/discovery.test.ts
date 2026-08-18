import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  MAX_VERSION_LENGTH,
  extractVersion,
  probeRuntime,
  resolveBinary,
} from '../src/main/services/discovery.js';

let binDir: string;
let script: string;
const originalPath = process.env['PATH'];

beforeAll(() => {
  binDir = mkdtempSync(join(tmpdir(), 'tau-gui-bin-'));
  script = join(binDir, 'fake-tau');
  writeFileSync(script, '#!/bin/sh\necho "tau 9.9.9"\n');
  chmodSync(script, 0o755);
  writeFileSync(join(binDir, 'not-executable'), 'nope\n');

  // A hostile/broken binary: control characters, huge output, many lines.
  const noisy = join(binDir, 'noisy-tau');
  writeFileSync(
    noisy,
    `#!/bin/sh\nprintf 'tau \\033[31m1.2.3\\033[0m %s\\nsecond line\\n' "$(head -c 500 /dev/zero | tr '\\0' 'x')"\n`,
  );
  chmodSync(noisy, 0o755);
});

afterEach(() => {
  process.env['PATH'] = originalPath;
});

describe('resolveBinary', () => {
  it('finds an executable on PATH', async () => {
    process.env['PATH'] = binDir;
    expect(await resolveBinary('fake-tau')).toBe(script);
  });

  it('ignores non-executable matches', async () => {
    process.env['PATH'] = binDir;
    expect(await resolveBinary('not-executable')).toBeNull();
  });

  it('accepts explicit paths without searching PATH', async () => {
    process.env['PATH'] = '';
    expect(await resolveBinary(script)).toBe(script);
    expect(await resolveBinary(join(binDir, 'missing'))).toBeNull();
  });

  it('returns null for a missing binary', async () => {
    process.env['PATH'] = binDir;
    expect(await resolveBinary('definitely-not-here')).toBeNull();
  });
});

describe('extractVersion', () => {
  it('keeps only the first non-empty line', () => {
    expect(extractVersion('  tau 1.0.0  \nextra\n')).toBe('tau 1.0.0');
    expect(extractVersion('', 'pi 2.0.0\n')).toBe('pi 2.0.0');
  });

  it('strips control characters and returns null for empty output', () => {
    // The ESC byte is removed; remaining printable escape text is harmless.
    expect(extractVersion('\u001b[31mtau\u001b[0m 1.0.0')).toBe('[31mtau[0m 1.0.0');
    expect(extractVersion('')).toBeNull();
    expect(extractVersion('\u0000\u0007\n')).toBeNull();
  });

  it('truncates long output', () => {
    const version = extractVersion('v'.repeat(500));
    expect(version).toHaveLength(MAX_VERSION_LENGTH);
  });
});

describe('probeRuntime', () => {
  it('reports the resolved path and version', async () => {
    process.env['PATH'] = binDir;
    const probe = await probeRuntime('tau', 'fake-tau');
    expect(probe).toMatchObject({ resolved: script, version: 'tau 9.9.9', error: null });
  });

  it('bounds and sanitizes the reported version', async () => {
    process.env['PATH'] = binDir;
    const probe = await probeRuntime('tau', 'noisy-tau');
    expect(probe.version).not.toBeNull();
    const version = probe.version as string;
    expect(version.length).toBeLessThanOrEqual(MAX_VERSION_LENGTH);
    expect(version).not.toContain('\n');
    expect(version).not.toContain('second line');
    // eslint-disable-next-line no-control-regex
    expect(version).not.toMatch(/[\u0000-\u001F]/);
  });

  it('explains a missing binary in actionable terms', async () => {
    process.env['PATH'] = binDir;
    const probe = await probeRuntime('pi', 'pi-not-installed');
    expect(probe.resolved).toBeNull();
    expect(probe.error).toContain('was not found on PATH');
    expect(probe.error).toContain('pi');
  });
});
