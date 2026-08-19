import type { ReactNode } from 'react';
import type { RuntimeStatus } from '../../../shared/domain.js';
import { useStore } from '../state/store.js';

const TITLES: Partial<Record<RuntimeStatus, string>> = {
  stopped: 'Runtime not running',
  starting: 'Starting runtime…',
  failed: 'Runtime failed to start',
  disconnected: 'Runtime disconnected',
};

/** Connection state panel; the composer stays usable behind it. */
export function ConnectionNotice(): ReactNode {
  const { state, actions } = useStore();
  const { status, detail, runtime } = state.snapshot;
  const title = TITLES[status];
  // Session navigation has its own centered thread loader; this panel is only
  // for runtime lifecycle states outside an in-app thread transition.
  if (state.sessionTransitioning || !title) return null;

  return (
    <section className="connection-notice" data-state={status} data-testid="connection-notice">
      <h2>{title}</h2>
      <p className="dim">
        runtime: {runtime}
        {state.settings.cwd ? ` · ${state.settings.cwd}` : ''}
      </p>
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
