import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { Composer } from './components/Composer.js';
import { ConnectionNotice } from './components/ConnectionNotice.js';
import { ModalHost } from './components/modals/ModalHost.js';
import { PromptSlot } from './components/PromptSlot.js';
import { SessionsRail } from './components/SessionsRail.js';
import { Sidebar } from './components/Sidebar.js';
import { StatusRow } from './components/StatusRow.js';
import { Transcript } from './components/Transcript.js';
import { useGlobalKeys } from './hooks/useGlobalKeys.js';
import { useNarrowViewport } from './hooks/useNarrowViewport.js';
import { platform } from './bridge.js';
import { useStore } from './state/store.js';

export function App(): ReactNode {
  const { state, actions } = useStore();
  const narrow = useNarrowViewport(900);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const position = state.settings.sidebarPosition;
  const showThinking = state.settings.showThinking;
  const toggleSidebar = useCallback(() => setDrawerOpen((open) => !open), []);
  useGlobalKeys(
    useMemo(
      () => ({
        openPalette: () => actions.openModal('palette'),
        closeModal: () => actions.openModal(null),
        modalOpen: state.modal !== null,
        toggleExpandAll: actions.toggleExpandAll,
        toggleSidebar,
        cycleModel: () => void actions.cycleModel(),
        cycleThinking: () => void actions.cycleThinking(),
        toggleThinking: () => void actions.updateSettings({ showThinking: !showThinking }),
        newSession: () => void actions.newSession(),
        restart: () => void actions.restart(),
      }),
      [actions, showThinking, state.modal, toggleSidebar],
    ),
  );

  const sidebarVisible = position !== 'off' && (!narrow || drawerOpen);

  return (
    // `data-focused` mirrors the main-process focus signal that gates desktop
    // notifications, so it is observable without inspecting store internals.
    <div
      className="app"
      data-platform={platform()}
      data-sidebar={position}
      data-narrow={narrow}
      data-focused={state.windowFocused}
    >
      {/* With the macOS title bar hidden, this transparent strip is the window
          drag region; it stays invisible so the layout keeps no header. */}
      {platform() === 'darwin' ? <div className="titlebar-drag" aria-hidden="true" /> : null}
      {narrow ? null : <SessionsRail />}
      <main className="main">
        <ConnectionNotice />
        <Transcript />
        <PromptSlot />
        <Composer />
        <StatusRow />
      </main>

      {narrow && position !== 'off' ? (
        <button
          type="button"
          className="ghost-button drawer-toggle"
          onClick={toggleSidebar}
          aria-expanded={drawerOpen}
          aria-controls="session-sidebar"
        >
          {drawerOpen ? 'hide session' : 'session'}
        </button>
      ) : null}

      {sidebarVisible ? <Sidebar id="session-sidebar" /> : null}

      <ModalHost />
    </div>
  );
}
