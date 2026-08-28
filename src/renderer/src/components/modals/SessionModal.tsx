import { useMemo, type ReactNode } from 'react';
import type { SessionSummary } from '../../../../shared/domain.js';
import { useStore } from '../../state/store.js';
import { catalogSessions, sessionLabel } from '../../state/working-directories.js';
import { Picker, type PickerItem } from './Picker.js';

/** Pi-native resume picker. Only bounded metadata crosses IPC. */
export function SessionModal(): ReactNode {
  const { state, actions } = useStore();
  const sessions = useMemo(
    () => catalogSessions(state.settings, state.sessions),
    [state.settings, state.sessions],
  );
  const activeId = state.agent?.sessionId ?? null;

  const items = useMemo<PickerItem[]>(
    () =>
      sessions.map((session) => ({
        id: session.id,
        label: sessionLabel(session) ?? session.id,
        hint: new Date(session.modifiedAt).toISOString().slice(0, 16).replace('T', ' '),
        detail: describe(session),
        current: session.id === activeId,
        keywords: `${session.name ?? ''} ${session.firstMessage ?? ''} ${session.cwd ?? ''}`,
      })),
    [sessions, activeId],
  );

  return (
    <Picker
      name="session"
      title="Pi sessions"
      subtitle="Pi-native session catalog — session files remain in the main process"
      placeholder="search sessions…"
      items={items}
      emptyLabel="no saved Pi sessions yet"
      onClose={() => actions.openModal(null)}
      rowActions={(item) => (
        <button
          type="button"
          className="ghost-button"
          title="Export portable Pi JSONL"
          onClick={(event) => {
            event.stopPropagation();
            void actions.exportJsonl(item.id);
          }}
        >
          export
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

function describe(session: SessionSummary): string {
  const relationship = session.parentSessionId ? ` · cloned from ${session.parentSessionId}` : '';
  return `${session.cwd ?? 'unknown project'} · ${session.messageCount} messages${relationship}`;
}
