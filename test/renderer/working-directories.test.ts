import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type SessionRef } from '../../src/shared/domain.js';
import { groupSessionsByWorkingDirectory } from '../../src/renderer/src/state/working-directories.js';

const session = (id: string, cwd: string | null, lastSeen: number): SessionRef => ({
  id,
  name: id,
  path: null,
  cwd,
  runtime: 'tau',
  lastSeen,
  messageCount: 1,
});

describe('working directory grouping', () => {
  it('preserves managed directory and recent-session order without cross-group leakage', () => {
    const groups = groupSessionsByWorkingDirectory({
      ...DEFAULT_SETTINGS,
      cwd: '/work/current',
      workingDirectories: ['/work/saved', '/work/current'],
      recentSessions: [
        session('saved-new', '/work/saved', 3),
        session('other', '/work/other', 2),
        session('saved-old', '/work/saved', 1),
        session('unknown', null, 0),
      ],
    });

    expect(groups.map((group) => group.cwd)).toEqual([
      '/work/saved',
      '/work/current',
      '/work/other',
    ]);
    expect(groups.map((group) => group.sessions.map((item) => item.id))).toEqual([
      ['saved-new', 'saved-old'],
      [],
      ['other'],
    ]);
  });
});
