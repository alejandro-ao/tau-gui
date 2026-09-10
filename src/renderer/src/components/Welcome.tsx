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
  const { snapshot, agent, settings, resources } = state;
  const cwd = snapshot.cwd ?? settings.cwd;
  const model = agent?.model ?? null;

  const starters: { key: string; label: string; detail: string; run: () => void }[] = [
    {
      key: 'model',
      label: 'pick a model',
      detail: model ? `${model.provider}:${model.id}` : 'not selected',
      run: () => actions.openModal('model'),
    },
    {
      key: 'skills',
      label: 'skills',
      detail: `${resources.skills.length} available`,
      run: () => actions.openModal('skills'),
    },
    {
      key: 'prompts',
      label: 'prompts',
      detail: `${resources.prompts.length} available`,
      run: () => actions.openModal('prompts'),
    },
    {
      key: 'directory',
      label: 'change directory',
      detail: 'open another project',
      run: () => void actions.newSessionFromDirectoryPicker(),
    },
  ];

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
        {starters.map((starter) => (
          <button
            key={starter.key}
            type="button"
            className="welcome-action"
            onClick={starter.run}
            title={starter.label}
          >
            <span className="welcome-action-label">{starter.label}</span>
            <span className="welcome-action-detail">{starter.detail}</span>
          </button>
        ))}
      </div>
      <p className="welcome-hint">Type a prompt below to begin.</p>
    </section>
  );
}
