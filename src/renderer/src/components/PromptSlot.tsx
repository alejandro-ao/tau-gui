import type { ReactNode } from 'react';
import { isRunning } from '../state/reducer.js';
import { useStore } from '../state/store.js';

/**
 * Prompt-adjacent activity slot. This is the only animated run indicator so
 * per-tool markers can stay static.
 */
export function PromptSlot(): ReactNode {
  const { state, actions } = useStore();
  const running = isRunning(state);
  const status = state.snapshot.status;
  const queued = [...state.queue.steering, ...state.queue.followUp];
  const latestQueued = state.queue.followUp.at(-1) ?? state.queue.steering.at(-1);

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
        <section className="queued-messages" aria-label="Queued messages">
          <ol className="queued-message-list">
            {queued.map((entry) => (
              <li
                key={entry.id}
                className="queued-message"
                data-kind={entry.kind}
                data-latest={entry.id === latestQueued?.id}
                title={entry.text}
              >
                <span className="queued-message-preview">{firstLine(entry.text)}</span>
                <span className="queued-message-label">
                  {entry.kind === 'follow-up' ? 'follow up' : 'steering'}
                </span>
                <button
                  type="button"
                  className="queued-message-remove"
                  aria-label={`Remove queued ${entry.kind} prompt`}
                  title="Remove from queue"
                  onClick={() => void actions.removeQueued(entry.id)}
                >
                  ×
                </button>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </div>
  );
}

function firstLine(text: string): string {
  return text.split(/\r?\n/, 1)[0] ?? '';
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
