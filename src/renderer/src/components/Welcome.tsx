import type { ReactNode } from 'react';
import { useStore } from '../state/store.js';
import { versionLabel } from './Sidebar.js';

/**
 * Empty-transcript state for a fresh session. It stays inside the transcript
 * so the composer remains visible and the interaction model is unchanged:
 * the reader can always simply start typing.
 */
export function Welcome(): ReactNode {
  const { state, actions } = useStore();
  const { snapshot, agent, settings } = state;
  const cwd = snapshot.cwd ?? settings.cwd;
  const model = agent?.model ?? null;

  return (
    <section className="welcome" aria-label="New session">
      <p className="welcome-mark" aria-hidden="true">
        <span className="welcome-mark-glyph">τ</span>
        <span className="welcome-mark-rest">{' = 2π'}</span>
      </p>
      <h2 className="welcome-title">New session</h2>
      <ul className="welcome-context">
        {cwd ? (
          <li className="welcome-context-item" title={cwd}>
            {cwd}
          </li>
        ) : null}
        {snapshot.gitBranch ? <li className="welcome-context-item">{snapshot.gitBranch}</li> : null}
        <li className="welcome-context-item">
          {versionLabel(snapshot.runtime, snapshot.runtimeVersion)}
        </li>
      </ul>
      <div className="welcome-actions">
        <button
          type="button"
          className="ghost-button"
          onClick={() => actions.openModal('model')}
          title="Pick a model"
        >
          {model ? `${model.provider}:${model.id}` : 'pick a model'}
        </button>
        <button
          type="button"
          className="ghost-button"
          onClick={() => actions.openModal('skills')}
          title="Browse skills"
        >
          skills
        </button>
        <button
          type="button"
          className="ghost-button"
          onClick={() => actions.openModal('prompts')}
          title="Browse prompts"
        >
          prompts
        </button>
        <button
          type="button"
          className="ghost-button"
          onClick={() => void actions.newSessionFromDirectoryPicker()}
          title="Start a session in another directory"
        >
          change directory
        </button>
      </div>
      <p className="welcome-hint">Type a prompt below to begin.</p>
    </section>
  );
}
