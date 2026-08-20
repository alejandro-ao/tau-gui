import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ensurePrivateDirectory,
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

  it('rejects a symlinked AO user-data root before creating it', () => {
    if (process.platform === 'win32') return;
    const root = mkdtempSync(join(tmpdir(), 'ao-paths-'));
    try {
      const outside = join(root, 'outside');
      const alias = join(root, 'user-data');
      mkdirSync(outside);
      symlinkSync(outside, alias);
      expect(() => ensurePrivateDirectory(alias)).toThrow(/symlink/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a symlinked AO user-data parent before creating children', () => {
    if (process.platform === 'win32') return;
    const root = mkdtempSync(join(tmpdir(), 'ao-paths-'));
    try {
      const outside = join(root, 'outside');
      const alias = join(root, 'alias');
      mkdirSync(outside);
      symlinkSync(outside, alias);
      expect(() => ensurePrivateDirectory(join(alias, 'child'))).toThrow(/symlink/);
      expect(existsSync(join(outside, 'child'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a symlinked legacy settings source without copying its target', () => {
    if (process.platform === 'win32') return;
    const root = mkdtempSync(join(tmpdir(), 'ao-paths-'));
    try {
      const appData = join(root, 'Application Support');
      const oldData = join(appData, 'Tau GUI');
      const newData = join(appData, 'AO');
      const outside = join(root, 'outside-settings.json');
      mkdirSync(oldData, { recursive: true });
      mkdirSync(newData, { recursive: true });
      writeFileSync(outside, '{"outside":true}\n');
      symlinkSync(outside, join(oldData, 'settings.json'));
      expect(migrateLegacySettings(newData, appData)).toBe(false);
      expect(readFileSync(outside, 'utf8')).toContain('outside');
      expect(() => readFileSync(join(newData, 'settings.json'))).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a symlinked destination settings file without following it', () => {
    if (process.platform === 'win32') return;
    const root = mkdtempSync(join(tmpdir(), 'ao-paths-'));
    try {
      const appData = join(root, 'Application Support');
      const oldData = join(appData, 'Tau GUI');
      const newData = join(appData, 'AO');
      const outside = join(root, 'outside-settings.json');
      mkdirSync(oldData, { recursive: true });
      mkdirSync(newData, { recursive: true });
      writeFileSync(join(oldData, 'settings.json'), '{"legacy":true}\n');
      writeFileSync(outside, '{"outside":true}\n');
      symlinkSync(outside, join(newData, 'settings.json'));
      expect(() => migrateLegacySettings(newData, appData)).toThrow(/symlink/);
      expect(readFileSync(outside, 'utf8')).toContain('outside');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('migrates a legacy settings sibling of an overridden user-data path', () => {
    const root = mkdtempSync(join(tmpdir(), 'ao-paths-'));
    try {
      const appData = join(root, 'unrelated-app-data');
      const oldData = join(root, 'Tau GUI');
      const newData = join(root, 'AO');
      mkdirSync(appData, { recursive: true });
      mkdirSync(oldData, { recursive: true });
      mkdirSync(newData, { recursive: true });
      writeFileSync(join(oldData, 'settings.json'), '{"cwd":"/sibling"}\n');
      expect(migrateLegacySettings(newData, appData)).toBe(true);
      expect(readFileSync(join(newData, 'settings.json'), 'utf8')).toContain('/sibling');
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
