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
        <span className="activity" role="status" aria-label={activityAriaLabel(status)}>
          <CliSpinner />
          {activityLabel(status) ? <span>{activityLabel(status)}</span> : null}
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

const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function CliSpinner(): ReactNode {
  return (
    <span className="activity-spinner" aria-hidden="true">
      {spinnerFrames.map((frame) => (
        <span key={frame} className="activity-spinner-frame">
          {frame}
        </span>
      ))}
    </span>
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
