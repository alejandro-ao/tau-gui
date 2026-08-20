import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mergeSettings, SettingsStore } from '../src/main/services/settings.js';
import { DEFAULT_SETTINGS } from '../src/shared/domain.js';
import { requestSchema } from '../src/shared/ipc.js';
import { MAX_SCOPED_MODEL_KEY_LENGTH, modelKey } from '../src/shared/scoped-models.js';

const key = (provider: string, modelId: string): string => modelKey({ provider, modelId });

const tempFile = (): string => join(mkdtempSync(join(tmpdir(), 'tau-gui-')), 'settings.json');

describe('mergeSettings', () => {
  it('falls back to defaults for malformed input', () => {
    const embeddedDefaults = { ...DEFAULT_SETTINGS, agentRuntime: 'pi' as const };
    expect(mergeSettings(null)).toEqual(embeddedDefaults);
    expect(mergeSettings('nope')).toEqual(embeddedDefaults);
    expect(mergeSettings({ theme: 'neon', agentRuntime: 'zeta' })).toMatchObject({
      theme: 'tau-dark',
      agentRuntime: 'pi',
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
    expect(mergeSettings({ theme: 'pure-black' }).theme).toBe('pure-black');
  });

  it('repairs and migrates working directories from current and session metadata', () => {
    const merged = mergeSettings({
      cwd: '/work/current',
      workingDirectories: ['/work/saved', '/work/saved', 7, ''],
      recentSessions: [
        { id: 'a', runtime: 'tau', cwd: '/work/older' },
        { id: 'b', runtime: 'tau', cwd: '/work/saved' },
      ],
    });
    expect(merged.workingDirectories).toEqual(['/work/saved', '/work/current', '/work/older']);
  });

  it('repairs scoped model lists and keeps runtimes isolated', () => {
    const merged = mergeSettings({
      scopedModels: { tau: ['fake:a', 'fake:a', 7, ''], pi: ['pi:b'], zeta: ['x'] },
    });
    expect(merged.scopedModels).toEqual({ tau: [key('fake', 'a')], pi: [key('pi', 'b')] });
    expect(mergeSettings({ scopedModels: 'nope' }).scopedModels).toEqual({ tau: [], pi: [] });
  });

  it('repairs scoped keys to the exact IPC invariant and round-trips them', () => {
    const overlong = `provider:${'m'.repeat(MAX_SCOPED_MODEL_KEY_LENGTH)}`;
    const merged = mergeSettings({ scopedModels: { tau: ['fake:a', overlong], pi: [] } });
    expect(merged.scopedModels.tau).toEqual([key('fake', 'a')]);
    expect(
      requestSchema.safeParse({
        action: 'settings.update',
        payload: { scopedModels: merged.scopedModels },
      }).success,
    ).toBe(true);
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

  it('atomically persists chooser-selected working directories', () => {
    const file = tempFile();
    const store = new SettingsStore(file);
    store.rememberWorkingDirectory('/work/one');
    store.rememberWorkingDirectory('/work/two');
    store.rememberWorkingDirectory('/work/one');
    expect(store.current.cwd).toBe('/work/one');
    expect(store.current.workingDirectories).toEqual(['/work/one', '/work/two']);
    expect(new SettingsStore(file).current.workingDirectories).toEqual(['/work/one', '/work/two']);
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
    store.update({
      scopedModels: { ...store.current.scopedModels, tau: [key('fake', 'a'), key('fake', 'b')] },
    });
    store.update({ scopedModels: { ...store.current.scopedModels, pi: [key('pi', 'c')] } });
    expect(new SettingsStore(file).current.scopedModels).toEqual({
      tau: [key('fake', 'a'), key('fake', 'b')],
      pi: [key('pi', 'c')],
    });
  });

  it('atomically persists two distinct scoped toggles against current settings', () => {
    const store = new SettingsStore(tempFile());
    store.toggleScopedModel('tau', { provider: 'a:b', modelId: 'c' });
    store.toggleScopedModel('tau', { provider: 'a', modelId: 'b:c' });
    expect(store.current.scopedModels.tau).toEqual([key('a:b', 'c'), key('a', 'b:c')]);
    expect(store.current.runtime.tau.model).toBeNull();
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
