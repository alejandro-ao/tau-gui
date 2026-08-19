import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mergeSettings, SettingsStore } from '../src/main/services/settings.js';
import { DEFAULT_SETTINGS } from '../src/shared/domain.js';

const tempFile = (): string => join(mkdtempSync(join(tmpdir(), 'tau-gui-')), 'settings.json');

describe('mergeSettings', () => {
  it('falls back to defaults for malformed input', () => {
    expect(mergeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(mergeSettings('nope')).toEqual(DEFAULT_SETTINGS);
    expect(mergeSettings({ theme: 'neon', agentRuntime: 'zeta' })).toMatchObject({
      theme: 'tau-dark',
      agentRuntime: 'tau',
    });
  });

  it('keeps known values and repairs runtime blocks', () => {
    const merged = mergeSettings({
      agentRuntime: 'pi',
      theme: 'high-contrast',
      sidebarPosition: 'left',
      runtime: { pi: { binary: '/usr/local/bin/pi', extraArgs: ['--verbose', 7] } },
      recentSessions: [{ id: 'a', runtime: 'pi' }, { nope: true }],
    });
    expect(merged.agentRuntime).toBe('pi');
    expect(merged.theme).toBe('high-contrast');
    expect(merged.sidebarPosition).toBe('left');
    expect(merged.runtime.pi.binary).toBe('/usr/local/bin/pi');
    expect(merged.runtime.pi.extraArgs).toEqual(['--verbose']);
    expect(merged.runtime.tau.binary).toBe('tau');
    expect(merged.recentSessions).toHaveLength(1);
  });

  it('repairs scoped model lists and keeps runtimes isolated', () => {
    const merged = mergeSettings({
      scopedModels: { tau: ['fake:a', 'fake:a', 7, ''], pi: ['pi:b'], zeta: ['x'] },
    });
    expect(merged.scopedModels).toEqual({ tau: ['fake:a'], pi: ['pi:b'] });
    expect(mergeSettings({ scopedModels: 'nope' }).scopedModels).toEqual({ tau: [], pi: [] });
  });
});

describe('SettingsStore', () => {
  it('persists updates and reloads them', () => {
    const file = tempFile();
    const store = new SettingsStore(file);
    store.update({ theme: 'tau-light', cwd: '/tmp/project' });
    const persisted = JSON.parse(readFileSync(file, 'utf8')) as { theme: string };
    expect(persisted.theme).toBe('tau-light');
    expect(new SettingsStore(file).current).toMatchObject({
      theme: 'tau-light',
      cwd: '/tmp/project',
    });
  });

  it('tracks recent sessions most-recent-first without duplicates', () => {
    const store = new SettingsStore(tempFile());
    store.rememberSession({
      id: 'a',
      name: null,
      path: null,
      cwd: null,
      runtime: 'tau',
      lastSeen: 1,
    });
    store.rememberSession({
      id: 'b',
      name: null,
      path: null,
      cwd: null,
      runtime: 'tau',
      lastSeen: 2,
    });
    store.rememberSession({
      id: 'a',
      name: 'renamed',
      path: null,
      cwd: null,
      runtime: 'tau',
      lastSeen: 3,
    });
    expect(store.current.recentSessions.map((item) => item.id)).toEqual(['a', 'b']);
    expect(store.current.recentSessions[0]?.name).toBe('renamed');
    expect(store.forgetSession('a').recentSessions.map((item) => item.id)).toEqual(['b']);
  });

  it('keeps list order and lastSeen when remembering without a bump', () => {
    const store = new SettingsStore(tempFile());
    store.rememberSession({
      id: 'a',
      name: null,
      path: null,
      cwd: null,
      runtime: 'tau',
      lastSeen: 1,
    });
    store.rememberSession({
      id: 'b',
      name: null,
      path: null,
      cwd: null,
      runtime: 'tau',
      lastSeen: 2,
    });

    // Selecting 'a' again must not reorder it or refresh its timestamp.
    store.rememberSession(
      { id: 'a', name: 'renamed', path: '/tmp/a.jsonl', cwd: null, runtime: 'tau', lastSeen: 3 },
      false,
    );
    expect(store.current.recentSessions.map((item) => item.id)).toEqual(['b', 'a']);
    expect(store.current.recentSessions[1]).toMatchObject({
      name: 'renamed',
      path: '/tmp/a.jsonl',
      lastSeen: 1,
    });

    // Unknown sessions still land on top even without a bump.
    store.rememberSession(
      { id: 'c', name: null, path: null, cwd: null, runtime: 'tau', lastSeen: 4 },
      false,
    );
    expect(store.current.recentSessions.map((item) => item.id)).toEqual(['c', 'b', 'a']);
  });

  it('persists scoped models per runtime without dropping the other runtime', () => {
    const file = tempFile();
    const store = new SettingsStore(file);
    store.update({ scopedModels: { ...store.current.scopedModels, tau: ['fake:a', 'fake:b'] } });
    store.update({ scopedModels: { ...store.current.scopedModels, pi: ['pi:c'] } });
    expect(new SettingsStore(file).current.scopedModels).toEqual({
      tau: ['fake:a', 'fake:b'],
      pi: ['pi:c'],
    });
  });

  it('does not merge unrelated runtime blocks away on partial update', () => {
    const store = new SettingsStore(tempFile());
    store.update({
      runtime: {
        ...store.current.runtime,
        tau: { ...store.current.runtime.tau, binary: '/opt/tau' },
      },
    });
    expect(store.current.runtime.tau.binary).toBe('/opt/tau');
    expect(store.current.runtime.pi.binary).toBe('pi');
  });
});
