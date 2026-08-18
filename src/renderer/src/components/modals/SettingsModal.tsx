import { useState, type ReactNode } from 'react';
import type { RuntimeKind, RuntimeSettings } from '../../../../shared/domain.js';
import { useStore } from '../../state/store.js';
import { Modal } from './Modal.js';

const TRUST_EXPLANATION =
  'Project trust controls ambient resource loading at launch (approve-once maps to --approve, decline-once to --no-approve). It is not a sandbox and does not isolate the runtime from your machine.';

/** GUI-owned settings. Runtime settings are stored per runtime kind. */
export function SettingsModal(): ReactNode {
  const { state, actions } = useStore();
  const settings = state.settings;
  const kind = settings.agentRuntime;
  const runtime = settings.runtime[kind];
  const [extraArgs, setExtraArgs] = useState(runtime.extraArgs.join(' '));

  const patchRuntime = (patch: Partial<RuntimeSettings>): void => {
    const next: Record<RuntimeKind, RuntimeSettings> = {
      ...settings.runtime,
      [kind]: { ...runtime, ...patch },
    };
    void actions.updateSettings({ runtime: next });
  };

  return (
    <Modal
      name="settings"
      title="settings"
      subtitle="stored separately from Tau/Pi TUI configuration"
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
        <label htmlFor="setting-runtime">runtime</label>
        <select
          id="setting-runtime"
          value={kind}
          onChange={(event) => void actions.switchRuntime(event.target.value as RuntimeKind)}
        >
          <option value="tau">tau</option>
          <option value="pi">pi</option>
        </select>

        <label htmlFor="setting-binary">binary</label>
        <input
          id="setting-binary"
          type="text"
          spellCheck={false}
          value={runtime.binary}
          onChange={(event) => patchRuntime({ binary: event.target.value || kind })}
        />

        <label htmlFor="setting-provider">provider</label>
        <input
          id="setting-provider"
          type="text"
          spellCheck={false}
          value={runtime.provider ?? ''}
          placeholder="runtime default"
          onChange={(event) => patchRuntime({ provider: event.target.value || null })}
        />

        <label htmlFor="setting-model">model</label>
        <input
          id="setting-model"
          type="text"
          spellCheck={false}
          value={runtime.model ?? ''}
          placeholder="runtime default"
          onChange={(event) => patchRuntime({ model: event.target.value || null })}
        />

        <label htmlFor="setting-args">extra args</label>
        <input
          id="setting-args"
          type="text"
          spellCheck={false}
          value={extraArgs}
          placeholder="passed to the runtime as an argument array"
          onChange={(event) => setExtraArgs(event.target.value)}
          onBlur={() =>
            patchRuntime({ extraArgs: extraArgs.split(/\s+/).filter((part) => part.length > 0) })
          }
        />

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

        <label htmlFor="setting-trust">project trust</label>
        <select
          id="setting-trust"
          value={settings.projectTrust}
          onChange={(event) => void actions.updateSettings({ projectTrust: event.target.value })}
        >
          <option value="default">default (runtime decides)</option>
          <option value="approve-once">approve-once (--approve)</option>
          <option value="decline-once">decline-once (--no-approve)</option>
        </select>

        <label htmlFor="setting-theme">theme</label>
        <select
          id="setting-theme"
          value={settings.theme}
          onChange={(event) => void actions.updateSettings({ theme: event.target.value })}
        >
          <option value="tau-dark">tau-dark</option>
          <option value="tau-light">tau-light</option>
          <option value="high-contrast">high-contrast</option>
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
      <p className="modal-note">{TRUST_EXPLANATION}</p>
      <p className="modal-note">
        Changing the runtime restarts the agent process. Your composer draft and every GUI setting
        are preserved.
      </p>
    </Modal>
  );
}
