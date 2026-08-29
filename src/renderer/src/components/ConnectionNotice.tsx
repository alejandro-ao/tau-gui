import type { ReactNode } from 'react';
import type { RuntimeStatus } from '../../../shared/domain.js';
import { useStore } from '../state/store.js';

const TITLES: Partial<Record<RuntimeStatus, string>> = {
  stopped: 'Embedded Pi is not running',
  starting: 'Starting embedded Pi…',
  failed: 'Embedded Pi failed to start',
  disconnected: 'Embedded Pi disconnected',
};

/** Connection state panel; the composer stays usable behind it. */
export function ConnectionNotice(): ReactNode {
  const { state, actions } = useStore();
  const { status, detail } = state.snapshot;
  const title = TITLES[status];
  // Session navigation has its own centered thread loader; this panel is only
  // for runtime lifecycle states outside an in-app thread transition.
  if (state.sessionTransitioning || !title) return null;

  return (
    <section
      className="connection-notice"
      data-state={status}
      data-testid="connection-notice"
      role={status === 'failed' || status === 'disconnected' ? 'alert' : 'status'}
      aria-live="polite"
    >
      <h2>{title}</h2>
      {state.settings.cwd ? <p className="dim">{state.settings.cwd}</p> : null}
      {detail ? <pre>{detail}</pre> : null}
      {status === 'starting' ? null : (
        <div className="connection-actions">
          <button
            type="button"
            className="ghost-button"
            onClick={() => void actions.openDirectory()}
          >
            open directory
          </button>
          <button type="button" className="ghost-button" onClick={() => void actions.start()}>
            restart
          </button>
        </div>
      )}
    </section>
  );
}
