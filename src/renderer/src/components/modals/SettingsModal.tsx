import { useEffect, type ReactNode } from 'react';
import { useStore } from '../../state/store.js';
import { Modal } from './Modal.js';

/** GUI-owned settings. Agent/provider settings are owned by embedded Pi. */
export function SettingsModal(): ReactNode {
  const { state, actions } = useStore();
  const settings = state.settings;
  const pi = state.piPreferences;

  useEffect(() => {
    void actions.loadPiPreferences();
  }, [actions]);

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

        <span>providers</span>
        <button
          type="button"
          className="ghost-button"
          onClick={() => {
            void actions.loadProviderAuth();
            actions.openModal('auth');
          }}
        >
          login / logout…
        </button>

        <span>extensions</span>
        <button
          type="button"
          className="ghost-button"
          onClick={() => actions.openModal('extensions')}
        >
          trust and isolation…
        </button>

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

        <span className="settings-directory-label">skill directories</span>
        <div className="settings-resource-directories">
          {settings.customSkillDirectories.map((path) => (
            <div className="settings-resource-directory" key={path}>
              <span className="dim" title={path}>
                {path}
              </span>
              <button
                type="button"
                className="ghost-button"
                aria-label={`Remove skill directory ${path}`}
                onClick={() => void actions.removeResourceDirectory('skills', path)}
              >
                remove
              </button>
            </div>
          ))}
          <button
            type="button"
            className="ghost-button"
            onClick={() => void actions.addResourceDirectory('skills')}
          >
            add…
          </button>
        </div>

        <span className="settings-directory-label">prompt directories</span>
        <div className="settings-resource-directories">
          {settings.customPromptDirectories.map((path) => (
            <div className="settings-resource-directory" key={path}>
              <span className="dim" title={path}>
                {path}
              </span>
              <button
                type="button"
                className="ghost-button"
                aria-label={`Remove prompt directory ${path}`}
                onClick={() => void actions.removeResourceDirectory('prompts', path)}
              >
                remove
              </button>
            </div>
          ))}
          <button
            type="button"
            className="ghost-button"
            onClick={() => void actions.addResourceDirectory('prompts')}
          >
            add…
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

        {pi ? (
          <>
            <label htmlFor="setting-steering-mode">steering delivery</label>
            <select
              id="setting-steering-mode"
              value={pi.steeringMode}
              onChange={(event) =>
                void actions.updatePiPreferences({
                  steeringMode: event.target.value as 'all' | 'one-at-a-time',
                })
              }
            >
              <option value="one-at-a-time">one at a time</option>
              <option value="all">all queued</option>
            </select>

            <label htmlFor="setting-followup-mode">follow-up delivery</label>
            <select
              id="setting-followup-mode"
              value={pi.followUpMode}
              onChange={(event) =>
                void actions.updatePiPreferences({
                  followUpMode: event.target.value as 'all' | 'one-at-a-time',
                })
              }
            >
              <option value="one-at-a-time">one at a time</option>
              <option value="all">all queued</option>
            </select>

            <label htmlFor="setting-transport">provider transport</label>
            <select
              id="setting-transport"
              value={pi.transport}
              onChange={(event) =>
                void actions.updatePiPreferences({
                  transport: event.target.value as typeof pi.transport,
                })
              }
            >
              <option value="auto">auto</option>
              <option value="sse">SSE</option>
              <option value="websocket">WebSocket</option>
              <option value="websocket-cached">WebSocket cached</option>
            </select>

            <label htmlFor="setting-auto-retry">automatic retry</label>
            <div className="settings-inline">
              <input
                id="setting-auto-retry"
                type="checkbox"
                checked={pi.retryEnabled}
                onChange={(event) =>
                  void actions.updatePiPreferences({ retryEnabled: event.target.checked })
                }
              />
              {pi.isRetrying ? (
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => void actions.abortRetry()}
                >
                  cancel attempt {pi.retryAttempt}
                </button>
              ) : null}
            </div>

            <span>retry policy</span>
            <span className="dim">
              {pi.retryMaxRetries} retries · {pi.retryBaseDelayMs}ms base · provider{' '}
              {pi.providerMaxRetries} retries
            </span>

            <label htmlFor="setting-auto-compaction">automatic compaction</label>
            <input
              id="setting-auto-compaction"
              type="checkbox"
              checked={pi.autoCompactionEnabled}
              onChange={(event) =>
                void actions.updatePiPreferences({ autoCompactionEnabled: event.target.checked })
              }
            />

            <span>compaction thresholds</span>
            <span className="dim">
              reserve {pi.compactionReserveTokens} · keep recent {pi.compactionKeepRecentTokens}{' '}
              tokens
            </span>

            <label htmlFor="setting-default-provider">default provider</label>
            <select
              id="setting-default-provider"
              value={pi.defaultProvider ?? ''}
              onChange={(event) =>
                void actions.updatePiPreferences({ defaultProvider: event.target.value })
              }
            >
              <option value="" disabled>
                not set
              </option>
              {[...new Set(state.models.map((model) => model.provider))].map((provider) => (
                <option key={provider} value={provider}>
                  {provider}
                </option>
              ))}
            </select>

            <label htmlFor="setting-default-model">default model</label>
            <select
              id="setting-default-model"
              value={pi.defaultModel ?? ''}
              onChange={(event) =>
                void actions.updatePiPreferences({ defaultModel: event.target.value })
              }
            >
              <option value="" disabled>
                not set
              </option>
              {state.models
                .filter((model) => !pi.defaultProvider || model.provider === pi.defaultProvider)
                .map((model) => (
                  <option key={`${model.provider}:${model.id}`} value={model.id}>
                    {model.id}
                  </option>
                ))}
            </select>
          </>
        ) : null}
      </div>
      <p className="modal-note">
        Pi scans skills and prompts from project-root and home <code>.pi</code>/<code>.agents</code>
        locations. Additional directories are loaded after selection and the active session is
        restarted automatically.
      </p>
      <p className="modal-note">
        Third-party Pi extensions remain disabled until the desktop extension trust and UI contract
        is implemented.
      </p>
    </Modal>
  );
}
