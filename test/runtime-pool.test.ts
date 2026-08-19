import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/shared/domain.js';
import type { AppSettings, SessionRef } from '../src/shared/domain.js';
import type { BridgeEvent } from '../src/shared/ipc.js';
import { RuntimePool } from '../src/main/services/runtime-pool.js';
import type { SettingsStore } from '../src/main/services/settings.js';

const FAKE = fileURLToPath(new URL('./fake/fake-runtime.mjs', import.meta.url));

function makeSettings(): SettingsStore {
  let current: AppSettings = {
    ...DEFAULT_SETTINGS,
    cwd: process.cwd(),
    runtime: {
      tau: { binary: FAKE, provider: null, model: null, extraArgs: [] },
      pi: { binary: FAKE, provider: null, model: null, extraArgs: [] },
    },
    recentSessions: [],
  };
  return {
    get current(): AppSettings {
      return current;
    },
    update(patch: Partial<AppSettings>): AppSettings {
      current = { ...current, ...patch };
      return current;
    },
    rememberSession(ref: SessionRef): AppSettings {
      current = {
        ...current,
        recentSessions: [ref, ...current.recentSessions.filter((item) => item.id !== ref.id)],
      };
      return current;
    },
    forgetSession(): AppSettings {
      return current;
    },
  } as unknown as SettingsStore;
}

let pool: RuntimePool | null = null;
afterEach(async () => {
  await pool?.stopAll();
  pool = null;
});

describe('RuntimePool', () => {
  it('shares concurrent startup requests without replacing the launched process', async () => {
    const settings = makeSettings();
    pool = new RuntimePool(settings, () => undefined);

    const [first, second] = await Promise.all([pool.start(), pool.start()]);

    expect(first.state?.sessionId).toBe('fake-session-1');
    expect(second.state?.sessionId).toBe('fake-session-1');
    const internals = pool as unknown as { managers: Set<unknown> };
    expect(internals.managers.size).toBe(1);
  });

  it('keeps an idle session bound to its own runtime process', async () => {
    const settings = makeSettings();
    pool = new RuntimePool(settings, () => undefined);
    await pool.start();
    settings.rememberSession({
      id: 'other-session',
      name: 'other',
      path: null,
      cwd: process.cwd(),
      runtime: 'tau',
      lastSeen: Date.now(),
    });

    await pool.activateSession('other-session');

    expect(pool.snapshot().state?.sessionId).toBe('other-session');
    const internals = pool as unknown as { managers: Set<unknown> };
    expect(internals.managers.size).toBe(2);

    await pool.activateSession('fake-session-1');
    expect(pool.snapshot().state?.sessionId).toBe('fake-session-1');
    expect(internals.managers.size).toBe(2);
  });

  it('keeps one session running while another session is selected', async () => {
    const settings = makeSettings();
    let markRunning: (() => void) | undefined;
    let markResponseReady: (() => void) | undefined;
    const running = new Promise<void>((resolve) => {
      markRunning = resolve;
    });
    const responseReady = new Promise<void>((resolve) => {
      markResponseReady = resolve;
    });
    const activities: BridgeEvent[] = [];
    pool = new RuntimePool(settings, (event) => {
      if (event.type === 'status' && event.snapshot.status === 'running') markRunning?.();
      if (event.type === 'sessionActivity') {
        activities.push(event);
        if (event.activity.responseReady) markResponseReady?.();
      }
    });
    await pool.start();
    const first = pool.snapshot().state?.sessionId;
    expect(first).toBe('fake-session-1');

    await pool.active.prompt({ text: 'slow work' });
    await running;
    settings.rememberSession({
      id: 'other-session',
      name: 'other',
      path: null,
      cwd: process.cwd(),
      runtime: 'tau',
      lastSeen: Date.now(),
    });
    await pool.activateSession('other-session');
    expect(pool.snapshot().state?.sessionId).toBe('other-session');
    await responseReady;
    expect(
      activities.some(
        (event) =>
          event.type === 'sessionActivity' &&
          event.activity.sessionId === first &&
          event.activity.status === 'running',
      ),
    ).toBe(true);
    expect(
      activities.some(
        (event) =>
          event.type === 'sessionActivity' &&
          event.activity.sessionId === first &&
          event.activity.responseReady === true,
      ),
    ).toBe(true);

    const internals = pool as unknown as { managers: Set<unknown> };
    expect(internals.managers.size).toBe(2);

    await pool.activateSession(first!);
    expect(pool.snapshot().state?.sessionId).toBe(first);
    expect((await pool.active.getMessages()).some((message) => message.role === 'assistant')).toBe(
      true,
    );
    expect(internals.managers.size).toBe(2);
  });
});
