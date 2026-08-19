import { describe, expect, it, vi } from 'vitest';
import type { BridgeEvent, SessionTarget } from '../src/shared/ipc.js';
import { PromptQueueService } from '../src/main/services/prompt-queue.js';

const alpha: SessionTarget = { runtime: 'tau', sessionId: 'alpha' };
const beta: SessionTarget = { runtime: 'pi', sessionId: 'beta' };

function setup(): {
  queue: PromptQueueService;
  events: BridgeEvent[];
  diagnostics: string[];
} {
  const events: BridgeEvent[] = [];
  const diagnostics: string[] = [];
  return {
    queue: new PromptQueueService(
      (event) => events.push(event),
      (line) => diagnostics.push(line),
    ),
    events,
    diagnostics,
  };
}

describe('PromptQueueService', () => {
  it('uses stable ids for duplicate text and steering FIFO before follow-up FIFO', async () => {
    const { queue } = setup();
    const first = queue.enqueue(alpha, 'steering', 'repeat');
    const second = queue.enqueue(alpha, 'steering', 'repeat');
    queue.enqueue(alpha, 'follow-up', 'later');
    expect(first.id).not.toBe(second.id);

    const dispatched: string[] = [];
    const dispatch = (text: string): Promise<void> => {
      dispatched.push(text);
      return Promise.resolve();
    };
    await queue.dispatchNext(alpha, dispatch);
    await queue.dispatchNext(alpha, dispatch);
    await queue.dispatchNext(alpha, dispatch);
    expect(dispatched).toEqual(['repeat', 'repeat', 'later']);
  });

  it('pops follow-ups LIFO before steering LIFO and isolates sessions', () => {
    const { queue } = setup();
    queue.enqueue(alpha, 'steering', 'steer-1');
    queue.enqueue(alpha, 'steering', 'steer-2');
    queue.enqueue(alpha, 'follow-up', 'follow-1');
    queue.enqueue(alpha, 'follow-up', 'follow-2');
    queue.enqueue(beta, 'follow-up', 'beta-only');

    expect(queue.pop(alpha)?.text).toBe('follow-2');
    expect(queue.pop(alpha)?.text).toBe('follow-1');
    expect(queue.pop(alpha)?.text).toBe('steer-2');
    expect(queue.pop(alpha)?.text).toBe('steer-1');
    expect(queue.pop(alpha)).toBeNull();
    expect(queue.pop(beta)?.text).toBe('beta-only');
  });

  it('atomically claims before dispatch so pop cannot retrieve an in-flight item', async () => {
    const { queue } = setup();
    queue.enqueue(alpha, 'follow-up', 'claimed');
    let release: (() => void) | undefined;
    const pending = queue.dispatchNext(
      alpha,
      () => new Promise<void>((resolve) => (release = resolve)),
    );

    expect(queue.pop(alpha)).toBeNull();
    release?.();
    await pending;
  });

  it('reinstates a failed dispatch at the front and emits a diagnostic', async () => {
    const { queue, diagnostics } = setup();
    const item = queue.enqueue(alpha, 'steering', 'keep me');
    await queue.dispatchNext(alpha, () => Promise.reject(new Error('runtime disconnected')));

    expect(queue.snapshot(alpha).steering).toEqual([item]);
    expect(diagnostics).toEqual([
      'Queued steering prompt was retained after dispatch failed: runtime disconnected',
    ]);
  });

  it('suppresses a second scheduler while dispatch is in flight', async () => {
    const { queue } = setup();
    queue.enqueue(alpha, 'steering', 'one');
    queue.enqueue(alpha, 'steering', 'two');
    const dispatch = vi.fn(() => new Promise<void>(() => undefined));
    void queue.dispatchNext(alpha, dispatch);
    await queue.dispatchNext(alpha, dispatch);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(queue.snapshot(alpha).steering.map((item) => item.text)).toEqual(['two']);
  });
});
