import type { ReactNode } from 'react';
import { useStore } from '../state/store.js';
import { formatRelativeTime } from './format.js';

/**
 * Left rail listing app-owned recent sessions for the current directory.
 * Hidden when the directory has no history; the full cross-directory list
 * lives in the session picker modal.
 */
export function SessionsRail(): ReactNode {
  const { state, actions } = useStore();
  const cwd = state.snapshot.cwd ?? state.settings.cwd;
  const sessions = state.settings.recentSessions.filter(
    (session) => session.cwd !== null && session.cwd === cwd,
  );
  if (!cwd || sessions.length === 0) return null;

  const activeId = state.agent?.sessionId ?? null;

  return (
    <aside
      className="sessions-rail"
      data-testid="sessions-rail"
      aria-label="recent sessions in this directory"
    >
      <h2 className="sessions-rail-title">sessions · {sessions.length}</h2>
      <ul>
        {sessions.map((session) => {
          const label = session.name ?? shortId(session.id);
          return (
            <li key={session.id}>
              <button
                type="button"
                className="sessions-rail-item"
                data-active={session.id === activeId}
                title={session.path ?? session.id}
                onClick={() => void actions.resumeSession(session)}
              >
                <span className="sessions-rail-name">{label}</span>
                <span className="sessions-rail-meta">
                  {session.runtime !== state.settings.agentRuntime ? `${session.runtime} · ` : ''}
                  {formatRelativeTime(session.lastSeen)}
                </span>
              </button>
              <button
                type="button"
                className="sessions-rail-forget"
                aria-label={`forget ${label}`}
                title="remove from recent sessions"
                onClick={() => void actions.forgetSession(session.id)}
              >
                ×
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 12)}…` : id;
}
