import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useCompletion } from '../hooks/useCompletion.js';
import { useFileDrop } from '../hooks/useFileDrop.js';
import { isRunning } from '../state/reducer.js';
import { useStore } from '../state/store.js';
import { ActivitySpinner } from './ActivitySpinner.js';
import { CompletionPopup } from './completion/CompletionPopup.js';
import { draftSegments } from './completion/directives.js';
import { insertPaths } from './completion/tokens.js';
import { hasTextSelection } from './format.js';

interface ShellIntent {
  command: string;
  excludeFromContext: boolean;
}

interface EditSnapshot {
  text: string;
  selectionStart: number;
  selectionEnd: number;
}

type UserEditKind = 'insert' | 'deleteBackward' | 'deleteForward';

interface UserEdit {
  kind: UserEditKind;
  text: string;
  selectionStart: number;
  selectionEnd: number;
}

const MAX_EDIT_HISTORY = 100;

function userEditKind(inputType: string): UserEditKind | null {
  if (inputType === 'insertText' || inputType === 'insertCompositionText') return 'insert';
  if (/^delete.*Backward$/.test(inputType)) return 'deleteBackward';
  if (/^delete.*Forward$/.test(inputType)) return 'deleteForward';
  return null;
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
  const submittedBySession = useRef(new Map<string, string>());
  const recallInFlight = useRef(false);
  const draftRevision = useRef(0);
  const input = useRef<HTMLTextAreaElement | null>(null);
  const backdrop = useRef<HTMLDivElement | null>(null);
  const draftRef = useRef(draft);
  const selection = useRef({ start: 0, end: 0 });
  const pendingSelection = useRef<{ start: number; end: number } | null>(null);
  const undoStack = useRef<EditSnapshot[]>([]);
  const redoStack = useRef<EditSnapshot[]>([]);
  const lastUserEdit = useRef<UserEdit | null>(null);
  const [cursor, setCursor] = useState(0);

  // Focus on initial session load and whenever a session action opens another
  // transcript. The request counter also handles reopening the active session.
  useEffect(() => {
    input.current?.focus();
  }, [state.composerFocusRequest]);

  const running = isRunning(state);
  const capabilities = state.snapshot.capabilities;
  const sessionKey = `${state.snapshot.runtime}:${state.snapshot.state?.sessionId ?? ''}`;
  const viewedSession = useRef(sessionKey);
  viewedSession.current = sessionKey;
  const sessionTransitioning = useRef(state.sessionTransitioning);
  sessionTransitioning.current = state.sessionTransitioning;
  const shellMode = draft.startsWith('!');
  const shellDisabled = shellMode && !capabilities.directBash;

  const setDraft = useCallback(
    (
      text: string,
      selectionStart = text.length,
      selectionEnd = selectionStart,
      restore = true,
      userEdit: UserEditKind | null = null,
    ) => {
      const previousText = draftRef.current;
      if (text === previousText) return;
      draftRevision.current += 1;
      const previousSelection = selection.current;
      const previousUserEdit = lastUserEdit.current;
      const continuesUserEdit =
        userEdit !== null &&
        previousUserEdit?.kind === userEdit &&
        previousUserEdit.text === previousText &&
        previousUserEdit.selectionStart === previousSelection.start &&
        previousUserEdit.selectionEnd === previousSelection.end &&
        previousSelection.start === previousSelection.end;
      if (!continuesUserEdit) {
        undoStack.current.push({
          text: previousText,
          selectionStart: previousSelection.start,
          selectionEnd: previousSelection.end,
        });
        if (undoStack.current.length > MAX_EDIT_HISTORY) undoStack.current.shift();
      }
      redoStack.current = [];
      draftRef.current = text;
      selection.current = { start: selectionStart, end: selectionEnd };
      lastUserEdit.current = userEdit
        ? { kind: userEdit, text, selectionStart, selectionEnd }
        : null;
      if (restore) pendingSelection.current = { start: selectionStart, end: selectionEnd };
      setCursor(selectionStart);
      actions.setDraft(text);
    },
    [actions],
  );

  // Modal selections and asynchronous prefills dispatch to the shared store
  // directly. Treat those replacements as edits and invalidate stale redo.
  useEffect(() => {
    const previousText = draftRef.current;
    if (draft === previousText) return;
    draftRevision.current += 1;
    undoStack.current.push({
      text: previousText,
      selectionStart: selection.current.start,
      selectionEnd: selection.current.end,
    });
    if (undoStack.current.length > MAX_EDIT_HISTORY) undoStack.current.shift();
    redoStack.current = [];
    lastUserEdit.current = null;
    draftRef.current = draft;
    selection.current = { start: draft.length, end: draft.length };
    pendingSelection.current = { start: draft.length, end: draft.length };
    setCursor(draft.length);
  }, [draft]);

  /** Replaces the draft and restores the caret once React has re-rendered. */
  const applyText = useCallback(
    (text: string, nextCursor: number) => {
      setDraft(text, nextCursor);
    },
    [setDraft],
  );

  const restoreEdit = useCallback(
    (source: { current: EditSnapshot[] }, destination: { current: EditSnapshot[] }) => {
      const next = source.current.pop();
      if (!next) return;
      lastUserEdit.current = null;
      const element = input.current;
      destination.current.push({
        text: draftRef.current,
        selectionStart: element?.selectionStart ?? selection.current.start,
        selectionEnd: element?.selectionEnd ?? selection.current.end,
      });
      draftRevision.current += 1;
      draftRef.current = next.text;
      selection.current = { start: next.selectionStart, end: next.selectionEnd };
      pendingSelection.current = { start: next.selectionStart, end: next.selectionEnd };
      setCursor(next.selectionStart);
      actions.setDraft(next.text);
    },
    [actions],
  );

  useEffect(() => {
    const next = pendingSelection.current;
    if (!next) return;
    pendingSelection.current = null;
    const element = input.current;
    if (!element) return;
    element.focus();
    element.setSelectionRange(next.start, next.end);
  }, [draft]);

  // Keeps the highlight backdrop aligned with the textarea once it starts to
  // scroll past its max-height.
  const syncScroll = useCallback((element: HTMLTextAreaElement) => {
    const layer = backdrop.current;
    if (!layer) return;
    layer.scrollTop = element.scrollTop;
    layer.scrollLeft = element.scrollLeft;
  }, []);

  // Grow the box with its content, including soft-wrapped long lines; the CSS
  // max-height caps it and overflow-y takes over past the limit.
  useEffect(() => {
    const element = input.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${element.scrollHeight}px`;
    syncScroll(element);
  }, [draft, syncScroll]);

  const completion = useCompletion(draft, cursor, applyText);

  // Skills and custom prompts expand inside the runtime, so the draft itself is
  // marked to distinguish them from GUI commands that never reach the model.
  const segments = useMemo(() => draftSegments(draft, state.resources), [draft, state.resources]);
  const directive = segments[0]?.kind ?? null;

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
        submittedBySession.current.set(sessionKey, text);
        void actions.runShell(intent.command, intent.excludeFromContext);
        return;
      }
      const trimmed = text.trim();
      if (!trimmed) return;

      // Tau's RPC prompt endpoint does not dispatch TUI commands. Consume every
      // command the desktop app owns before deciding whether to prompt/steer.
      if (mode === 'primary' && completion.runInvocation(trimmed)) {
        setDraft('');
        submittedBySession.current.set(sessionKey, trimmed);
        return;
      }

      if (running) {
        setDraft('');
        submittedBySession.current.set(sessionKey, trimmed);
        if (mode === 'followUp') void actions.followUp(trimmed);
        else void actions.steer(trimmed);
        return;
      }

      setDraft('');
      submittedBySession.current.set(sessionKey, trimmed);
      void actions.submit(trimmed);
    },
    [actions, capabilities.directBash, completion, running, sessionKey, setDraft],
  );

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    const key = event.key.toLowerCase();
    if (
      key.startsWith('arrow') ||
      key === 'home' ||
      key === 'end' ||
      key === 'pageup' ||
      key === 'pagedown'
    ) {
      lastUserEdit.current = null;
    }
    const commandModifier = (event.metaKey || event.ctrlKey) && !event.altKey;
    if (commandModifier && key === 'z') {
      event.preventDefault();
      restoreEdit(event.shiftKey ? redoStack : undoStack, event.shiftKey ? undoStack : redoStack);
      return;
    }
    if (event.ctrlKey && !event.metaKey && !event.altKey && key === 'y') {
      event.preventDefault();
      restoreEdit(redoStack, undoStack);
      return;
    }

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
      event.preventDefault();
      if (recallInFlight.current) return;
      recallInFlight.current = true;
      const revision = draftRevision.current;
      void actions
        .popQueued()
        .then(async (item) => {
          // A claim stays main-owned until this exact response is accepted or
          // restored. Revision comparison is identity-independent: typing the
          // same text as the queued item still counts as a newer draft.
          const canApply =
            viewedSession.current === sessionKey &&
            !sessionTransitioning.current &&
            draftRevision.current === revision;
          if (item) {
            if (!canApply) {
              await item.resolve('restore');
              return;
            }
            applyText(item.text, item.text.length);
            await item.resolve('accept');
            return;
          }
          if (!canApply) return;
          const recalled = submittedBySession.current.get(sessionKey);
          if (recalled) applyText(recalled, recalled.length);
        })
        .finally(() => {
          recallInFlight.current = false;
        });
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
        data-directive={directive ?? undefined}
        data-testid="composer"
        title={shellDisabled ? 'This runtime lacks direct shell execution.' : undefined}
      >
        <span className="composer-prefix">
          {shellMode ? (
            <span aria-hidden="true">$</span>
          ) : running ? (
            <ActivitySpinner />
          ) : (
            <span aria-hidden="true">τ</span>
          )}
        </span>
        <div className="composer-editor">
          {/* Mirror of the draft painted over the textarea. Plain glyphs stay
              transparent so the textarea keeps rendering text, selection and
              caret; only directive spans paint, in their accent colour. */}
          <div
            ref={backdrop}
            className="composer-highlight"
            data-testid="composer-highlight"
            aria-hidden="true"
          >
            {segments.map((segment, index) => (
              <span
                key={index}
                className={segment.kind ? 'composer-directive' : undefined}
                data-kind={segment.kind ?? undefined}
              >
                {segment.text}
              </span>
            ))}
          </div>
          <textarea
            ref={input}
            className="composer-input"
            aria-label="composer"
            rows={1}
            value={draft}
            placeholder={placeholder(running)}
            spellCheck={false}
            onChange={(event) => {
              const inputType =
                'inputType' in event.nativeEvent && typeof event.nativeEvent.inputType === 'string'
                  ? event.nativeEvent.inputType
                  : '';
              setDraft(
                event.target.value,
                event.target.selectionStart,
                event.target.selectionEnd,
                false,
                userEditKind(inputType),
              );
            }}
            onSelect={(event) => {
              selection.current = {
                start: event.currentTarget.selectionStart,
                end: event.currentTarget.selectionEnd,
              };
              setCursor(event.currentTarget.selectionStart);
            }}
            onClick={(event) => {
              lastUserEdit.current = null;
              selection.current = {
                start: event.currentTarget.selectionStart,
                end: event.currentTarget.selectionEnd,
              };
              setCursor(event.currentTarget.selectionStart);
            }}
            onKeyUp={(event) => {
              selection.current = {
                start: event.currentTarget.selectionStart,
                end: event.currentTarget.selectionEnd,
              };
              setCursor(event.currentTarget.selectionStart);
            }}
            onKeyDown={onKeyDown}
            onScroll={(event) => syncScroll(event.currentTarget)}
          />
        </div>
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
        </div>
      </div>
    </div>
  );
}

function placeholder(running: boolean): string {
  if (!running) return 'Ask, or !command for shell · Enter to send · Shift+Enter for newline';
  return 'Enter queues priority guidance · Alt+Enter queues a follow-up';
}
