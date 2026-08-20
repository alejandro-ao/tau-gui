import type { ReactNode } from 'react';
import { useStore } from '../../state/store.js';
import { Modal } from './Modal.js';

/** GUI-owned settings. Agent/provider settings are owned by embedded Pi. */
export function SettingsModal(): ReactNode {
  const { state, actions } = useStore();
  const settings = state.settings;

  return (
    <Modal
      name="settings"
      title="settings"
      subtitle="desktop preferences · agent engine: embedded Pi"
      onClose={() => actions.openModal(null)}
      footer={
        <button
          type="button"
          className="ghost-button"
          onClick={() => actions.openModal('diagnostics')}
        >
          diagnostics
        </button>
      }
    >
      <div className="settings-grid">
        <span>agent engine</span>
        <span data-testid="embedded-runtime">Pi SDK · bundled with the app</span>

        <label htmlFor="setting-cwd">project</label>
        <div className="settings-inline">
          <span className="dim" title={settings.cwd ?? undefined}>
            {state.snapshot.cwd ?? settings.cwd ?? 'no directory selected'}
          </span>
          <button
            id="setting-cwd"
            type="button"
            className="ghost-button"
            onClick={() => void actions.openDirectory()}
          >
            choose…
          </button>
        </div>

        <label htmlFor="setting-theme">theme</label>
        <select
          id="setting-theme"
          value={settings.theme}
          onChange={(event) => void actions.updateSettings({ theme: event.target.value })}
        >
          <option value="tau-dark">tau-dark</option>
          <option value="tau-light">tau-light</option>
          <option value="high-contrast">high-contrast</option>
          <option value="pure-black">pure-black</option>
        </select>

        <label htmlFor="setting-sidebar">sidebar</label>
        <select
          id="setting-sidebar"
          value={settings.sidebarPosition}
          onChange={(event) => void actions.updateSettings({ sidebarPosition: event.target.value })}
        >
          <option value="right">right</option>
          <option value="left">left</option>
          <option value="off">off</option>
        </select>

        <label htmlFor="setting-notify">notifications</label>
        <select
          id="setting-notify"
          value={settings.turnNotification}
          onChange={(event) =>
            void actions.updateSettings({
              turnNotification: event.target.value,
            })
          }
        >
          <option value="desktop">desktop</option>
          <option value="off">off</option>
        </select>

        <label htmlFor="setting-thinking">show thinking</label>
        <input
          id="setting-thinking"
          type="checkbox"
          checked={settings.showThinking}
          onChange={(event) => void actions.updateSettings({ showThinking: event.target.checked })}
        />
      </div>
      <p className="modal-note">
        Pi runs inside Electron&apos;s main process. Models, credentials, sessions, and resources
        stay outside renderer state.
      </p>
      <p className="modal-note">
        Third-party Pi extensions remain disabled until the desktop extension trust and UI contract
        is implemented.
      </p>
    </Modal>
  );
}
