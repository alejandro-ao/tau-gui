import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/shared/domain.js';
import type { AgentEvent, AppSettings, SessionRef } from '../src/shared/domain.js';
import type { BridgeEvent, PromptQueueItem, PromptQueueSnapshot } from '../src/shared/ipc.js';
import { handleRequest } from '../src/main/ipc.js';
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

  it('drains app-owned steering before follow-ups as fresh prompts after settles', async () => {
    const settings = makeSettings();
    pool = new RuntimePool(settings, () => undefined);
    process.env['FAKE_RUNTIME_DELAY_MS'] = '20';
    try {
      await pool.start();
    } finally {
      delete process.env['FAKE_RUNTIME_DELAY_MS'];
    }
    const target = { runtime: 'tau' as const, sessionId: 'fake-session-1' };
    await pool.active.prompt({ text: 'slow initial' });
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

  it('ignores a delayed duplicate settle after the next queued run starts', async () => {
    const settings = makeSettings();
    pool = new RuntimePool(settings, () => undefined);
    process.env['FAKE_RUNTIME_DELAY_MS'] = '20';
    try {
      await pool.start();
    } finally {
      delete process.env['FAKE_RUNTIME_DELAY_MS'];
    }
    const target = { runtime: 'tau' as const, sessionId: 'fake-session-1' };
    await pool.active.prompt({ text: 'slow initial' });
    await waitFor(() => pool!.snapshot().status === 'running');
    const prompt = vi.spyOn(pool.active, 'prompt');
    pool.enqueuePrompt('follow-up', 'queued first', target);
    pool.enqueuePrompt('follow-up', 'queued second', target);

    await waitFor(async () => {
      const messages = await pool!.active.getMessages();
      return (
        prompt.mock.calls.length === 1 &&
        pool!.snapshot().status === 'running' &&
        messages.some((message) => message.role === 'user' && message.text === 'queued first')
      );
    });

    const internals = pool as unknown as { managers: Set<RuntimeManager> };
    const manager = [...internals.managers][0];
    if (!manager) throw new Error('runtime manager missing');
    const managerInternals = manager as unknown as {
      handleEvent: (event: { type: 'agent_settled' }) => void;
    };
    managerInternals.handleEvent({ type: 'agent_settled' });
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(prompt).toHaveBeenCalledTimes(1);
    expect(pool.snapshot().status).toBe('running');
    expect(pool.queueSnapshot(target).followUp.map((item) => item.text)).toEqual(['queued second']);

    await waitFor(() => prompt.mock.calls.length === 2);
    expect(prompt.mock.calls.map(([request]) => request.text)).toEqual([
      'queued first',
      'queued second',
    ]);
  });

  it('drains exactly one queued prompt after a post-acceptance runtime error', async () => {
    const settings = makeSettings();
    pool = new RuntimePool(settings, () => undefined);
    await pool.start();
    const target = { runtime: 'tau' as const, sessionId: 'fake-session-1' };
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
    pool = new RuntimePool(settings, () => undefined);
    await pool.start();
    const target = { runtime: 'tau' as const, sessionId: 'fake-session-1' };
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
    pool = new RuntimePool(settings, () => undefined);
    process.env['FAKE_RUNTIME_DELAY_MS'] = '30';
    try {
      await pool.start();
    } finally {
      delete process.env['FAKE_RUNTIME_DELAY_MS'];
    }
    const target = { runtime: 'tau' as const, sessionId: 'fake-session-1' };
    await pool.active.prompt({ text: 'slow interrupted' });
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
    pool = new RuntimePool(settings, () => undefined);
    await pool.start();
    const target = { runtime: 'tau' as const, sessionId: 'fake-session-1' };
    const context = { settings, manager: pool, window: () => null };

    // Renderer refreshes create empty queue storage. That storage is state, not
    // authority to keep routing after an ordinary stop removes the live owner.
    expect(
      await handleRequest(context, { action: 'queue.snapshot', session: target }),
    ).toMatchObject({ runtime: 'tau', sessionId: target.sessionId, steering: [], followUp: [] });
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

  it('recovers a retained session queue after the first restart launch fails', async () => {
    const settings = makeSettings();
    pool = new RuntimePool(settings, () => undefined);
    const cwd = fileURLToPath(new URL('.', import.meta.url));
    process.env['FAKE_RUNTIME_DELAY_MS'] = '30';
    try {
      await pool.start({ cwd });
    } finally {
      delete process.env['FAKE_RUNTIME_DELAY_MS'];
    }
    const target = { runtime: 'tau' as const, sessionId: 'fake-session-1' };
    await pool.active.prompt({ text: 'interrupted before failed restart' });
    await waitFor(() => pool!.snapshot().status === 'running');
    pool.enqueuePrompt('follow-up', 'drains after retry', target);

    const internals = pool as unknown as {
      createManager: () => RuntimeManager;
      managers: Set<RuntimeManager>;
    };
    const replaced = [...internals.managers][0]!;
    const createManager = internals.createManager.bind(pool);
    const replacements: RuntimeManager[] = [];
    internals.createManager = () => {
      const manager = createManager();
      replacements.push(manager);
      return manager;
    };
    const runtime = settings.current.runtime;
    settings.update({
      agentRuntime: 'pi',
      runtime: {
        ...runtime,
        tau: { ...runtime.tau, binary: '/definitely/missing/tau-gui-runtime' },
      },
    });

    await expect(pool.restart()).rejects.toThrow('not found');

    expect(replaced.isStarted).toBe(false);
    expect(replacements).toHaveLength(1);
    expect(replacements[0]!.isStarted).toBe(false);
    expect(internals.managers.size).toBe(0);
    expect(pool.snapshot()).toMatchObject({
      runtime: 'tau',
      cwd,
      recoveryTarget: target,
      state: null,
    });

    // Exercise the renderer-facing IPC handlers while there is no manager.
    // Claims retain their stable identity, restores stay in this session, and
    // an accepted edit can be safely enqueued for the same recovery target.
    const context = { settings, manager: pool, window: () => null };
    await handleRequest(context, {
      action: 'agent.steer',
      payload: { text: 'steering after failed restart' },
      session: target,
    });
    const retained = (await handleRequest(context, {
      action: 'queue.snapshot',
      session: target,
    })) as PromptQueueSnapshot;
    expect(retained.steering.map((item) => item.text)).toEqual(['steering after failed restart']);
    expect(retained.followUp.map((item) => item.text)).toEqual(['drains after retry']);
    const firstClaim = (await handleRequest(context, {
      action: 'queue.pop',
      session: target,
    })) as PromptQueueItem | null;
    expect(firstClaim).toMatchObject({ text: 'drains after retry' });
    expect(
      await handleRequest(context, {
        action: 'queue.resolve',
        payload: { id: firstClaim!.id, outcome: 'restore' },
        session: target,
      }),
    ).toBe(true);
    const secondClaim = (await handleRequest(context, {
      action: 'queue.pop',
      session: target,
    })) as PromptQueueItem | null;
    expect(secondClaim?.id).toBe(firstClaim?.id);
    expect(
      await handleRequest(context, {
        action: 'queue.resolve',
        payload: { id: secondClaim!.id, outcome: 'accept' },
        session: target,
      }),
    ).toBe(true);
    await handleRequest(context, {
      action: 'agent.followUp',
      payload: { text: 'edited after failed restart' },
      session: target,
    });
    const edited = (await handleRequest(context, {
      action: 'queue.snapshot',
      session: target,
    })) as PromptQueueSnapshot;
    expect(edited.followUp).toHaveLength(1);
    expect(edited.followUp[0]).toMatchObject({ text: 'edited after failed restart' });
    expect(edited.followUp[0]?.id).not.toBe(firstClaim?.id);
    const alien = { runtime: 'tau' as const, sessionId: 'another-session' };
    await expect(
      handleRequest(context, { action: 'queue.snapshot', session: alien }),
    ).rejects.toThrow('Session is no longer available');
    expect(internals.managers.size).toBe(0);

    settings.update({
      runtime: {
        ...settings.current.runtime,
        tau: { ...runtime.tau, binary: FAKE },
      },
    });
    const restarted = await pool.restart();

    expect(restarted.runtime).toBe('tau');
    expect(restarted.cwd).toBe(cwd);
    expect(restarted.state?.sessionId).toBe(target.sessionId);
    expect(pool.snapshot().recoveryTarget).toBeUndefined();
    expect(replacements).toHaveLength(2);
    expect(internals.managers.has(replacements[0]!)).toBe(false);
    expect(internals.managers.size).toBe(1);
    await waitFor(async () => {
      const messages = await pool!.active.getMessages();
      return messages.some(
        (message) => message.role === 'user' && message.text === 'edited after failed restart',
      );
    });
    expect(pool.queueSnapshot(target).followUp).toEqual([]);
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

  it('opens a picker session without stopping the streaming process', async () => {
    const settings = makeSettings();
    pool = new RuntimePool(settings, () => undefined);
    process.env['FAKE_RUNTIME_DELAY_MS'] = '30';
    try {
      await pool.start();
    } finally {
      delete process.env['FAKE_RUNTIME_DELAY_MS'];
    }
    await pool.active.prompt({ text: 'tool work' });
    await waitFor(() => pool!.snapshot().status === 'running');

    const busy = { runtime: 'tau', sessionId: 'fake-session-1' } as const;
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

  it('restores a streaming session when picker startup fails', async () => {
    const settings = makeSettings();
    const events: BridgeEvent[] = [];
    pool = new RuntimePool(settings, (event) => events.push(event));
    process.env['FAKE_RUNTIME_DELAY_MS'] = '30';
    try {
      await pool.start();
    } finally {
      delete process.env['FAKE_RUNTIME_DELAY_MS'];
    }
    await pool.active.prompt({ text: 'tool work survives rejected picker startup' });
    await waitFor(() => pool!.snapshot().status === 'running');

    const busy = { runtime: 'tau', sessionId: 'fake-session-1' } as const;
    pool.enqueuePrompt('follow-up', 'queued through picker failure', busy);
    const internals = pool as unknown as {
      createManager: () => RuntimeManager;
      managers: Set<RuntimeManager>;
    };
    const createManager = internals.createManager.bind(pool);
    let failed: RuntimeManager | null = null;
    internals.createManager = () => {
      failed = createManager();
      return failed;
    };
    events.length = 0;
    const runtime = settings.current.runtime;
    settings.update({
      runtime: {
        ...runtime,
        tau: { ...runtime.tau, binary: '/definitely/missing/tau-gui-runtime' },
      },
    });

    await expect(pool.openSession('/work/rejected')).rejects.toThrow('not found');

    expect(failed).not.toBeNull();
    expect(failed!.isStarted).toBe(false);
    expect(internals.managers.has(failed!)).toBe(false);
    expect(internals.managers.size).toBe(1);
    expect(pool.snapshot().state?.sessionId).toBe(busy.sessionId);
    expect(pool.active).toBe(pool.runtimeFor(busy));
    expect(
      events.some(
        (event) =>
          event.type === 'status' &&
          event.snapshot.state?.sessionId === busy.sessionId &&
          event.snapshot.status === 'running',
      ),
    ).toBe(true);

    await waitFor(async () => {
      const messages = await pool!.active.getMessages();
      return (
        !(await pool!.active.getState()).isStreaming &&
        messages.some(
          (message) => message.role === 'user' && message.text === 'queued through picker failure',
        )
      );
    });
    const messages = await pool.active.getMessages();
    expect(
      messages.filter((message) => message.role === 'user').map((message) => message.text),
    ).toEqual(['tool work survives rejected picker startup', 'queued through picker failure']);
    expect(
      messages.some((message) => message.role === 'assistant' && message.text.includes('Done')),
    ).toBe(true);
    expect(messages.filter((message) => message.role === 'toolResult')).toHaveLength(3);
  });

  it('replaces an idle process when opening a picker session', async () => {
    const settings = makeSettings();
    pool = new RuntimePool(settings, () => undefined);
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

  it('does not revive an idle process removed before picker startup fails', async () => {
    const settings = makeSettings();
    pool = new RuntimePool(settings, () => undefined);
    await pool.start();
    const internals = pool as unknown as { managers: Set<RuntimeManager> };
    const replaced = [...internals.managers][0]!;
    const runtime = settings.current.runtime;
    settings.update({
      runtime: {
        ...runtime,
        tau: { ...runtime.tau, binary: '/definitely/missing/tau-gui-runtime' },
      },
    });

    await expect(pool.openSession('/work/rejected')).rejects.toThrow('not found');

    expect(replaced.isStarted).toBe(false);
    expect(internals.managers.has(replaced)).toBe(false);
    expect(internals.managers.size).toBe(0);
    expect(pool.snapshot().state).toBeNull();
    expect(() => pool!.active).toThrow('Runtime is not started');
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

  it('relaunches for a new session after the runtime stopped', async () => {
    const settings = makeSettings();
    pool = new RuntimePool(settings, () => undefined);
    await pool.start();
    await pool.stop();
    expect(pool.snapshot().status).toBe('stopped');

    const snapshot = await pool.newSession();

    expect(snapshot.status).toBe('idle');
    expect(snapshot.state?.sessionId).toBe('fake-session-1');
    const internals = pool as unknown as { managers: Set<unknown> };
    expect(internals.managers.size).toBe(1);
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
