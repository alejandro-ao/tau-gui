import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  migrateLegacySettings,
  resolveAppStoragePaths,
  environmentValue,
} from '../src/main/services/app-paths.js';

describe('AO app paths', () => {
  it('prefers AO environment variables over deprecated aliases', () => {
    expect(
      environmentValue(
        { AO_AGENT_DIR: '/ao', TAU_GUI_AGENT_DIR: '/legacy' },
        'AO_AGENT_DIR',
        'TAU_GUI_AGENT_DIR',
      ),
    ).toBe('/ao');
    expect(
      environmentValue({ TAU_GUI_AGENT_DIR: '/legacy' }, 'AO_AGENT_DIR', 'TAU_GUI_AGENT_DIR'),
    ).toBe('/legacy');
  });

  it('keeps Pi agent data and AO session data independent', () => {
    const paths = resolveAppStoragePaths({
      agentDir: '/home/user/.pi/agent',
      home: '/home/user',
      env: { AO_AGENT_DIR: '/tmp/ao-data' },
    });
    expect(paths.agentDir).toBe('/home/user/.pi/agent');
    expect(paths.sessionRoot).toBe('/tmp/ao-data');
    expect(paths.sessionDir).toBe('/tmp/ao-data/sessions');
  });

  it('rejects a symlinked configured AO root', () => {
    if (process.platform === 'win32') return;
    const root = mkdtempSync(join(tmpdir(), 'ao-paths-'));
    try {
      const realRoot = join(root, 'real-agent');
      const alias = join(root, 'configured-agent');
      const piAgent = join(root, 'pi-agent');
      mkdirSync(realRoot, { recursive: true });
      mkdirSync(piAgent, { recursive: true });
      symlinkSync(realRoot, alias);

      expect(() =>
        resolveAppStoragePaths({
          agentDir: piAgent,
          env: { AO_AGENT_DIR: alias },
        }),
      ).toThrow(/symlink/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('migrates old Electron settings without replacing existing AO settings', () => {
    const root = mkdtempSync(join(tmpdir(), 'ao-paths-'));
    try {
      const appData = join(root, 'Application Support');
      const oldData = join(appData, 'Tau GUI');
      const newData = join(appData, 'AO');
      mkdirSync(oldData, { recursive: true });
      mkdirSync(newData, { recursive: true });
      writeFileSync(join(oldData, 'settings.json'), '{"cwd":"/legacy"}\n');
      expect(migrateLegacySettings(newData, appData)).toBe(true);
      expect(readFileSync(join(newData, 'settings.json'), 'utf8')).toContain('/legacy');
      writeFileSync(join(newData, 'settings.json'), '{"cwd":"/new"}\n');
      expect(migrateLegacySettings(newData, appData)).toBe(false);
      expect(readFileSync(join(newData, 'settings.json'), 'utf8')).toContain('/new');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
