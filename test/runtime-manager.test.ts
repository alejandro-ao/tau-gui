import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/shared/domain.js';
import type { AgentEvent, AppSettings, SessionRef } from '../src/shared/domain.js';
import type { BridgeEvent } from '../src/shared/ipc.js';
import { RuntimeManager } from '../src/main/services/runtime-manager.js';
import type { SettingsStore } from '../src/main/services/settings.js';

const FAKE = fileURLToPath(new URL('./fake/fake-runtime.mjs', import.meta.url));

/** Minimal in-memory settings double: no disk, no Electron. */
function makeSettings(
  binary: string,
  projectTrust: AppSettings['projectTrust'] = 'default',
): SettingsStore {
  const remembered: SessionRef[] = [];
  let settings: AppSettings = {
    ...DEFAULT_SETTINGS,
    cwd: process.cwd(),
    projectTrust,
    runtime: {
      tau: { binary, provider: null, model: null, extraArgs: [] },
      pi: { binary, provider: null, model: null, extraArgs: [] },
    },
  };
  return {
    get current(): AppSettings {
      return settings;
    },
    update(patch: Partial<AppSettings>): AppSettings {
      settings = { ...settings, ...patch };
      return settings;
    },
    rememberSession(ref: SessionRef): AppSettings {
      remembered.push(ref);
      settings = { ...settings, recentSessions: [ref] };
      return settings;
    },
    forgetSession(): AppSettings {
      return settings;
    },
  } as unknown as SettingsStore;
}

interface Fixture {
  manager: RuntimeManager;
  settings: SettingsStore;
  broadcasts: BridgeEvent[];
  /** Feeds an event through the manager's event handler, as the adapter does. */
  emit: (event: AgentEvent) => void;
  diagnose: (line: string) => void;
}

function makeManager(
  binary = FAKE,
  projectTrust: AppSettings['projectTrust'] = 'default',
): Fixture {
  const broadcasts: BridgeEvent[] = [];
  const settings = makeSettings(binary, projectTrust);
  const manager = new RuntimeManager(settings, (event) => broadcasts.push(event));
  const internals = manager as unknown as {
    handleEvent: (event: AgentEvent) => void;
    addDiagnostic: (line: string) => void;
  };
  return {
    manager,
    settings,
    broadcasts,
    emit: (event) => internals.handleEvent.call(manager, event),
    diagnose: (line) => internals.addDiagnostic.call(manager, line),
  };
}

let active: RuntimeManager | null = null;

afterEach(async () => {
  await active?.stop();
  active = null;
});

