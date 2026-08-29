import { useMemo, type ReactNode } from 'react';
import {
  SESSION_RESUME_UNAVAILABLE_REASON,
  type SessionSummary,
} from '../../../../shared/domain.js';
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
        current: session.sessionId === activeId,
        reason: SESSION_RESUME_UNAVAILABLE_REASON,
        keywords: `${session.name ?? ''} ${session.firstMessage ?? ''} ${session.cwd ?? ''}`,
      })),
    [sessions, activeId],
  );

  return (
    <Picker
      name="session"
      title="Pi sessions"
      subtitle="Metadata-only Pi session catalog — activation is unavailable"
      placeholder="search sessions…"
      items={items}
      emptyLabel="no saved Pi sessions yet"
      onClose={() => actions.openModal(null)}
      rowActions={(item) => {
        const session = sessions.find((candidate) => candidate.id === item.id);
        if (!session?.exportable) return null;
        return (
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
        );
      }}
      onAccept={() =>
        actions.notice(`Session resume is unavailable: ${SESSION_RESUME_UNAVAILABLE_REASON}.`)
      }
    />
  );
}

function describe(session: SessionSummary): string {
  const relationship = session.parentSessionId ? ` · cloned from ${session.parentSessionId}` : '';
  return `${session.cwd ?? 'unknown project'} · ${session.messageCount} messages${relationship}`;
}
