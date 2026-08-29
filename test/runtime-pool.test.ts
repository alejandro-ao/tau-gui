import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/shared/domain.js';
import type { AgentEvent, AppSettings, SessionRef } from '../src/shared/domain.js';
import type { BridgeEvent } from '../src/shared/ipc.js';
import { handleRequest } from '../src/main/ipc.js';
import { inspectPhysicalFile } from '../src/main/runtime/session-files.js';
import { FakePiRuntime } from '../src/main/runtime/fake-pi-runtime.js';
import { RuntimePool } from '../src/main/services/runtime-pool.js';
import type { RuntimeManager } from '../src/main/services/runtime-manager.js';
import type { SettingsStore } from '../src/main/services/settings.js';

function makeSettings(): SettingsStore {
  let current: AppSettings = {
    ...DEFAULT_SETTINGS,
    cwd: process.cwd(),
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

function createPool(settings: SettingsStore, broadcast: (event: BridgeEvent) => void): RuntimePool {
  let runtimeNumber = 0;
  return new RuntimePool(settings, broadcast, {
    runtimeFactory: (sink) => new FakePiRuntime(sink, `fake-session-${++runtimeNumber}`),
  });
}

let pool: RuntimePool | null = null;
afterEach(async () => {
  await pool?.stopAll();
  pool = null;
});

describe('RuntimePool', () => {
  it('shares concurrent startup requests without replacing the launched process', async () => {
    const settings = makeSettings();
    pool = createPool(settings, () => undefined);

    const [first, second] = await Promise.all([pool.start(), pool.start()]);

    expect(first.state?.sessionId).toBe('fake-session-1');
    expect(second.state?.sessionId).toBe('fake-session-1');
    const internals = pool as unknown as { managers: Set<unknown> };
    expect(internals.managers.size).toBe(1);
  });

  it('serializes duplicate activation requests onto one session owner', async () => {
    const settings = makeSettings();
    pool = createPool(settings, () => undefined);
    await pool.start();
    settings.rememberSession({
      id: 'other-session',
      name: 'other',
      path: null,
      cwd: process.cwd(),
      runtime: 'pi',
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

  it('serializes session replacement so one owner never clones concurrently', async () => {
    const settings = makeSettings();
    pool = createPool(settings, () => undefined);
    await pool.start();
    const target = { runtime: 'pi' as const, sessionId: 'fake-session-1' };
    const runtime = pool.runtimeFor(target);
    let activeClones = 0;
    let maximum = 0;
    runtime.clone = async () => {
      activeClones += 1;
      maximum = Math.max(maximum, activeClones);
      await new Promise((resolve) => setTimeout(resolve, 10));
      activeClones -= 1;
    };

    await Promise.all([pool.cloneSession(target), pool.cloneSession(target)]);

    expect(maximum).toBe(1);
    expect(pool.snapshot().state?.sessionId).toBe('fake-session-1');
  });

  it('serializes and rejects simultaneous same-owner logical-ID imports', async () => {
    const settings = makeSettings();
    pool = createPool(settings, () => undefined);
    await pool.start();
    const target = { runtime: 'pi' as const, sessionId: 'fake-session-1' };
    const runtime = pool.runtimeFor(target);
    let activeImports = 0;
    let maximum = 0;
    runtime.prepareImport = async () => {
      activeImports += 1;
      maximum = Math.max(maximum, activeImports);
      await new Promise((resolve) => setTimeout(resolve, 10));
      activeImports -= 1;
      return { sessionId: 'fake-session-1', physicalKey: 'prepared-file' };
    };
    runtime.importJsonl = () => Promise.resolve();

    const results = await Promise.allSettled([
      pool.importSession('/first', target),
      pool.importSession('/second', target),
    ]);
    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    expect(maximum).toBe(1);
    expect(pool.snapshot().state?.sessionId).toBe('fake-session-1');
  });

  it('rejects a final import snapshot swapped away from its reserved identity', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tau-import-final-'));
    try {
      const reservedPath = join(root, 'reserved.jsonl');
      const swappedPath = join(root, 'swapped.jsonl');
      writeFileSync(reservedPath, 'reserved');
      writeFileSync(swappedPath, 'swapped');
      const reserved = await inspectPhysicalFile(reservedPath);

      const settings = makeSettings();
      pool = createPool(settings, () => undefined);
      await pool.start();
      const target = { runtime: 'pi' as const, sessionId: 'fake-session-1' };
      const runtime = pool.runtimeFor(target);
      const originalState = await runtime.getState();
      runtime.prepareImport = () =>
        Promise.resolve({ sessionId: 'imported-session', physicalKey: reserved.key });
      runtime.importJsonl = () =>
        Promise.resolve({
          sessionId: 'imported-session',
          physicalKey: reserved.key,
          physicalPath: reserved.path,
        });
      runtime.getState = () =>
        Promise.resolve({
          ...originalState,
          sessionId: 'imported-session',
          sessionFile: swappedPath,
          persisted: true,
        });

      await expect(pool.importSession('/portable', target)).rejects.toThrow(
        'reserved physical identity',
      );
      expect(pool.snapshot()).toMatchObject({ status: 'failed', recoveryTarget: target });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reuses an owner found by prospective logical/physical identity', async () => {
    const settings = makeSettings();
    pool = createPool(settings, () => undefined);
    await pool.start();
    const runtime = pool.active;
    runtime.describeSession = () =>
      Promise.resolve({ sessionId: 'fake-session-1', physicalKey: 'same-file' });

    const snapshot = await pool.activateSession('opaque-catalog-id');
    expect(snapshot.state?.sessionId).toBe('fake-session-1');
    const internals = pool as unknown as { managers: Set<unknown> };
    expect(internals.managers.size).toBe(1);
  });

  it('removes a destructively replaced runtime after recreation failure', async () => {
    const settings = makeSettings();
    const events: BridgeEvent[] = [];
    pool = createPool(settings, (event) => events.push(event));
    await pool.start();
    const target = { runtime: 'pi' as const, sessionId: 'fake-session-1' };
    pool.runtimeFor(target).clone = () => Promise.reject(new Error('rebind failed'));

    await expect(pool.cloneSession(target)).rejects.toThrow('rebind failed');
    expect(pool.snapshot()).toMatchObject({ status: 'failed', recoveryTarget: target });
    expect(() => pool?.runtimeFor(target)).toThrow('Session is no longer available');
    expect(
      events.some((event) => event.type === 'status' && event.snapshot.status === 'failed'),
    ).toBe(true);
  });

  it('keeps an idle session bound to its own runtime process', async () => {
    const settings = makeSettings();
    pool = createPool(settings, () => undefined);
    await pool.start();
    settings.rememberSession({
      id: 'other-session',
      name: 'other',
      path: null,
      cwd: process.cwd(),
      runtime: 'pi',
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
    pool = createPool(settings, (event) => {
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

    void pool.active.prompt({ text: 'tool work' });
    await running;
    settings.rememberSession({
      id: 'other-session',
      name: 'other',
      path: null,
      cwd: process.cwd(),
      runtime: 'pi',
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

  it('drains app-owned steering before follow-ups as fresh prompts after settles', async () => {
    const settings = makeSettings();
    pool = createPool(settings, () => undefined);
    process.env['FAKE_RUNTIME_DELAY_MS'] = '20';
    try {
      await pool.start();
    } finally {
      delete process.env['FAKE_RUNTIME_DELAY_MS'];
    }
    const target = { runtime: 'pi' as const, sessionId: 'fake-session-1' };
    void pool.prompt({ text: 'slow initial' }, target);
    await waitFor(() => pool!.snapshot().status === 'running');
    pool.enqueuePrompt('follow-up', 'follow second', target);
    pool.enqueuePrompt('steering', 'priority first', target);

    await waitFor(async () => {
      const messages = await pool!.active.getMessages();
      return (
        pool!.snapshot().status === 'idle' &&
        messages.filter((message) => message.role === 'user').length === 3
      );
    });
    const messages = await pool.active.getMessages();
    expect(
      messages.filter((message) => message.role === 'user').map((message) => message.text),
    ).toEqual(['slow initial', 'priority first', 'follow second']);
  });

  it('drains exactly one queued prompt after a post-acceptance runtime error', async () => {
    const settings = makeSettings();
    pool = createPool(settings, () => undefined);
    await pool.start();
    const target = { runtime: 'pi' as const, sessionId: 'fake-session-1' };
    const prompt = vi.spyOn(pool.active, 'prompt').mockResolvedValue(undefined);
    const internals = pool as unknown as { managers: Set<RuntimeManager> };
    const manager = [...internals.managers][0]!;
    const emit = (event: AgentEvent): void => {
      (
        manager as unknown as {
          handleEvent: (event: AgentEvent) => void;
        }
      ).handleEvent(event);
    };

    emit({ type: 'agent_start' });
    pool.enqueuePrompt('follow-up', 'follow second', target);
    pool.enqueuePrompt('steering', 'priority first', target);
    emit({ type: 'runtime_error', message: 'provider unavailable (503)' });

    await waitFor(() => prompt.mock.calls.length === 1);
    expect(prompt.mock.calls[0]?.[0].text).toBe('priority first');
    expect(pool.snapshot().status).toBe('idle');
    expect(pool.queueSnapshot(target).followUp.map((item) => item.text)).toEqual(['follow second']);

    // The failed run has no legitimate settle. A delayed duplicate must not
    // drain the second item after the error-triggered handoff.
    emit({ type: 'agent_settled' });
    await Promise.resolve();
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(pool.queueSnapshot(target).followUp.map((item) => item.text)).toEqual(['follow second']);

    emit({ type: 'agent_start' });
    emit({ type: 'turn_start' });
    emit({ type: 'turn_end' });
    emit({ type: 'agent_end', willRetry: false });
    emit({ type: 'agent_settled' });
    await waitFor(() => prompt.mock.calls.length === 2);
    expect(prompt.mock.calls.map(([request]) => request.text)).toEqual([
      'priority first',
      'follow second',
    ]);
  });

  it('retains a failed error-boundary dispatch and ignores errors with no queue', async () => {
    const settings = makeSettings();
    pool = createPool(settings, () => undefined);
    await pool.start();
    const target = { runtime: 'pi' as const, sessionId: 'fake-session-1' };
    const prompt = vi.spyOn(pool.active, 'prompt').mockRejectedValue(new Error('disconnected'));
    const internals = pool as unknown as { managers: Set<RuntimeManager> };
    const manager = [...internals.managers][0]!;
    const emit = (event: AgentEvent): void => {
      (
        manager as unknown as {
          handleEvent: (event: AgentEvent) => void;
        }
      ).handleEvent(event);
    };

    emit({ type: 'agent_start' });
    pool.enqueuePrompt('steering', 'retain on failure', target);
    emit({ type: 'runtime_error', message: 'provider unavailable (503)' });
    await waitFor(() => pool!.queueSnapshot(target).steering.length === 1);
    expect(prompt).toHaveBeenCalledTimes(1);

    emit({ type: 'agent_settled' });
    await Promise.resolve();
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(pool.queueSnapshot(target).steering.map((item) => item.text)).toEqual([
      'retain on failure',
    ]);

    pool.popPrompt(target);
    emit({ type: 'agent_start' });
    emit({ type: 'runtime_error', message: 'another provider error' });
    await Promise.resolve();
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it('retains queued work across a runtime restart of the same session', async () => {
    const settings = makeSettings();
    pool = createPool(settings, () => undefined);
    process.env['FAKE_RUNTIME_DELAY_MS'] = '30';
    try {
      await pool.start();
    } finally {
      delete process.env['FAKE_RUNTIME_DELAY_MS'];
    }
    const target = { runtime: 'pi' as const, sessionId: 'fake-session-1' };
    void pool.active.prompt({ text: 'slow interrupted' });
    await waitFor(() => pool!.snapshot().status === 'running');
    pool.enqueuePrompt('steering', 'survives restart', target);

    await pool.restart();
    await waitFor(async () =>
      (await pool!.active.getMessages()).some(
        (message) => message.role === 'user' && message.text === 'survives restart',
      ),
    );
    expect(pool.snapshot().state?.sessionId).toBe('fake-session-1');
  });

  it('does not let a prior queue snapshot authorize a normally detached session', async () => {
    const settings = makeSettings();
    pool = createPool(settings, () => undefined);
    await pool.start();
    const target = { runtime: 'pi' as const, sessionId: 'fake-session-1' };
    const context = {
      settings,
      manager: pool,
      importRecovery: {
        health: () => Promise.resolve({ retained: 0, capacity: 32 }),
        reveal: () => Promise.resolve(),
      },
      window: () => null,
    };

    // Renderer refreshes create empty queue storage. That storage is state, not
    // authority to keep routing after an ordinary stop removes the live owner.
    expect(
      await handleRequest(context, { action: 'queue.snapshot', session: target }),
    ).toMatchObject({ runtime: 'pi', sessionId: target.sessionId, steering: [], followUp: [] });
    await pool.stop();
    expect(pool.snapshot().recoveryTarget).toBeUndefined();

    const detachedRequests = [
      { action: 'queue.snapshot', session: target },
      { action: 'queue.pop', session: target },
      {
        action: 'queue.resolve',
        payload: { id: 'prompt-from-detached-session', outcome: 'restore' },
        session: target,
      },
      { action: 'agent.steer', payload: { text: 'must not enqueue' }, session: target },
      { action: 'agent.followUp', payload: { text: 'must not enqueue' }, session: target },
    ] as const;
    for (const request of detachedRequests) {
      await expect(handleRequest(context, request)).rejects.toThrow(
        'Session is no longer available: fake-session-1',
      );
    }
  });

  it('routes a session-scoped command to that session, not the selected one', async () => {
    const settings = makeSettings();
    pool = createPool(settings, () => undefined);
    await pool.start();
    settings.rememberSession({
      id: 'other-session',
      name: 'other',
      path: null,
      cwd: process.cwd(),
      runtime: 'pi',
      lastSeen: Date.now(),
    });
    await pool.activateSession('other-session');
    expect(pool.snapshot().state?.sessionId).toBe('other-session');

    const background = { runtime: 'pi', sessionId: 'fake-session-1' } as const;
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
    pool = createPool(settings, () => undefined);
    expect(() => pool!.runtimeFor({ runtime: 'pi', sessionId: 'ghost' })).toThrow(
      'Session is no longer available: ghost',
    );
  });

  it('opens a picker session without stopping the streaming process', async () => {
    const settings = makeSettings();
    pool = createPool(settings, () => undefined);
    process.env['FAKE_RUNTIME_DELAY_MS'] = '30';
    try {
      await pool.start();
    } finally {
      delete process.env['FAKE_RUNTIME_DELAY_MS'];
    }
    void pool.active.prompt({ text: 'tool work' });
    await waitFor(() => pool!.snapshot().status === 'running');

    const busy = { runtime: 'pi', sessionId: 'fake-session-1' } as const;
    const chosen = fileURLToPath(new URL('.', import.meta.url));
    process.env['FAKE_RUNTIME_UNIQUE_SESSION'] = '1';
    try {
      await pool.openSession(chosen);
    } finally {
      delete process.env['FAKE_RUNTIME_UNIQUE_SESSION'];
    }

    const internals = pool as unknown as { managers: Set<unknown> };
    expect(internals.managers.size).toBe(2);
    expect(pool.snapshot().cwd).toBe(chosen);
    expect(pool.snapshot().state?.sessionId).not.toBe('fake-session-1');
    await waitFor(async () => !(await pool!.runtimeFor(busy).getState()).isStreaming);
    const messages = await pool.runtimeFor(busy).getMessages();
    expect(messages.some((message) => message.role === 'assistant')).toBe(true);
    expect(messages.filter((message) => message.role === 'toolResult')).toHaveLength(3);
  });

  it('replaces an idle process when opening a picker session', async () => {
    const settings = makeSettings();
    pool = createPool(settings, () => undefined);
    await pool.start();
    const internals = pool as unknown as { managers: Set<RuntimeManager> };
    const replaced = [...internals.managers][0]!;
    const chosen = fileURLToPath(new URL('.', import.meta.url));

    await pool.openSession(chosen);

    expect(internals.managers.size).toBe(1);
    expect(internals.managers.has(replaced)).toBe(false);
    expect(replaced.isStarted).toBe(false);
    expect(pool.snapshot().cwd).toBe(chosen);
  });

  it('spawns a queued background session without changing the viewed transcript', async () => {
    const settings = makeSettings();
    const events: BridgeEvent[] = [];
    pool = createPool(settings, (event) => events.push(event));
    process.env['FAKE_RUNTIME_UNIQUE_SESSION'] = '1';
    try {
      await pool.start();
      const viewedId = pool.snapshot().state?.sessionId;

      const spawned = await pool.spawnSession({
        cwd: process.cwd(),
        prompt: 'background work',
        name: 'delegated task',
      });

      expect(pool.snapshot().state?.sessionId).toBe(viewedId);
      expect(spawned.sessionId).not.toBe(viewedId);
      expect(spawned.cwd).toBe(process.cwd());
      expect(settings.current.recentSessions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: spawned.sessionId,
            name: 'delegated task',
            runtime: 'pi',
          }),
        ]),
      );

      const target = { runtime: 'pi', sessionId: spawned.sessionId } as const;
      await waitFor(async () => {
        const messages = await pool!.runtimeFor(target).getMessages();
        return messages.some(
          (message) => message.role === 'user' && message.text === 'background work',
        );
      });
      expect(
        events.some(
          (event) =>
            event.type === 'sessionActivity' && event.activity.sessionId === spawned.sessionId,
        ),
      ).toBe(true);
    } finally {
      delete process.env['FAKE_RUNTIME_UNIQUE_SESSION'];
    }
  });

  it('rejects a background session whose working directory does not exist', async () => {
    const settings = makeSettings();
    pool = createPool(settings, () => undefined);
    await pool.start();

    await expect(
      pool.spawnSession({ cwd: '/definitely/missing/tau-gui-cwd', prompt: 'work' }),
    ).rejects.toThrow('does not exist or is not a directory');

    const internals = pool as unknown as { managers: Set<unknown> };
    expect(internals.managers.size).toBe(1);
  });

  it('stops a spawned runtime when cancellation arrives during startup', async () => {
    const settings = makeSettings();
    pool = createPool(settings, () => undefined);
    await pool.start();
    const internals = pool as unknown as {
      createManager: () => RuntimeManager;
      managers: Set<RuntimeManager>;
      spawned: Set<RuntimeManager>;
    };
    const createManager = internals.createManager.bind(pool);
    const children: RuntimeManager[] = [];
    let reportStarted = (): void => undefined;
    let releaseStart = (): void => undefined;
    const started = new Promise<void>((resolve) => {
      reportStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    internals.createManager = () => {
      const manager = createManager();
      children.push(manager);
      const start = manager.start.bind(manager);
      manager.start = async (options) => {
        const snapshot = await start(options);
        reportStarted();
        await release;
        return snapshot;
      };
      return manager;
    };

    const controller = new AbortController();
    const spawning = pool.spawnSession(
      { cwd: process.cwd(), prompt: 'must not run after cancellation' },
      controller.signal,
    );
    const rejection = expect(spawning).rejects.toThrow('Session spawn was cancelled');
    await started;
    controller.abort();
    releaseStart();
    await rejection;

    expect(children[0]?.isStarted).toBe(false);
    expect(internals.managers.size).toBe(1);
    expect(internals.spawned.size).toBe(0);
    expect(
      settings.current.recentSessions.some(
        (session) => session.firstMessage === 'must not run after cancellation',
      ),
    ).toBe(false);
  });

  it('gives a new session its own process while a run is still streaming', async () => {
    const settings = makeSettings();
    pool = createPool(settings, () => undefined);
    process.env['FAKE_RUNTIME_DELAY_MS'] = '30';
    try {
      await pool.start();
    } finally {
      delete process.env['FAKE_RUNTIME_DELAY_MS'];
    }
    void pool.active.prompt({ text: 'slow work' });
    await waitFor(() => pool!.snapshot().status === 'running');

    const busy = { runtime: 'pi', sessionId: 'fake-session-1' } as const;
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
    pool = createPool(settings, () => undefined);
    await pool.start();

    await pool.newSession();

    const internals = pool as unknown as { managers: Set<unknown> };
    expect(internals.managers.size).toBe(1);
    expect(pool.snapshot().state?.sessionId).not.toBe('fake-session-1');
  });

  it('relaunches for a new session after the runtime stopped', async () => {
    const settings = makeSettings();
    pool = createPool(settings, () => undefined);
    await pool.start();
    await pool.stop();
    expect(pool.snapshot().status).toBe('stopped');

    const snapshot = await pool.newSession();

    expect(snapshot.status).toBe('idle');
    expect(snapshot.state?.sessionId).toBe('fake-session-2');
    const internals = pool as unknown as { managers: Set<unknown> };
    expect(internals.managers.size).toBe(1);
  });

  it('blocks direct prompts and defers queued scheduling during a reserved reload', async () => {
    pool = createPool(makeSettings(), () => undefined);
    await pool.start();
    const target = { runtime: 'pi', sessionId: 'fake-session-1' } as const;
    const gate = deferred<void>();
    let entered = false;
    pool.active.reloadResources = async () => {
      entered = true;
      await gate.promise;
      return reloadResult();
    };
    const prompt = vi.spyOn(pool.active, 'prompt').mockResolvedValue(undefined);

    const reload = pool.reloadResources(target);
    await waitFor(() => entered);
    await expect(pool.prompt({ text: 'must not overlap' }, target)).rejects.toThrow(
      'resources are reloading',
    );
    pool.enqueuePrompt('follow-up', 'deferred until reload', target);
    await Promise.resolve();
    expect(prompt).not.toHaveBeenCalled();

    gate.resolve();
    await reload;
    await waitFor(() => prompt.mock.calls.length === 1);
    expect(prompt.mock.calls[0]?.[0].text).toBe('deferred until reload');
  });

  it('does not let settle-triggered scheduling cross a reload reservation', async () => {
    pool = createPool(makeSettings(), () => undefined);
    await pool.start();
    const target = { runtime: 'pi', sessionId: 'fake-session-1' } as const;
    const gate = deferred<void>();
    pool.active.reloadResources = async () => {
      await gate.promise;
      return reloadResult();
    };
    const prompt = vi.spyOn(pool.active, 'prompt').mockResolvedValue(undefined);
    const internals = pool as unknown as {
      managers: Set<RuntimeManager>;
      runLifecycles: Map<RuntimeManager, { phase: string }>;
    };
    const manager = [...internals.managers][0]!;

    const reload = pool.reloadResources(target);
    pool.enqueuePrompt('follow-up', 'settle deferred', target);
    internals.runLifecycles.get(manager)!.phase = 'ended';
    (manager as unknown as { handleEvent: (event: AgentEvent) => void }).handleEvent({
      type: 'agent_settled',
    });
    await Promise.resolve();
    expect(prompt).not.toHaveBeenCalled();

    // Reload owns the manager even if a terminal event updates the run gate.
    internals.runLifecycles.get(manager)!.phase = 'ready';
    gate.resolve();
    await reload;
    await waitFor(() => prompt.mock.calls.length === 1);
  });

  it('releases a failed reload reservation for later direct work', async () => {
    pool = createPool(makeSettings(), () => undefined);
    await pool.start();
    const target = { runtime: 'pi', sessionId: 'fake-session-1' } as const;
    const gate = deferred<void>();
    let entered = false;
    pool.active.reloadResources = async () => {
      entered = true;
      await gate.promise;
      return reloadResult();
    };
    const prompt = vi.spyOn(pool.active, 'prompt').mockResolvedValue(undefined);

    const reload = pool.reloadResources(target);
    const rejection = expect(reload).rejects.toThrow('reload failed');
    await expect(pool.prompt({ text: 'blocked' }, target)).rejects.toThrow(
      'resources are reloading',
    );
    await waitFor(() => entered);
    gate.reject(new Error('reload failed'));
    await rejection;
    await expect(pool.prompt({ text: 'after failure' }, target)).resolves.toBeUndefined();
    expect(prompt).toHaveBeenCalledWith({ text: 'after failure' });
  });

  it('reserves a background target against direct and scheduled work', async () => {
    const settings = makeSettings();
    pool = createPool(settings, () => undefined);
    await pool.start();
    const background = { runtime: 'pi', sessionId: 'fake-session-1' } as const;
    const backgroundRuntime = pool.runtimeFor(background);
    settings.rememberSession({
      id: 'other-session',
      name: 'other',
      path: null,
      cwd: process.cwd(),
      runtime: 'pi',
      lastSeen: Date.now(),
    });
    await pool.activateSession('other-session');
    const gate = deferred<void>();
    backgroundRuntime.reloadResources = async () => {
      await gate.promise;
      return reloadResult();
    };
    const prompt = vi.spyOn(backgroundRuntime, 'prompt').mockResolvedValue(undefined);

    const reload = pool.reloadResources(background);
    await expect(pool.prompt({ text: 'blocked background' }, background)).rejects.toThrow(
      'resources are reloading',
    );
    pool.enqueuePrompt('follow-up', 'background deferred', background);
    await Promise.resolve();
    expect(prompt).not.toHaveBeenCalled();
    expect(pool.snapshot().state?.sessionId).toBe('other-session');

    gate.resolve();
    await reload;
    await waitFor(() => prompt.mock.calls.length === 1);
    expect(prompt.mock.calls[0]?.[0].text).toBe('background deferred');
    expect(pool.snapshot().state?.sessionId).toBe('other-session');
  });

  it('serializes reload with itself and releases the queue after failure', async () => {
    pool = createPool(makeSettings(), () => undefined);
    await pool.start();
    const gates = [deferred<void>(), deferred<void>()];
    let calls = 0;
    pool.active.reloadResources = async () => {
      const gate = gates[calls++];
      await gate?.promise;
      return reloadResult();
    };

    const first = pool.reloadResources();
    const second = pool.reloadResources();
    await waitFor(() => calls === 1);
    gates[0]?.reject(new Error('reload failed'));
    await expect(first).rejects.toThrow('reload failed');
    await waitFor(() => calls === 2);
    gates[1]?.resolve();
    await expect(second).resolves.toEqual(reloadResult());
  });

  it.each(['success', 'failure'] as const)(
    'never releases retained queue work before a queued stop after reload %s',
    async (outcome) => {
      pool = createPool(makeSettings(), () => undefined);
      await pool.start();
      const target = { runtime: 'pi', sessionId: 'fake-session-1' } as const;
      const gate = deferred<void>();
      let reloadEntered = false;
      pool.active.reloadResources = async () => {
        reloadEntered = true;
        await gate.promise;
        return reloadResult();
      };
      const prompt = vi.spyOn(pool.active, 'prompt').mockResolvedValue(undefined);

      const reload = pool.reloadResources(target);
      const observedReload = reload.then(
        () => null,
        (error: Error) => error,
      );
      pool.enqueuePrompt('follow-up', 'must remain stopped', target);
      const stopping = pool.stop();
      await waitFor(() => reloadEntered);
      if (outcome === 'success') gate.resolve();
      else gate.reject(new Error('reload failed'));

      const reloadError = await observedReload;
      expect(reloadError?.message ?? null).toBe(outcome === 'failure' ? 'reload failed' : null);
      await stopping;
      expect(prompt).not.toHaveBeenCalled();
    },
  );

  it.each(['success', 'failure'] as const)(
    'never dispatches an old-session queue before a queued new session after reload %s',
    async (outcome) => {
      pool = createPool(makeSettings(), () => undefined);
      await pool.start();
      const target = { runtime: 'pi', sessionId: 'fake-session-1' } as const;
      const gate = deferred<void>();
      let reloadEntered = false;
      pool.active.reloadResources = async () => {
        reloadEntered = true;
        await gate.promise;
        return reloadResult();
      };
      const prompt = vi.spyOn(pool.active, 'prompt').mockResolvedValue(undefined);

      const reload = pool.reloadResources(target);
      const observedReload = reload.then(
        () => null,
        (error: Error) => error,
      );
      pool.enqueuePrompt('follow-up', 'belongs to prior session', target);
      const opening = pool.newSession(target);
      await waitFor(() => reloadEntered);
      if (outcome === 'success') gate.resolve();
      else gate.reject(new Error('reload failed'));

      const reloadError = await observedReload;
      expect(reloadError?.message ?? null).toBe(outcome === 'failure' ? 'reload failed' : null);
      await opening;
      expect(pool.snapshot().state?.sessionId).not.toBe(target.sessionId);
      expect(prompt).not.toHaveBeenCalled();
    },
  );

  it.each(['success', 'failure'] as const)(
    'waits for a queued switch before handing retained background work off after reload %s',
    async (outcome) => {
      const settings = makeSettings();
      pool = createPool(settings, () => undefined);
      await pool.start();
      const background = { runtime: 'pi', sessionId: 'fake-session-1' } as const;
      const backgroundRuntime = pool.active;
      const reloadGate = deferred<void>();
      const handoffGate = deferred<void>();
      let reloadEntered = false;
      backgroundRuntime.reloadResources = async () => {
        reloadEntered = true;
        await reloadGate.promise;
        return reloadResult();
      };
      const order: string[] = [];
      vi.spyOn(backgroundRuntime, 'prompt').mockImplementation(async () => {
        order.push(`prompt:${pool!.snapshot().state?.sessionId}`);
        await handoffGate.promise;
      });
      settings.rememberSession({
        id: 'other-session',
        name: 'other',
        path: null,
        cwd: process.cwd(),
        runtime: 'pi',
        lastSeen: Date.now(),
      });

      const reload = pool.reloadResources(background);
      const observedReload = reload.then(
        () => null,
        (error: Error) => error,
      );
      pool.enqueuePrompt('follow-up', 'background after switch', background);
      const switching = pool.activateSession('other-session').then(() => order.push('switch'));
      await waitFor(() => reloadEntered);
      if (outcome === 'success') reloadGate.resolve();
      else reloadGate.reject(new Error('reload failed'));

      const reloadError = await observedReload;
      expect(reloadError?.message ?? null).toBe(outcome === 'failure' ? 'reload failed' : null);
      await switching;
      await waitFor(() => order.some((item) => item.startsWith('prompt:')));
      expect(order).toEqual(['prompt:other-session', 'switch']);
      // The switch callback completed before handoff, and its transition
      // promise remains live even while the prompt promise is held.
      expect(pool.snapshot().state?.sessionId).toBe('other-session');
      handoffGate.resolve();
    },
  );

  it.each(['success', 'failure'] as const)(
    're-resolves the replacement before handing retained work off after queued restart and reload %s',
    async (outcome) => {
      pool = createPool(makeSettings(), () => undefined);
      await pool.start();
      const target = { runtime: 'pi', sessionId: 'fake-session-1' } as const;
      const replacedRuntime = pool.active;
      const reloadGate = deferred<void>();
      const handoffGate = deferred<void>();
      let reloadEntered = false;
      replacedRuntime.reloadResources = async () => {
        reloadEntered = true;
        await reloadGate.promise;
        return reloadResult();
      };
      const oldPrompt = vi.spyOn(replacedRuntime, 'prompt').mockResolvedValue(undefined);
      const order: string[] = [];
      const internals = pool as unknown as { createManager: () => RuntimeManager };
      const createManager = internals.createManager.bind(pool);
      internals.createManager = () => {
        const manager = createManager();
        const start = manager.start.bind(manager);
        manager.start = async (options) => {
          const snapshot = await start(options);
          vi.spyOn(manager.active, 'prompt').mockImplementation(async () => {
            order.push('replacement-prompt');
            await handoffGate.promise;
          });
          order.push('replacement-started');
          return snapshot;
        };
        return manager;
      };

      const reload = pool.reloadResources(target);
      const observedReload = reload.then(
        () => null,
        (error: Error) => error,
      );
      pool.enqueuePrompt('follow-up', 'replacement only', target);
      const restarting = pool.restart().then(() => order.push('restart-complete'));
      await waitFor(() => reloadEntered);
      if (outcome === 'success') reloadGate.resolve();
      else reloadGate.reject(new Error('reload failed'));

      const reloadError = await observedReload;
      expect(reloadError?.message ?? null).toBe(outcome === 'failure' ? 'reload failed' : null);
      await restarting;
      await waitFor(() => order.includes('replacement-prompt'));
      expect(oldPrompt).not.toHaveBeenCalled();
      expect(order).toEqual(['replacement-started', 'replacement-prompt', 'restart-complete']);
      handoffGate.resolve();
    },
  );

  it('serializes reload before stop and new-session transitions', async () => {
    pool = createPool(makeSettings(), () => undefined);
    await pool.start();
    const stopGate = deferred<void>();
    pool.active.reloadResources = async () => {
      await stopGate.promise;
      return reloadResult();
    };
    const reload = pool.reloadResources();
    const stopping = pool.stop();
    await Promise.resolve();
    expect(pool.snapshot().status).toBe('idle');
    stopGate.resolve();
    await reload;
    await stopping;
    expect(pool.snapshot().status).toBe('stopped');

    await pool.start();
    const restartedTarget = pool.snapshot().state?.sessionId;
    const newGate = deferred<void>();
    pool.active.reloadResources = async () => {
      await newGate.promise;
      return reloadResult();
    };
    const reloadBeforeNew = pool.reloadResources();
    const opening = pool.newSession();
    await Promise.resolve();
    expect(pool.snapshot().state?.sessionId).toBe(restartedTarget);
    newGate.resolve();
    await reloadBeforeNew;
    await opening;
    expect(pool.snapshot().state?.sessionId).not.toBe(restartedTarget);
  });

  it('serializes reload before switching and targets a background owner exactly', async () => {
    const settings = makeSettings();
    pool = createPool(settings, () => undefined);
    await pool.start();
    const firstTarget = { runtime: 'pi', sessionId: 'fake-session-1' } as const;
    const switchGate = deferred<void>();
    let firstCalls = 0;
    pool.active.reloadResources = async () => {
      firstCalls += 1;
      await switchGate.promise;
      return reloadResult();
    };
    settings.rememberSession({
      id: 'other-session',
      name: 'other',
      path: null,
      cwd: process.cwd(),
      runtime: 'pi',
      lastSeen: Date.now(),
    });
    const reload = pool.reloadResources(firstTarget);
    const switching = pool.activateSession('other-session');
    await Promise.resolve();
    expect(pool.snapshot().state?.sessionId).toBe('fake-session-1');
    switchGate.resolve();
    await reload;
    await switching;
    expect(pool.snapshot().state?.sessionId).toBe('other-session');

    const selected = pool.active;
    await pool.reloadResources(firstTarget);
    expect(firstCalls).toBe(2);
    expect(pool.active).toBe(selected);
  });

  it.each([
    ['agent.abort', { action: 'agent.abort' }, 'abort', undefined],
    [
      'models.set',
      { action: 'models.set', payload: { provider: 'test', modelId: 'model' } },
      'setModel',
      null,
    ],
    ['models.cycle', { action: 'models.cycle' }, 'cycleModel', null],
    [
      'thinking.set',
      { action: 'thinking.set', payload: { level: 'high' } },
      'setThinking',
      undefined,
    ],
    ['thinking.cycle', { action: 'thinking.cycle' }, 'cycleThinking', 'high'],
    [
      'session.name',
      { action: 'session.name', payload: { name: 'gated' } },
      'nameSession',
      undefined,
    ],
    [
      'session.fork',
      { action: 'session.fork', payload: { entryId: 'entry-1', summary: 'none' } },
      'fork',
      {
        editorText: 'text',
        editorTextTruncated: false,
        cancelled: false,
        aborted: false,
      },
    ],
    [
      'session.compact',
      { action: 'session.compact' },
      'compact',
      { summary: '', firstKeptEntryId: null, tokensBefore: 0, estimatedTokensAfter: 0 },
    ],
    [
      'session.autoCompaction',
      { action: 'session.autoCompaction', payload: { enabled: true } },
      'setAutoCompaction',
      undefined,
    ],
    [
      'shell.run',
      { action: 'shell.run', payload: { command: 'pwd', excludeFromContext: false } },
      'runShell',
      {
        command: 'pwd',
        output: '/work',
        exitCode: 0,
        cancelled: false,
        truncated: false,
      },
    ],
    ['shell.abort', { action: 'shell.abort' }, 'abortShell', undefined],
  ] as const)(
    'atomically excludes %s from reload before and after reservation',
    async (_name, request, method, value) => {
      const settings = makeSettings();
      pool = createPool(settings, () => undefined);
      await pool.start();
      const target = { runtime: 'pi', sessionId: 'fake-session-1' } as const;
      const context = {
        settings,
        manager: pool,
        importRecovery: {
          health: () => Promise.resolve({ retained: 0, capacity: 32 as const }),
          reveal: () => Promise.resolve(),
        },
        window: () => null,
      };
      const operationGate = deferred<void>();
      let operationEntered = false;
      const active = pool.active as unknown as Record<string, unknown>;
      active[method] = vi.fn(async () => {
        operationEntered = true;
        await operationGate.promise;
        return value;
      });

      const operation = handleRequest(context, { ...request, session: target });
      await waitFor(() => operationEntered);
      await expect(pool.reloadResources(target)).rejects.toThrow('session mutation is active');
      operationGate.resolve();
      await operation;

      const reloadGate = deferred<void>();
      let reloadEntered = false;
      pool.active.reloadResources = async () => {
        reloadEntered = true;
        await reloadGate.promise;
        return reloadResult();
      };
      const reload = pool.reloadResources(target);
      await waitFor(() => reloadEntered);
      await expect(handleRequest(context, { ...request, session: target })).rejects.toThrow(
        'resources are reloading',
      );
      reloadGate.resolve();
      await reload;
      expect(active[method]).toHaveBeenCalledTimes(1);
    },
  );

  it('releases mutation claims after operation and reload failures', async () => {
    pool = createPool(makeSettings(), () => undefined);
    await pool.start();
    const target = { runtime: 'pi', sessionId: 'fake-session-1' } as const;

    await expect(
      pool.mutateRuntime(target, () => Promise.reject(new Error('mutation failed'))),
    ).rejects.toThrow('mutation failed');
    pool.active.reloadResources = () => Promise.resolve(reloadResult());
    await expect(pool.reloadResources(target)).resolves.toEqual(reloadResult());

    const reloadGate = deferred<void>();
    let reloadEntered = false;
    pool.active.reloadResources = async () => {
      reloadEntered = true;
      await reloadGate.promise;
      throw new Error('reload failed');
    };
    const reload = pool.reloadResources(target);
    const observedReload = reload.catch((error: Error) => error);
    await waitFor(() => reloadEntered);
    reloadGate.resolve();
    await expect(observedReload).resolves.toMatchObject({ message: 'reload failed' });
    await expect(
      pool.mutateRuntime(target, () => Promise.resolve(undefined)),
    ).resolves.toBeUndefined();
  });

  it('gates mutations by exact background manager while allowing classified reads', async () => {
    const settings = makeSettings();
    pool = createPool(settings, () => undefined);
    await pool.start();
    const background = { runtime: 'pi', sessionId: 'fake-session-1' } as const;
    const backgroundRuntime = pool.active;
    settings.rememberSession({
      id: 'other-session',
      name: 'other',
      path: null,
      cwd: process.cwd(),
      runtime: 'pi',
      lastSeen: Date.now(),
    });
    await pool.activateSession('other-session');

    const mutationGate = deferred<void>();
    const mutation = pool.mutateRuntime(background, () => mutationGate.promise);
    await expect(pool.reloadResources(background)).rejects.toThrow('session mutation is active');
    pool.active.reloadResources = () => Promise.resolve(reloadResult());
    await expect(pool.reloadResources()).resolves.toEqual(reloadResult());
    mutationGate.resolve();
    await mutation;

    const reloadGate = deferred<void>();
    let reloadEntered = false;
    backgroundRuntime.reloadResources = async () => {
      reloadEntered = true;
      await reloadGate.promise;
      return reloadResult();
    };
    const reload = pool.reloadResources(background);
    await waitFor(() => reloadEntered);
    await expect(pool.readRuntime(background, (runtime) => runtime.getMessages())).resolves.toEqual(
      expect.any(Array),
    );
    reloadGate.resolve();
    await reload;
  });

  it('rejects reload while the exact target has active work', async () => {
    process.env['FAKE_RUNTIME_DELAY_MS'] = '50';
    pool = createPool(makeSettings(), () => undefined);
    try {
      await pool.start();
    } finally {
      delete process.env['FAKE_RUNTIME_DELAY_MS'];
    }
    void pool.active.prompt({ text: 'slow work' });
    await waitFor(() => pool!.snapshot().status === 'running');
    pool.active.reloadResources = () => Promise.resolve(reloadResult());

    await expect(pool.reloadResources()).rejects.toThrow('agent work is active');
  });
});

function reloadResult() {
  const counts = { skills: 0, prompts: 0, themes: 0, contextFiles: 0, extensions: 0, tools: 0 };
  return { before: counts, after: counts, diagnostics: [] };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitFor(check: () => boolean | Promise<boolean>, timeout = 5_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for runtime pool condition');
}
