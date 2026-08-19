import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/shared/domain.js';
import type { AppSettings, SessionRef } from '../src/shared/domain.js';
import type { BridgeEvent } from '../src/shared/ipc.js';
import { RuntimePool } from '../src/main/services/runtime-pool.js';
import type { RuntimeManager } from '../src/main/services/runtime-manager.js';
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

  it('serializes duplicate activation requests onto one session owner', async () => {
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

    await Promise.all([
      pool.activateSession('other-session'),
      pool.activateSession('other-session'),
    ]);

    const internals = pool as unknown as { managers: Set<unknown> };
    expect(internals.managers.size).toBe(2);
    expect(pool.snapshot().state?.sessionId).toBe('other-session');
  });

  it('stops a subprocess whose session activation fails', async () => {
    const settings = makeSettings();
    pool = new RuntimePool(settings, () => undefined);
    await pool.start();
    settings.rememberSession({
      id: 'broken-session',
      name: 'broken',
      path: null,
      cwd: process.cwd(),
      runtime: 'tau',
      lastSeen: Date.now(),
    });
    const created: RuntimeManager[] = [];
    const internals = pool as unknown as {
      createManager: () => RuntimeManager;
      managers: Set<RuntimeManager>;
    };
    const createManager = internals.createManager.bind(pool);
    internals.createManager = () => {
      const manager = createManager();
      created.push(manager);
      return manager;
    };

    process.env['FAKE_RUNTIME_SWITCH_ERROR'] = '1';
    try {
      await expect(pool.activateSession('broken-session')).rejects.toThrow('forced switch failure');
    } finally {
      delete process.env['FAKE_RUNTIME_SWITCH_ERROR'];
    }

    expect(created).toHaveLength(1);
    expect(created[0]?.isStarted).toBe(false);
    expect(internals.managers.size).toBe(1);
    expect(pool.snapshot().state?.sessionId).toBe('fake-session-1');
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
    process.env['FAKE_RUNTIME_DELAY_MS'] = '30';
    try {
      await pool.start();
    } finally {
      delete process.env['FAKE_RUNTIME_DELAY_MS'];
    }
    const first = pool.snapshot().state?.sessionId;
    expect(first).toBe('fake-session-1');

    await pool.active.prompt({ text: 'tool work' });
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
    const messages = await pool.active.getMessages();
    expect(
      messages.some((message) => message.role === 'assistant' && message.text.includes('Done')),
    ).toBe(true);
    expect(messages.filter((message) => message.role === 'toolResult')).toHaveLength(3);
    expect((await pool.active.getStats()).toolCalls).toBe(3);
    expect(internals.managers.size).toBe(2);
  });

  it('routes a session-scoped command to that session, not the selected one', async () => {
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

    const background = { runtime: 'tau', sessionId: 'fake-session-1' } as const;
    await pool.runtimeFor(background).prompt({ text: 'hello background' });
    await waitFor(async () => (await pool!.runtimeFor(background).getState()).messageCount > 0);

    // The prompt reached the background transcript and never the selected one.
    const selected = await pool.active.getState();
    expect(selected.sessionId).toBe('other-session');
    expect(selected.messageCount).toBe(0);
    const messages = await pool.runtimeFor(background).getMessages();
    expect(
      messages.some((message) => message.role === 'user' && message.text === 'hello background'),
    ).toBe(true);
  });

  it('refuses a command aimed at a session no runtime owns', () => {
    const settings = makeSettings();
    pool = new RuntimePool(settings, () => undefined);
    expect(() => pool!.runtimeFor({ runtime: 'tau', sessionId: 'ghost' })).toThrow(
      'Session is no longer available: ghost',
    );
  });

  it('gives a new session its own process while a run is still streaming', async () => {
    const settings = makeSettings();
    pool = new RuntimePool(settings, () => undefined);
    process.env['FAKE_RUNTIME_DELAY_MS'] = '30';
    try {
      await pool.start();
    } finally {
      delete process.env['FAKE_RUNTIME_DELAY_MS'];
    }
    await pool.active.prompt({ text: 'slow work' });
    await waitFor(() => pool!.snapshot().status === 'running');

    const busy = { runtime: 'tau', sessionId: 'fake-session-1' } as const;
    process.env['FAKE_RUNTIME_UNIQUE_SESSION'] = '1';
    try {
      await pool.newSession();
    } finally {
      delete process.env['FAKE_RUNTIME_UNIQUE_SESSION'];
    }

    const internals = pool as unknown as { managers: Set<unknown> };
    expect(internals.managers.size).toBe(2);
    // The streaming transcript kept its own process and finishes its turn.
    expect(pool.snapshot().state?.sessionId).not.toBe('fake-session-1');
    await waitFor(async () => !(await pool!.runtimeFor(busy).getState()).isStreaming);
    const messages = await pool.runtimeFor(busy).getMessages();
    expect(messages.some((message) => message.role === 'assistant')).toBe(true);
  });

  it('reuses an idle process for a new session', async () => {
    const settings = makeSettings();
    pool = new RuntimePool(settings, () => undefined);
    await pool.start();

    await pool.newSession();

    const internals = pool as unknown as { managers: Set<unknown> };
    expect(internals.managers.size).toBe(1);
    expect(pool.snapshot().state?.sessionId).not.toBe('fake-session-1');
  });
});

async function waitFor(check: () => boolean | Promise<boolean>, timeout = 5_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for runtime pool condition');
}
