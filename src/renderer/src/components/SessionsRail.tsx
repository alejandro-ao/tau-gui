import { useCallback, useEffect, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useStore } from '../state/store.js';
import { formatRelativeTime } from './format.js';

/**
 * Resizable left rail listing app-owned recent sessions for the current directory.
 * The full cross-directory list lives in the session picker modal.
 */
export function SessionsRail(): ReactNode {
  const { state, actions } = useStore();
  const [width, setWidth] = useState(200);
  const [resizing, setResizing] = useState(false);
  const [pendingSessionId, setPendingSessionId] = useState<string | null>(null);
  const cwd = state.snapshot.cwd ?? state.settings.cwd;
  const sessions = state.settings.recentSessions.filter(
    (session) =>
      session.cwd !== null &&
      session.cwd === cwd &&
      session.messageCount !== 0 &&
      sessionLabel(session) !== null,
  );
  const activeId = pendingSessionId ?? state.agent?.sessionId ?? null;
  const resize = useCallback((nextWidth: number) => {
    const maximum = Math.min(420, Math.max(160, window.innerWidth * 0.45));
    setWidth(Math.round(Math.min(maximum, Math.max(160, nextWidth))));
  }, []);

  useEffect(() => {
    if (!resizing) return;
    const move = (event: MouseEvent): void => {
      event.preventDefault();
      resize(event.clientX);
    };
    const stop = (): void => setResizing(false);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', stop, { once: true });
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', stop);
    };
  }, [resize, resizing]);

  const resizeWithKeyboard = (event: KeyboardEvent<HTMLDivElement>): void => {
    let nextWidth: number | null = null;
    if (event.key === 'ArrowLeft') nextWidth = width - 16;
    if (event.key === 'ArrowRight') nextWidth = width + 16;
    if (event.key === 'Home') nextWidth = 160;
    if (event.key === 'End') nextWidth = 420;
    if (nextWidth === null) return;
    event.preventDefault();
    resize(nextWidth);
  };

  return (
    <aside
      className="sessions-rail"
      data-testid="sessions-rail"
      data-resizing={resizing}
      aria-label="recent sessions in this directory"
      style={{ flexBasis: width }}
    >
      <div className="sessions-rail-header">
        <h2 className="sessions-rail-title">sessions · {sessions.length}</h2>
        <button
          type="button"
          className="sessions-rail-new"
          onClick={() => void actions.newSession()}
          aria-label="new session"
          title="new session"
        >
          + new
        </button>
      </div>
      <ul>
        {sessions.map((session) => {
          const label = sessionLabel(session)!;
          const activity = state.sessionActivity[`${session.runtime}:${session.id}`];
          const working =
            activity?.status === 'starting' ||
            activity?.status === 'running' ||
            activity?.status === 'compacting' ||
            activity?.status === 'retrying';
          const indicator = working ? 'working' : activity?.responseReady ? 'response' : null;
          return (
            <li key={session.id} data-active={session.id === activeId}>
              <button
                type="button"
                className="sessions-rail-item"
                data-active={session.id === activeId}
                data-pending={session.id === pendingSessionId}
                aria-current={session.id === activeId ? 'true' : undefined}
                aria-busy={session.id === pendingSessionId}
                title={session.path ?? session.id}
                onClick={() => {
                  setPendingSessionId(session.id);
                  void actions.resumeSession(session).finally(() => {
                    setPendingSessionId((pending) => (pending === session.id ? null : pending));
                  });
                }}
              >
                <span className="sessions-rail-primary">
                  <span className="sessions-rail-name">{label}</span>
                  {session.runtime !== state.settings.agentRuntime ? (
                    <span className="sessions-rail-runtime">{session.runtime}</span>
                  ) : null}
                  {indicator === 'response' ? (
                    <span
                      className="sessions-rail-indicator sessions-rail-indicator-response"
                      role="status"
                      aria-label="response ready"
                      title="response ready"
                    />
                  ) : null}
                  <span className="sessions-rail-end">
                    {indicator === 'working' ? (
                      <span
                        className="sessions-rail-indicator sessions-rail-indicator-working"
                        role="status"
                        aria-label="assistant working"
                        title="assistant working"
                      />
                    ) : (
                      <span className="sessions-rail-time">
                        {formatRelativeTime(session.lastSeen)}
                      </span>
                    )}
                  </span>
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
      <div
        className="sessions-rail-resize"
        role="separator"
        aria-label="resize sessions sidebar"
        aria-orientation="vertical"
        aria-valuemin={160}
        aria-valuemax={420}
        aria-valuenow={width}
        tabIndex={0}
        onMouseDown={(event) => {
          event.preventDefault();
          setResizing(true);
        }}
        onKeyDown={resizeWithKeyboard}
      />
    </aside>
  );
}

function sessionLabel(session: {
  name: string | null;
  firstMessage?: string | null;
}): string | null {
  const name = session.name?.trim();
  return name || messageLabel(session.firstMessage);
}

function messageLabel(message: string | null | undefined): string | null {
  if (!message) return null;
  const label = message.replace(/\s+/g, ' ').trim();
  if (!label) return null;
  return label.length > 48 ? `${label.slice(0, 48)}…` : label;
}
