import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { isRunning } from '../state/reducer.js';
import { useStore } from '../state/store.js';
import { hasTextSelection } from './format.js';

interface ShellIntent {
  command: string;
  excludeFromContext: boolean;
}

/** `!cmd` runs and keeps output in context, `!!cmd` runs and excludes it. */
export function parseShellIntent(text: string): ShellIntent | null {
  if (!text.startsWith('!')) return null;
  const excludeFromContext = text.startsWith('!!');
  const command = text.slice(excludeFromContext ? 2 : 1).trim();
  return command ? { command, excludeFromContext } : null;
}

export function Composer(): ReactNode {
  const { state, actions } = useStore();
  const [draft, setDraft] = useState('');
  const lastSubmitted = useRef<string | null>(null);
  const input = useRef<HTMLTextAreaElement | null>(null);

  const running = isRunning(state);
  const capabilities = state.snapshot.capabilities;
  const shellMode = draft.startsWith('!');
  const shellDisabled = shellMode && !capabilities.directBash;

  // Keep focus in the composer for ordinary window clicks so typing never gets lost.
  useEffect(() => {
    const onPointerUp = (event: MouseEvent): void => {
      const target = event.target;
      if (target instanceof HTMLElement) {
        if (target.closest('[data-modal], button, a, textarea, input, .transcript')) return;
      }
      if (hasTextSelection()) return;
      input.current?.focus();
    };
    window.addEventListener('mouseup', onPointerUp);
    return () => window.removeEventListener('mouseup', onPointerUp);
  }, []);

  const send = useCallback(
    (text: string, mode: 'primary' | 'followUp') => {
      const intent = parseShellIntent(text);
      if (intent) {
        if (!capabilities.directBash) {
          actions.notice('This runtime does not support direct shell commands.');
          return;
        }
        setDraft('');
        lastSubmitted.current = text;
        void actions.runShell(intent.command, intent.excludeFromContext);
        return;
      }
      const trimmed = text.trim();
      if (!trimmed) return;

      if (mode === 'followUp' || (running && !capabilities.steering)) {
        if (!capabilities.followUps) {
          actions.notice('This runtime does not support queued follow-ups.');
          return;
        }
        setDraft('');
        lastSubmitted.current = trimmed;
        void actions.followUp(trimmed);
        return;
      }

      if (running) {
        setDraft('');
        lastSubmitted.current = trimmed;
        void actions.steer(trimmed);
        return;
      }

      setDraft('');
      lastSubmitted.current = trimmed;
      void actions.submit(trimmed);
    },
    [actions, capabilities.directBash, capabilities.followUps, capabilities.steering, running],
  );

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Escape') {
      if (running) {
        event.preventDefault();
        void actions.abort();
      }
      return;
    }
    if (event.key === 'Enter' && event.altKey) {
      event.preventDefault();
      send(draft, 'followUp');
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      send(draft, 'primary');
      return;
    }
    if (event.key === 'ArrowUp' && draft.length === 0) {
      const recalled = state.queue.followUp.at(-1) ?? lastSubmitted.current;
      if (recalled) {
        event.preventDefault();
        setDraft(recalled);
      }
      return;
    }
    if (event.key.toLowerCase() === 'c' && event.ctrlKey && !hasTextSelection()) {
      event.preventDefault();
      setDraft('');
    }
  };

  const status = state.snapshot.status === 'failed' ? 'error' : running ? 'running' : 'idle';

  return (
    <div
      className="composer"
      data-status={status}
      data-shell={shellMode}
      data-testid="composer"
      title={shellDisabled ? 'This runtime lacks direct shell execution.' : undefined}
    >
      <span className="composer-prefix" aria-hidden="true">
        {shellMode ? '$' : 'τ'}
      </span>
      <textarea
        ref={input}
        className="composer-input"
        aria-label="composer"
        rows={Math.min(12, Math.max(1, draft.split('\n').length))}
        value={draft}
        placeholder={placeholder(running, capabilities.steering, capabilities.followUps)}
        spellCheck={false}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="composer-side">
        {running ? (
          <button type="button" className="ghost-button" onClick={() => void actions.abort()}>
            esc abort
          </button>
        ) : null}
        {shellDisabled ? <span className="composer-hint">shell unavailable</span> : null}
        {running && !capabilities.steering ? (
          <span className="composer-hint" title="This runtime cannot steer an active run.">
            steering unavailable
          </span>
        ) : null}
        {!capabilities.followUps ? (
          <span className="composer-hint" title="This runtime cannot queue follow-ups.">
            follow-ups unavailable
          </span>
        ) : null}
      </div>
    </div>
  );
}

function placeholder(running: boolean, steering: boolean, followUps: boolean): string {
  if (!running) return 'Ask, or !command for shell · Enter to send · Shift+Enter for newline';
  if (steering) return 'Enter steers the active run · Alt+Enter queues a follow-up · Esc aborts';
  if (followUps) return 'Enter queues a follow-up · Esc aborts';
  return 'Run in progress · Esc aborts';
}
