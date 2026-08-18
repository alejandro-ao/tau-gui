import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { probeRuntime, resolveBinary } from '../src/main/services/discovery.js';

let binDir: string;
let script: string;
const originalPath = process.env['PATH'];

beforeAll(() => {
  binDir = mkdtempSync(join(tmpdir(), 'tau-gui-bin-'));
  script = join(binDir, 'fake-tau');
  writeFileSync(script, '#!/bin/sh\necho "tau 9.9.9"\n');
  chmodSync(script, 0o755);
  writeFileSync(join(binDir, 'not-executable'), 'nope\n');
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

describe('probeRuntime', () => {
  it('reports the resolved path and version', async () => {
    process.env['PATH'] = binDir;
    const probe = await probeRuntime('tau', 'fake-tau');
    expect(probe).toMatchObject({ resolved: script, version: 'tau 9.9.9', error: null });
  });

  it('explains a missing binary in actionable terms', async () => {
    process.env['PATH'] = binDir;
    const probe = await probeRuntime('pi', 'pi-not-installed');
    expect(probe.resolved).toBeNull();
    expect(probe.error).toContain('was not found on PATH');
    expect(probe.error).toContain('pi');
  });
});
