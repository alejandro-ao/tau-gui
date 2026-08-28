import type { ReactNode } from 'react';
import { useStore } from '../../state/store.js';
import { Modal } from './Modal.js';

const CATEGORIES = ['skills', 'prompts', 'themes', 'contextFiles', 'extensions', 'tools'] as const;

/** Result of Pi's in-place public AgentSession.reload() lifecycle. */
export function ReloadModal(): ReactNode {
  const { state, actions } = useStore();
  const result = state.resourceReload;

  return (
    <Modal
      name="reload"
      title="resources reloaded"
      subtitle="Pi rediscovered active resources; the conversation was not prompted or restarted"
      onClose={() => actions.openModal(null)}
    >
      {result ? (
        <>
          <dl className="detail-list">
            {CATEGORIES.map((category) => (
              <div className="detail-row" key={category}>
                <dt>{category === 'contextFiles' ? 'context files' : category}</dt>
                <dd>
                  {result.before[category]} → {result.after[category]}
                </dd>
              </div>
            ))}
          </dl>
          {result.diagnostics.length === 0 ? (
            <p className="picker-empty">no reload diagnostics</p>
          ) : (
            <ul className="diagnostic-list">
              {result.diagnostics.map((diagnostic, index) => (
                <li key={`${index}-${diagnostic}`}>{diagnostic}</li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <p className="picker-empty">reload result unavailable</p>
      )}
    </Modal>
  );
}
