import { useCallback, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Composer } from './components/Composer.js';
import { ConnectionNotice } from './components/ConnectionNotice.js';
import { ModalHost } from './components/modals/ModalHost.js';
import { PromptSlot } from './components/PromptSlot.js';
import { SessionsRail } from './components/SessionsRail.js';
import { SessionUsage } from './components/SessionUsage.js';
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
  const [mainView, setMainView] = useState<'conversation' | 'usage'>('conversation');
  const conversationTab = useRef<HTMLButtonElement>(null);
  const usageTab = useRef<HTMLButtonElement>(null);

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
        <nav className="main-tabs" role="tablist" aria-label="Session views">
          <button
            ref={conversationTab}
            type="button"
            role="tab"
            id="tab-conversation"
            aria-controls="panel-conversation"
            aria-selected={mainView === 'conversation'}
            tabIndex={mainView === 'conversation' ? 0 : -1}
            onClick={() => setMainView('conversation')}
            onKeyDown={(event) => selectAdjacentTab(event, 'conversation', setMainView, usageTab)}
          >
            Conversation
          </button>
          <button
            ref={usageTab}
            type="button"
            role="tab"
            id="tab-session-usage"
            aria-controls="panel-session-usage"
            aria-selected={mainView === 'usage'}
            tabIndex={mainView === 'usage' ? 0 : -1}
            onClick={() => setMainView('usage')}
            onKeyDown={(event) => selectAdjacentTab(event, 'usage', setMainView, conversationTab)}
          >
            Session usage
          </button>
        </nav>
        <div
          className="main-panel"
          id="panel-conversation"
          role="tabpanel"
          aria-labelledby="tab-conversation"
          hidden={mainView !== 'conversation'}
        >
          <Transcript />
        </div>
        <div
          className="main-panel"
          id="panel-session-usage"
          role="tabpanel"
          aria-labelledby="tab-session-usage"
          hidden={mainView !== 'usage'}
        >
          <SessionUsage />
        </div>
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

function selectAdjacentTab(
  event: KeyboardEvent<HTMLButtonElement>,
  current: 'conversation' | 'usage',
  select: (view: 'conversation' | 'usage') => void,
  target: { current: HTMLButtonElement | null },
): void {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  event.preventDefault();
  select(current === 'conversation' ? 'usage' : 'conversation');
  target.current?.focus();
}
