import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/shared/domain.js';
import { recentCatalogId, rendererSettings } from '../src/main/services/session-identity.js';

describe('main-owned legacy session references', () => {
  it('keeps runtime identity while redacting persisted paths from renderer settings', () => {
    const recent = {
      id: 'legacy-id',
      name: 'legacy',
      path: '/outside/legacy.jsonl',
      cwd: '/work',
      runtime: 'pi' as const,
      lastSeen: 1,
    };
    const redacted = rendererSettings({ ...DEFAULT_SETTINGS, recentSessions: [recent] });
    expect(redacted.recentSessions[0]).toMatchObject({
      id: 'legacy-id',
      runtime: 'pi',
      path: null,
    });
    expect(recentCatalogId(recent)).toMatch(/^recent-[a-f0-9]{32}$/);
    expect(recent.path).toBe('/outside/legacy.jsonl');
  });
});