describe('RuntimeManager state machine', () => {
  it('becomes idle after start and reports the session state', async () => {
    const fixture = makeManager();
    active = fixture.manager;
    const snapshot = await fixture.manager.start();
    expect(snapshot.status).toBe('idle');
    expect(snapshot.cwd).toBe(process.cwd());
    expect(snapshot.state?.sessionId).toBe('fake-session-1');
    expect(fixture.broadcasts.some((event) => event.type === 'status')).toBe(true);
  });

  it('retains the active process launch trust after settings change', async () => {
    const fixture = makeManager(FAKE, 'approve-once');
    active = fixture.manager;
    await fixture.manager.start();

    fixture.settings.update({ projectTrust: 'decline-once' });

    expect(fixture.settings.current.projectTrust).toBe('decline-once');
    expect(fixture.manager.effectiveProjectTrust).toBe('approve-once');
    await fixture.manager.stop();
    active = null;
    expect(fixture.manager.effectiveProjectTrust).toBeNull();
  });

  it('records the first user message for an unnamed session', async () => {
    const fixture = makeManager();
    active = fixture.manager;
    await fixture.manager.start();

    fixture.emit({
      type: 'message_start',
      message: {
        role: 'user',
        text: 'Investigate the sidebar',
        images: [],
        timestamp: Date.now(),
      },
    });

    const settingsEvent = fixture.broadcasts.findLast((event) => event.type === 'settings');
    expect(
      settingsEvent?.type === 'settings' ? settingsEvent.settings.recentSessions[0] : null,
    ).toMatchObject({
      firstMessage: 'Investigate the sidebar',
      messageCount: 1,
    });
  });

  it('queues a name when Tau has not indexed the empty session yet', async () => {
    const fixture = makeManager();
    active = fixture.manager;
    await fixture.manager.start();
    const nameSession = vi
      .spyOn(fixture.manager.active, 'nameSession')
      .mockRejectedValueOnce(new Error('Unknown session: fake-session-1'))
      .mockResolvedValue(undefined);

    await fixture.manager.nameSession('release prep');

    expect(fixture.manager.snapshot().state?.sessionName).toBe('release prep');
    const settingsEvent = fixture.broadcasts.findLast((event) => event.type === 'settings');
    expect(
      settingsEvent?.type === 'settings' ? settingsEvent.settings.recentSessions[0]?.name : null,
    ).toBe('release prep');

    fixture.emit({ type: 'agent_settled' });
    await vi.waitFor(() => expect(nameSession).toHaveBeenCalledTimes(2));
    expect(nameSession).toHaveBeenLastCalledWith('release prep');
  });

  it('does not hide unrelated naming failures', async () => {
    const fixture = makeManager();
    active = fixture.manager;
    await fixture.manager.start();
    vi.spyOn(fixture.manager.active, 'nameSession').mockRejectedValue(
      new Error('permission denied'),
    );

    await expect(fixture.manager.nameSession('release prep')).rejects.toThrow('permission denied');
  });

  it('publishes an auto-generated name before the first turn settles', async () => {
    const fixture = makeManager();
    active = fixture.manager;
    await fixture.manager.start();
    vi.useFakeTimers();
    try {
      const initial = fixture.manager.snapshot().state;
      if (!initial) throw new Error('agent state missing');
      fixture.manager.active.getState = vi.fn(() =>
        Promise.resolve({
          ...initial,
          sessionName: 'Sidebar investigation',
          messageCount: 1,
        }),
      );

      fixture.emit({ type: 'agent_start' });
      fixture.emit({
        type: 'message_start',
        message: {
          role: 'user',
          text: 'Investigate the sidebar',
          images: [],
          timestamp: Date.now(),
        },
      });
      await vi.advanceTimersByTimeAsync(100);

      const settingsEvent = fixture.broadcasts.findLast((event) => event.type === 'settings');
      expect(
        settingsEvent?.type === 'settings' ? settingsEvent.settings.recentSessions[0]?.name : null,
      ).toBe('Sidebar investigation');
      expect(fixture.manager.snapshot().status).toBe('running');
    } finally {
      vi.useRealTimers();
    }
  });

  it('stays running on agent_end and only settles on agent_settled', async () => {
    const fixture = makeManager();
    active = fixture.manager;
    await fixture.manager.start();

    fixture.emit({ type: 'agent_start' });
    expect(fixture.manager.snapshot().status).toBe('running');

    fixture.emit({ type: 'agent_end', willRetry: false });
    expect(fixture.manager.snapshot().status).toBe('running');

    fixture.emit({ type: 'agent_settled' });
    expect(fixture.manager.snapshot().status).toBe('idle');
  });

  it('tracks compaction and retry, returning to running', async () => {
    const fixture = makeManager();
    active = fixture.manager;
    await fixture.manager.start();
    fixture.emit({ type: 'agent_start' });

    fixture.emit({ type: 'compaction_start', reason: 'overflow' });
    expect(fixture.manager.snapshot().status).toBe('compacting');
    fixture.emit({
      type: 'compaction_end',
      reason: 'overflow',
      aborted: false,
      willRetry: true,
      errorMessage: null,
    });
    expect(fixture.manager.snapshot().status).toBe('running');

    fixture.emit({
      type: 'retry_start',
      attempt: 1,
      maxAttempts: 3,
      delayMs: 0,
      message: 'Context overflow',
    });
    expect(fixture.manager.snapshot()).toMatchObject({
      status: 'retrying',
      detail: 'Context overflow',
    });
    fixture.emit({ type: 'retry_end', success: true, attempt: 1, finalError: null });
    expect(fixture.manager.snapshot().status).toBe('running');

    // A compaction_end without a preceding start must not fabricate `running`.
    fixture.emit({ type: 'agent_end', willRetry: false });
    fixture.emit({ type: 'agent_settled' });
    fixture.emit({
      type: 'compaction_end',
      reason: 'manual',
      aborted: false,
      willRetry: false,
      errorMessage: null,
    });
    expect(fixture.manager.snapshot().status).toBe('idle');
  });

  it('ignores a delayed duplicate settle during a newer active run', async () => {
    const fixture = makeManager();
    active = fixture.manager;
    await fixture.manager.start();

    fixture.emit({ type: 'agent_start' });
    fixture.emit({ type: 'turn_start' });
    fixture.emit({ type: 'agent_settled' });

    expect(fixture.manager.snapshot().status).toBe('running');
  });

  it('clears the running state on runtime_error', async () => {
    const fixture = makeManager();
    active = fixture.manager;
    await fixture.manager.start();
    fixture.emit({ type: 'agent_start' });
    fixture.emit({ type: 'runtime_error', message: 'provider unavailable (503)' });
    const snapshot = fixture.manager.snapshot();
    expect(snapshot.status).not.toBe('running');
    expect(snapshot.status).toBe('idle');
    expect(snapshot.detail).toBe('provider unavailable (503)');
  });

  it('fails with an actionable message when the binary is missing', async () => {
    const fixture = makeManager('tau-gui-missing-runtime-binary');
    active = fixture.manager;
    await expect(fixture.manager.start()).rejects.toThrow(/was not found on PATH/);
    const snapshot = fixture.manager.snapshot();
    expect(snapshot.status).toBe('failed');
    expect(snapshot.detail).toContain('set an absolute binary path');
    expect(fixture.manager.listDiagnostics().at(-1)).toContain('was not found on PATH');
  });

  it('stops back to the stopped state and drops agent state', async () => {
    const fixture = makeManager();
    active = fixture.manager;
    await fixture.manager.start();
    const snapshot = await fixture.manager.stop();
    active = null;
    expect(snapshot.status).toBe('stopped');
    expect(snapshot.state).toBeNull();
    expect(fixture.manager.isStarted).toBe(false);
    expect(() => fixture.manager.active).toThrow('Runtime is not started');
  });

  it('bounds the diagnostics ring', () => {
    const fixture = makeManager();
    for (let index = 0; index < 900; index += 1) fixture.diagnose(`line ${index}`);
    const diagnostics = fixture.manager.listDiagnostics();
    expect(diagnostics).toHaveLength(500);
    expect(diagnostics.at(-1)).toContain('line 899');
    expect(diagnostics.some((line) => line.includes('line 0 '))).toBe(false);
  });
});
