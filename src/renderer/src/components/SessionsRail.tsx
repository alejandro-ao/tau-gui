import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useStore } from '../state/store.js';
import { groupSessionsByWorkingDirectory, sessionLabel } from '../state/working-directories.js';
import { formatRelativeTime } from './format.js';

/** Resizable left rail grouping app-owned sessions by working directory. */
export function SessionsRail(): ReactNode {
  const { state, actions } = useStore();
  const [width, setWidth] = useState(260);
  const [resizing, setResizing] = useState(false);
  const [pendingSessionId, setPendingSessionId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const groups = useMemo(() => groupSessionsByWorkingDirectory(state.settings), [state.settings]);
  const sessionCount = groups.reduce((count, group) => count + group.sessions.length, 0);
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
      aria-label="working directories and recent sessions"
      style={{ flexBasis: width }}
    >
      <div className="sessions-rail-header">
        <h2 className="sessions-rail-title">
          projects · {groups.length} / sessions · {sessionCount}
        </h2>
        <button
          type="button"
          className="sessions-rail-new"
          onClick={() => void actions.newSessionFromDirectoryPicker()}
          aria-label="new session in directory"
          title="choose directory for new session"
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M10 4v12M4 10h12" />
          </svg>
        </button>
      </div>
      <div className="sessions-rail-groups">
        {groups.map((group) => {
          const isCollapsed = collapsed[group.cwd] === true;
          return (
            <section className="sessions-directory" key={group.cwd} data-collapsed={isCollapsed}>
              <button
                type="button"
                className="sessions-directory-toggle"
                aria-expanded={!isCollapsed}
                title={group.cwd}
                onClick={() =>
                  setCollapsed((current) => ({ ...current, [group.cwd]: !current[group.cwd] }))
                }
              >
                <span className="sessions-directory-chevron" aria-hidden="true">
                  ›
                </span>
                <span className="sessions-directory-name">{group.label}</span>
                <span className="sessions-directory-count">{group.sessions.length}</span>
              </button>
              {isCollapsed ? null : (
                <ul>
                  {group.sessions.map((session) => {
                    const label = sessionLabel(session)!;
                    const activity = state.sessionActivity[`${session.runtime}:${session.id}`];
                    const working =
                      activity?.status === 'starting' ||
                      activity?.status === 'running' ||
                      activity?.status === 'compacting' ||
                      activity?.status === 'retrying';
                    const indicator = working
                      ? 'working'
                      : activity?.responseReady
                        ? 'response'
                        : null;
                    return (
                      <li
                        key={`${session.runtime}:${session.id}`}
                        data-active={session.id === activeId}
                      >
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
                              setPendingSessionId((pending) =>
                                pending === session.id ? null : pending,
                              );
                            });
                          }}
                        >
                          <span className="sessions-rail-primary">
                            <span className="sessions-rail-name">{label}</span>
                            {session.runtime !== state.settings.agentRuntime ? (
                              <span className="sessions-rail-runtime">{session.runtime}</span>
                            ) : null}
                            <span className="sessions-rail-end">
                              {indicator ? (
                                <span
                                  className={`sessions-rail-indicator sessions-rail-indicator-${indicator}`}
                                  role="status"
                                  aria-label={
                                    indicator === 'working' ? 'assistant working' : 'response ready'
                                  }
                                  title={
                                    indicator === 'working' ? 'assistant working' : 'response ready'
                                  }
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
              )}
            </section>
          );
        })}
      </div>
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
