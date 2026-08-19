import type { ReactNode } from 'react';
import { isRunning } from '../state/reducer.js';
import { useStore } from '../state/store.js';

/**
 * Prompt-adjacent activity slot. This is the only animated run indicator so
 * per-tool markers can stay static.
 */
export function PromptSlot(): ReactNode {
  const { state } = useStore();
  const running = isRunning(state);
  const status = state.snapshot.status;
  const queued = [
    ...state.queue.steering.map((text) => ({ kind: 'steering' as const, text })),
    ...state.queue.followUp.map((text) => ({ kind: 'follow-up' as const, text })),
  ];

  return (
    <div className="prompt-slot" data-testid="prompt-slot">
      {state.sessionTransitioning ? null : running ? (
        <span className="activity">
          <span className="activity-dot" aria-hidden="true">
            ●
          </span>
          <span>{activityLabel(status)}</span>
        </span>
      ) : (
        <span className="faint">{status === 'idle' ? 'idle' : status}</span>
      )}
      {queued.map((entry, index) => (
        <span key={`${entry.kind}-${index}`} className="chip" data-kind={entry.kind}>
          {entry.kind}: {entry.text}
        </span>
      ))}
    </div>
  );
}

function activityLabel(status: string): string {
  switch (status) {
    case 'compacting':
      return 'compacting context…';
    case 'retrying':
      return 'retrying…';
    default:
      return 'working…';
  }
}
