import type { ReactNode } from 'react';
import { useStore } from '../state/store.js';
import { formatTokens } from './format.js';

export function StatusRow(): ReactNode {
  const { state, actions } = useStore();
  const { snapshot, agent, stats, settings } = state;
  const cwd = snapshot.cwd ?? settings.cwd;
  const model = agent?.model ?? null;
  const thinking = agent?.thinkingLevel ?? null;
  const context = stats?.contextUsage ?? null;
  const broken = snapshot.status === 'failed' || snapshot.status === 'disconnected';

  return (
    <footer className="status-row" data-state={snapshot.status} data-testid="status-row">
      <div className="status-left">
        {cwd ? <span title={cwd}>{cwd}</span> : null}
        {snapshot.gitBranch ? <span>· {snapshot.gitBranch}</span> : null}
      </div>
      <div className="status-right">
        {broken ? (
          <>
            <span>{snapshot.status === 'failed' ? 'runtime failed' : 'runtime disconnected'}</span>
            <button
              type="button"
              className="ghost-button"
              onClick={() => void actions.start()}
              title="Restart the runtime process"
            >
              restart
            </button>
          </>
        ) : null}
        {model ? (
          <button
            type="button"
            className="status-link"
            title="Pick a model"
            onClick={() => actions.openModal('model')}
          >
            {model.provider}:{model.id}
            {thinking && thinking !== 'off' ? ` (${thinking})` : ''}
          </button>
        ) : null}
        {context ? (
          <button
            type="button"
            className="status-link"
            title="Session details"
            onClick={() => actions.openModal('details')}
          >
            · {formatTokens(context.tokens)}/{formatTokens(context.contextWindow)}
          </button>
        ) : null}
      </div>
    </footer>
  );
}
