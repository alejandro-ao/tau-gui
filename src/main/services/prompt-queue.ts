import type {
  BridgeEvent,
  PromptQueueItem,
  PromptQueueSnapshot,
  SessionTarget,
} from '../../shared/ipc.js';

export type PromptQueueKind = PromptQueueItem['kind'];

interface SessionQueue {
  steering: PromptQueueItem[];
  followUp: PromptQueueItem[];
  dispatching: boolean;
}

/**
 * Application-owned editable prompt queues. Items remain local until a turn
 * settles; claiming removes exactly one item before the asynchronous runtime
 * handoff, so a concurrent pop can never recall an item already being sent.
 */
export class PromptQueueService {
  private readonly sessions = new Map<string, SessionQueue>();
  private nextId = 0;

  constructor(
    private readonly broadcast: (event: BridgeEvent) => void,
    private readonly diagnostic: (message: string) => void,
  ) {}

  enqueue(target: SessionTarget, kind: PromptQueueKind, text: string): PromptQueueItem {
    const queue = this.queue(target);
    const item = { id: `prompt-${++this.nextId}`, kind, text } satisfies PromptQueueItem;
    queue[kind === 'steering' ? 'steering' : 'followUp'].push(item);
    this.emit(target, queue);
    return item;
  }

  snapshot(target: SessionTarget): PromptQueueSnapshot {
    return this.toSnapshot(target, this.queue(target));
  }

  /** Pops newest follow-up first, otherwise newest steering cue. */
  pop(target: SessionTarget): PromptQueueItem | null {
    const queue = this.queue(target);
    const item = queue.followUp.pop() ?? queue.steering.pop() ?? null;
    if (item) this.emit(target, queue);
    return item;
  }

  /**
   * Claims one steering FIFO item, then one follow-up FIFO item. A failed
   * dispatch is reinstated at the front and remains editable for retry/pop.
   */
  async dispatchNext(
    target: SessionTarget,
    dispatch: (text: string) => Promise<void>,
  ): Promise<void> {
    const queue = this.queue(target);
    if (queue.dispatching) return;
    const item = queue.steering.shift() ?? queue.followUp.shift();
    if (!item) return;
    queue.dispatching = true;
    this.emit(target, queue);
    try {
      await dispatch(item.text);
    } catch (error) {
      queue[item.kind === 'steering' ? 'steering' : 'followUp'].unshift(item);
      const message = `Queued ${item.kind} prompt was retained after dispatch failed: ${(error as Error).message}`;
      this.diagnostic(message);
      this.emit(target, queue);
    } finally {
      queue.dispatching = false;
    }
  }

  private queue(target: SessionTarget): SessionQueue {
    const key = `${target.runtime}:${target.sessionId}`;
    let queue = this.sessions.get(key);
    if (!queue) {
      queue = { steering: [], followUp: [], dispatching: false };
      this.sessions.set(key, queue);
    }
    return queue;
  }

  private emit(target: SessionTarget, queue: SessionQueue): void {
    this.broadcast({ type: 'queue', snapshot: this.toSnapshot(target, queue) });
  }

  private toSnapshot(target: SessionTarget, queue: SessionQueue): PromptQueueSnapshot {
    return {
      ...target,
      steering: queue.steering.map((item) => ({ ...item })),
      followUp: queue.followUp.map((item) => ({ ...item })),
    };
  }
}
