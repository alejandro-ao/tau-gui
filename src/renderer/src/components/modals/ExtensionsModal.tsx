import { useEffect, type ReactNode } from 'react';
import { useStore } from '../../state/store.js';
import { Modal } from './Modal.js';

export function ExtensionsModal(): ReactNode {
  const { state, actions } = useStore();
  useEffect(() => {
    void actions.loadExtensions();
  }, [actions]);

  return (
    <Modal
      name="extensions"
      title="extensions"
      subtitle="metadata and isolation health · third-party execution remains fail-closed"
      onClose={() => actions.openModal(null)}
    >
      <div className="settings-grid" data-testid="extensions-policy">
        <label htmlFor="extensions-user">request user extensions</label>
        <input
          id="extensions-user"
          type="checkbox"
          checked={state.extensionPolicy?.userEnabled ?? false}
          onChange={(event) =>
            void actions.updateExtensionPolicy({ userEnabled: event.target.checked })
          }
        />
        <label htmlFor="extensions-project">request trusted project extensions</label>
        <input
          id="extensions-project"
          type="checkbox"
          checked={state.extensionPolicy?.projectEnabled ?? false}
          onChange={(event) =>
            void actions.updateExtensionPolicy({ projectEnabled: event.target.checked })
          }
        />
        <span>utility host</span>
        <span>
          {state.extensionHost?.status ?? 'unknown'} · {state.extensionHost?.detail ?? 'not probed'}
        </span>
      </div>
      <p className="modal-note extension-blocker">{state.extensionPolicy?.blocker}</p>
      <div className="extension-resource-list">
        {state.extensionResources.map((resource) => (
          <article key={resource.id} className="extension-resource">
            <strong>{resource.name}</strong>
            <span>
              {resource.scope} · {resource.trusted ? 'trusted metadata' : 'untrusted'} · blocked
            </span>
            <small>{resource.reason}</small>
          </article>
        ))}
        {state.extensionResources.length === 0 ? (
          <p className="dim">No extension metadata discovered.</p>
        ) : null}
      </div>
      <p className="modal-note">
        Select/confirm/input/editor dialogs, notifications, statuses, sidebar lines, custom
        messages, and portable tool-render DTOs are bounded by the broker. Terminal-only widgets,
        custom editors, overlays, and key interception deliberately fall back to no-op metadata
        until Pi exposes a serializable extension host API.
      </p>
    </Modal>
  );
}
