import { useMemo, type ReactNode } from 'react';
import type { SessionRef } from '../../../../shared/domain.js';
import { useStore } from '../../state/store.js';
import { Picker, type PickerItem } from './Picker.js';

/**
 * App-owned recent-session picker.
 *
 * Runtime session files stay runtime-owned: these references come from GUI
 * settings only. Full cross-session listing needs a runtime `list_sessions`
 * command, which is why `capabilities.sessionList` is false.
 */
export function SessionModal(): ReactNode {
  const { state, actions } = useStore();
  const sessions = state.settings.recentSessions;
  const activeId = state.agent?.sessionId ?? null;

  const items = useMemo<PickerItem[]>(
    () =>
      sessions.map((session) => ({
        id: session.id,
        label: session.name ?? session.id,
        hint: new Date(session.lastSeen).toISOString().slice(0, 16).replace('T', ' '),
        detail: describe(session),
        current: session.id === activeId,
        keywords: `${session.runtime} ${session.path ?? ''} ${session.cwd ?? ''}`,
      })),
    [sessions, activeId],
  );

  const subtitle = state.snapshot.capabilities.sessionList
    ? 'sessions reported by the runtime'
    : 'recent sessions remembered by this app — full cross-session listing needs runtime list_sessions support';

  return (
    <Picker
      name="session"
      title="recent sessions"
      subtitle={subtitle}
      placeholder="search recent sessions…"
      items={items}
      emptyLabel="no recent sessions yet"
      onClose={() => actions.openModal(null)}
      rowActions={(item) => (
        <button
          type="button"
          className="ghost-button"
          title="Forget this session reference"
          onClick={(event) => {
            event.stopPropagation();
            void actions.forgetSession(item.id);
          }}
        >
          forget
        </button>
      )}
      onAccept={(item) => {
        const session = sessions.find((candidate) => candidate.id === item.id);
        if (!session) return;
        actions.openModal(null);
        void actions.resumeSession(session);
      }}
    />
  );
}

function describe(session: SessionRef): string {
  return [session.runtime, session.path ?? session.cwd ?? 'unknown location', session.id].join(
    ' · ',
  );
}
