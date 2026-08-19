import type {
  BridgeEvent,
  PromptQueueItem,
  PromptQueueSnapshot,
  SessionTarget,
} from '../../shared/ipc.js';

export type PromptQueueKind = PromptQueueItem['kind'];

interface QueueEntry extends PromptQueueItem {
  order: number;
}

interface SessionQueue {
  steering: QueueEntry[];
  followUp: QueueEntry[];
  recalled: Map<string, QueueEntry>;
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
  private nextOrder = 0;

  constructor(
    private readonly broadcast: (event: BridgeEvent) => void,
    private readonly diagnostic: (message: string) => void,
  ) {}

  enqueue(target: SessionTarget, kind: PromptQueueKind, text: string): PromptQueueItem {
    const queue = this.queue(target);
    const entry = {
      id: `prompt-${++this.nextId}`,
      kind,
      text,
      order: ++this.nextOrder,
    } satisfies QueueEntry;
    queue[kind === 'steering' ? 'steering' : 'followUp'].push(entry);
    this.emit(target, queue);
    return this.toItem(entry);
  }

  snapshot(target: SessionTarget): PromptQueueSnapshot {
    return this.toSnapshot(target, this.queue(target));
  }

  /**
   * Claims the newest follow-up first, otherwise newest steering cue. The item
   * remains main-owned until the renderer explicitly accepts or restores it.
   */
  pop(target: SessionTarget): PromptQueueItem | null {
    const queue = this.queue(target);
    const entry = queue.followUp.pop() ?? queue.steering.pop() ?? null;
    if (!entry) return null;
    queue.recalled.set(entry.id, entry);
    this.emit(target, queue);
    return this.toItem(entry);
  }

  /** Resolves one recall claim without relying on text, which may be duplicated. */
  resolveRecall(target: SessionTarget, id: string, outcome: 'accept' | 'restore'): boolean {
    const queue = this.queue(target);
    const entry = queue.recalled.get(id);
    if (!entry) return false;
    queue.recalled.delete(id);
    if (outcome === 'restore') {
      const entries = queue[entry.kind === 'steering' ? 'steering' : 'followUp'];
      const index = entries.findIndex((candidate) => candidate.order > entry.order);
      entries.splice(index < 0 ? entries.length : index, 0, entry);
      this.emit(target, queue);
    }
    return true;
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
    const key = this.key(target);
    let queue = this.sessions.get(key);
    if (!queue) {
      queue = { steering: [], followUp: [], recalled: new Map(), dispatching: false };
      this.sessions.set(key, queue);
    }
    return queue;
  }

  private key(target: SessionTarget): string {
    return `${target.runtime}:${target.sessionId}`;
  }

  private emit(target: SessionTarget, queue: SessionQueue): void {
    this.broadcast({ type: 'queue', snapshot: this.toSnapshot(target, queue) });
  }

  private toSnapshot(target: SessionTarget, queue: SessionQueue): PromptQueueSnapshot {
    return {
      ...target,
      steering: queue.steering.map((item) => this.toItem(item)),
      followUp: queue.followUp.map((item) => this.toItem(item)),
    };
  }

  private toItem({ id, kind, text }: QueueEntry): PromptQueueItem {
    return { id, kind, text };
  }
}
