import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { Composer } from './components/Composer.js';
import { ConnectionNotice } from './components/ConnectionNotice.js';
import { PromptSlot } from './components/PromptSlot.js';
import { Sidebar } from './components/Sidebar.js';
import { StatusRow } from './components/StatusRow.js';
import { Transcript } from './components/Transcript.js';
import { useGlobalKeys } from './hooks/useGlobalKeys.js';
import { useNarrowViewport } from './hooks/useNarrowViewport.js';
import { useStore } from './state/store.js';

export function App(): ReactNode {
  const { state, actions } = useStore();
  const narrow = useNarrowViewport(900);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const position = state.settings.sidebarPosition;
  const toggleSidebar = useCallback(() => setDrawerOpen((open) => !open), []);
  useGlobalKeys(
    useMemo(
      () => ({ toggleExpandAll: actions.toggleExpandAll, toggleSidebar }),
      [actions.toggleExpandAll, toggleSidebar],
    ),
  );

  const sidebarVisible = position !== 'off' && (!narrow || drawerOpen);

  return (
    <div className="app" data-sidebar={position} data-narrow={narrow}>
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
    </div>
  );
}
