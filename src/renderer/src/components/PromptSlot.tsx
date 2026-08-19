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
        activityLabel(status) ? (
          <span className="activity" role="status" aria-label={activityAriaLabel(status)}>
            {activityLabel(status)}
          </span>
        ) : null
      ) : (
        <span className="faint">{status === 'idle' ? 'idle' : status}</span>
      )}
      {queued.length > 0 ? (
        <div className="queued-messages" aria-label="Queued messages">
          {queued.map((entry, index) => (
            <div key={`${entry.kind}-${index}`} className="queued-message" data-kind={entry.kind}>
              {entry.kind}: {entry.text}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function activityAriaLabel(status: string): string {
  switch (status) {
    case 'compacting':
      return 'Compacting context';
    case 'retrying':
      return 'Retrying';
    default:
      return 'Model working';
  }
}

function activityLabel(status: string): string | null {
  switch (status) {
    case 'compacting':
      return 'compacting context…';
    case 'retrying':
      return 'retrying…';
    default:
      return null;
  }
}
