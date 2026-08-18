import { describe, expect, it } from 'vitest';
import { DEFAULT_CAPABILITIES } from '../../src/shared/domain.js';
import {
  buildCommands,
  buildPaletteExtras,
} from '../../src/renderer/src/components/modals/commands.js';
import { INITIAL_STATE } from '../../src/renderer/src/state/reducer.js';
import type { Actions } from '../../src/renderer/src/state/store.js';
import type { AppState } from '../../src/renderer/src/state/types.js';

/** Records every action a command handler reaches for. */
function stubActions(): { actions: Actions; calls: string[] } {
  const calls: string[] = [];
  const actions = new Proxy(
    {},
    {
      get: (_target, property) => {
        if (typeof property !== 'string') return undefined;
        return (...args: unknown[]): undefined => {
          calls.push(`${property}:${args.map((value) => String(value)).join(',')}`);
          return undefined;
        };
      },
    },
  ) as Actions;
  return { actions, calls };
}

function stateWith(capabilities: Partial<typeof DEFAULT_CAPABILITIES> = {}): AppState {
  return {
    ...INITIAL_STATE,
    snapshot: {
      ...INITIAL_STATE.snapshot,
      capabilities: { ...DEFAULT_CAPABILITIES, ...capabilities },
    },
  };
}

describe('command registry', () => {
  it('marks /clone unavailable even when the runtime supports cloning', () => {
    const { actions } = stubActions();
    const commands = buildCommands(stateWith({ sessionClone: true }), actions);
    const clone = commands.find((command) => command.id === 'session.clone');
    expect(clone?.unavailable).toBe('clone is not implemented in the desktop app yet');
  });

  it('keeps the runtime capability reason when the runtime cannot clone', () => {
    const { actions } = stubActions();
    const commands = buildCommands(stateWith({ sessionClone: false }), actions);
    const clone = commands.find((command) => command.id === 'session.clone');
    expect(clone?.unavailable).toBe('this runtime cannot clone sessions');
  });

  it('never lets a capability-enabled but unimplemented command silently no-op', () => {
    // Every optional surface reported as supported: nothing may become a no-op.
    const everything = Object.fromEntries(
      Object.keys(DEFAULT_CAPABILITIES).map((key) => [key, true]),
    ) as Partial<typeof DEFAULT_CAPABILITIES>;
    const state = stateWith(everything);

    for (const command of buildCommands(state, stubActions().actions)) {
      const { actions, calls } = stubActions();
      const rebuilt = buildCommands(state, actions).find((entry) => entry.id === command.id);
      expect(rebuilt, command.id).toBeDefined();
      rebuilt?.run();
      // Either the command does real work, or it explains why it cannot.
      expect(calls, `${command.id} did nothing`).not.toHaveLength(0);
      if (calls.some((call) => call.startsWith('notice:'))) {
        expect(rebuilt?.unavailable, `${command.id} notices without a reason`).not.toBeNull();
      }
    }
  });

  it('reports the reason when an unimplemented command is run anyway', () => {
    const state = stateWith({});
    const unimplemented = [
      'session.clone',
      'model.scoped',
      'runtime.tools',
      'runtime.system',
      'runtime.reload',
      'runtime.login',
      'runtime.logout',
    ];
    for (const id of unimplemented) {
      const { actions, calls } = stubActions();
      const command = buildCommands(state, actions).find((entry) => entry.id === id);
      expect(command?.unavailable, id).toBeTruthy();
      command?.run();
      expect(
        calls.some((call) => call.startsWith('notice:')),
        id,
      ).toBe(true);
      expect(calls.join(' ')).toContain(command?.unavailable ?? 'missing reason');
    }
  });

  it('keeps palette extras runnable', () => {
    const state: AppState = {
      ...stateWith({}),
      models: [
        {
          id: 'm1',
          name: 'Model One',
          provider: 'fake',
          api: 'chat',
          reasoning: false,
          input: ['text'],
          contextWindow: 1000,
          maxTokens: 100,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
      thinkingLevels: ['medium'],
    };
    for (const extra of buildPaletteExtras(state, stubActions().actions)) {
      const { actions, calls } = stubActions();
      buildPaletteExtras(state, actions)
        .find((entry) => entry.id === extra.id)
        ?.run();
      expect(calls, `${extra.id} did nothing`).not.toHaveLength(0);
    }
  });
});
