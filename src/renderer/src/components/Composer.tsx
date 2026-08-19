import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useCompletion } from '../hooks/useCompletion.js';
import { useFileDrop } from '../hooks/useFileDrop.js';
import { isRunning } from '../state/reducer.js';
import { useStore } from '../state/store.js';
import { CompletionPopup } from './completion/CompletionPopup.js';
import { insertPaths } from './completion/tokens.js';
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
  const draft = state.draft;
  const lastSubmitted = useRef<string | null>(null);
  const input = useRef<HTMLTextAreaElement | null>(null);
  const pendingCursor = useRef<number | null>(null);
  const [cursor, setCursor] = useState(0);

  // Focus on initial session load and whenever a session action opens another
  // transcript. The request counter also handles reopening the active session.
  useEffect(() => {
    input.current?.focus();
  }, [state.composerFocusRequest]);

  const running = isRunning(state);
  const capabilities = state.snapshot.capabilities;
  const shellMode = draft.startsWith('!');
  const shellDisabled = shellMode && !capabilities.directBash;

  const setDraft = useCallback(
    (text: string) => {
      actions.setDraft(text);
    },
    [actions],
  );

  /** Replaces the draft and restores the caret once React has re-rendered. */
  const applyText = useCallback(
    (text: string, nextCursor: number) => {
      pendingCursor.current = nextCursor;
      setCursor(nextCursor);
      setDraft(text);
    },
    [setDraft],
  );

  useEffect(() => {
    const position = pendingCursor.current;
    if (position === null) return;
    pendingCursor.current = null;
    const element = input.current;
    if (!element) return;
    element.focus();
    element.setSelectionRange(position, position);
  }, [draft]);

  // Grow the box with its content, including soft-wrapped long lines; the CSS
  // max-height caps it and overflow-y takes over past the limit.
  useEffect(() => {
    const element = input.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${element.scrollHeight}px`;
  }, [draft]);

  const completion = useCompletion(draft, cursor, applyText);

  useFileDrop(
    useCallback(
      (paths: string[]) => {
        void actions.relativize(paths).then((display) => {
          const applied = insertPaths(draft, cursor, display);
          applyText(applied.text, applied.cursor);
        });
      },
      [actions, applyText, cursor, draft],
    ),
  );

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
    [
      actions,
      capabilities.directBash,
      capabilities.followUps,
      capabilities.steering,
      running,
      setDraft,
    ],
  );

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    // Completion owns navigation keys while its popup is open.
    if (completion.kind) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        completion.move(1);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        completion.move(-1);
        return;
      }
      if (event.key === 'Tab') {
        event.preventDefault();
        completion.accept('insert');
        return;
      }
      if (event.key === 'Enter' && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        completion.accept(completion.kind === 'slash' ? 'run' : 'insert');
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        completion.dismiss();
        return;
      }
    }

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
        applyText(recalled, recalled.length);
      }
      return;
    }
    if (event.key.toLowerCase() === 'c' && event.ctrlKey && !hasTextSelection()) {
      event.preventDefault();
      applyText('', 0);
    }
  };

  const status = state.snapshot.status === 'failed' ? 'error' : running ? 'running' : 'idle';

  return (
    <div className="composer-shell">
      {completion.kind ? (
        <CompletionPopup
          kind={completion.kind}
          items={completion.items}
          index={completion.index}
          onHover={completion.select}
          onAccept={(item) =>
            completion.accept(completion.kind === 'slash' ? 'run' : 'insert', item)
          }
        />
      ) : null}
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
          rows={1}
          value={draft}
          placeholder={placeholder(running, capabilities.steering, capabilities.followUps)}
          spellCheck={false}
          onChange={(event) => {
            setCursor(event.target.selectionStart);
            setDraft(event.target.value);
          }}
          onSelect={(event) => setCursor(event.currentTarget.selectionStart)}
          onClick={(event) => setCursor(event.currentTarget.selectionStart)}
          onKeyUp={(event) => setCursor(event.currentTarget.selectionStart)}
          onKeyDown={onKeyDown}
        />
        <div className="composer-side">
          {running ? (
            <button
              type="button"
              className="composer-abort"
              aria-label="abort run"
              title="Abort run (Esc)"
              onClick={() => void actions.abort()}
            >
              <svg viewBox="0 0 20 20" aria-hidden="true">
                <rect x="6" y="6" width="8" height="8" rx="1" />
              </svg>
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
    </div>
  );
}

function placeholder(running: boolean, steering: boolean, followUps: boolean): string {
  if (!running) return 'Ask, or !command for shell · Enter to send · Shift+Enter for newline';
  if (steering) return 'Enter steers the active run · Alt+Enter queues a follow-up';
  if (followUps) return 'Enter queues a follow-up';
  return 'Run in progress';
}
