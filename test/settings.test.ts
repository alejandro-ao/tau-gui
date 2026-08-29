import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mergeSettings, SettingsStore } from '../src/main/services/settings.js';
import { DEFAULT_SETTINGS } from '../src/shared/domain.js';
import { modelKey } from '../src/shared/scoped-models.js';

const file = (): string => join(mkdtempSync(join(tmpdir(), 'tau-gui-settings-')), 'settings.json');

describe('embedded Pi settings', () => {
  it('drops obsolete runtime selectors and migrates the Pi model scope', () => {
    const merged = mergeSettings({
      agentRuntime: 'tau',
      runtime: { tau: { binary: '/bin/sh' }, pi: { binary: '/tmp/pi' } },
      scopedModels: {
        tau: [modelKey({ provider: 'old', modelId: 'tau' })],
        pi: [modelKey({ provider: 'pi', modelId: 'model' })],
      },
    });
    expect(merged).toEqual(
      expect.objectContaining({ scopedModels: [modelKey({ provider: 'pi', modelId: 'model' })] }),
    );
    expect(merged).not.toHaveProperty('agentRuntime');
    expect(merged).not.toHaveProperty('runtime');
  });

  it('persists focused GUI settings and atomic Pi model toggles', () => {
    const path = file();
    const store = new SettingsStore(path);
    store.update({ theme: 'tau-light', cwd: '/work/project' });
    store.toggleScopedModel({ provider: 'fake', modelId: 'one' });
    expect(store.current.scopedModels).toEqual([modelKey({ provider: 'fake', modelId: 'one' })]);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
      theme: 'tau-light',
      cwd: '/work/project',
      scopedModels: [modelKey({ provider: 'fake', modelId: 'one' })],
    });
  });

  it('uses safe defaults for malformed input', () => {
    expect(mergeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(mergeSettings({ theme: 'neon', scopedModels: 'bad' })).toMatchObject({
      theme: 'tau-dark',
      scopedModels: [],
    });
  });
});
