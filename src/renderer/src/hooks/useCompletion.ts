import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { quotePath } from '../../../shared/paths.js';
import type { FileCompletion } from '../../../shared/ipc.js';
import type { CompletionItem } from '../components/completion/CompletionPopup.js';
import { applyCompletion, pathQuery, slashQuery } from '../components/completion/tokens.js';
import { buildCommands, type AppCommand } from '../components/modals/commands.js';
import { fuzzyFilter } from '../components/modals/fuzzy.js';
import { useStore } from '../state/store.js';

const MAX_ITEMS = 12;
const DEBOUNCE_MS = 90;

export interface Completion {
  kind: 'slash' | 'path' | null;
  items: CompletionItem[];
  index: number;
  select: (index: number) => void;
  move: (delta: number) => void;
  /** `run` executes a slash command, `insert` only completes the draft text. */
  accept: (mode: 'run' | 'insert', item?: CompletionItem) => void;
  dismiss: () => void;
}

/**
 * Composer completion: `/` commands merged from the runtime, GUI commands and
 * capability-gated actions, plus `@` file paths from the main process.
 */
export function useCompletion(
  draft: string,
  cursor: number,
  applyText: (text: string, cursor: number) => void,
): Completion {
  const { state, actions } = useStore();
  const [index, setIndex] = useState(0);
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  const [paths, setPaths] = useState<FileCompletion[]>([]);
  const selectedId = useRef<string | null>(null);

  const slash = slashQuery(draft, cursor);
  const path = pathQuery(draft, cursor);
  const token = slash !== null ? slash : path ? path.token.text : null;
  const dismissed = dismissedFor !== null && dismissedFor === token;

  const commands = useMemo(() => buildCommands(state, actions), [state, actions]);

  const slashItems = useMemo<CompletionItem[]>(() => {
    if (slash === null) return [];
    const candidates = commands.filter(
      (command): command is AppCommand & { slash: string } => command.slash !== null,
    );
    const matches = fuzzyFilter(
      candidates,
      slash.slice(1),
      (command) => `${command.slash} ${command.description}`,
    );
    return matches.slice(0, MAX_ITEMS).map((command) => ({
      id: command.id,
      label: command.slash,
      detail: command.description,
      badge: command.unavailable ? 'unavailable' : command.origin,
      reason: command.unavailable,
      insert: command.slash,
    }));
  }, [commands, slash]);

  const pathItems = useMemo<CompletionItem[]>(
    () =>
      paths.slice(0, MAX_ITEMS).map((entry) => ({
        id: entry.path,
        label: entry.path,
        badge: entry.isDirectory ? 'dir' : null,
        insert: quotePath(entry.path),
        isDirectory: entry.isDirectory,
      })),
    [paths],
  );

  // Debounced main-process search; previous results stay visible while it runs.
  const query = path?.query ?? null;
  useEffect(() => {
    if (query === null) {
      setPaths([]);
      return;
    }
    const timer = setTimeout(() => {
      void actions.completePaths(query).then((results) => setPaths(results));
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [actions, query]);

  const items = useMemo<CompletionItem[]>(
    () => (slash !== null ? slashItems : path ? pathItems : []),
    [slash, slashItems, path, pathItems],
  );
  const kind: 'slash' | 'path' | null =
    dismissed || items.length === 0 ? null : slash !== null ? 'slash' : path ? 'path' : null;

  // Selection is kept by id so async refreshes do not move the highlight.
  useEffect(() => {
    const current = selectedId.current;
    const found = current === null ? -1 : items.findIndex((item) => item.id === current);
    if (found >= 0) {
      if (found !== index) setIndex(found);
      return;
    }
    if (index !== 0) setIndex(0);
    selectedId.current = items[0]?.id ?? null;
  }, [items, index]);

  const select = useCallback(
    (next: number) => {
      setIndex(next);
      selectedId.current = items[next]?.id ?? null;
    },
    [items],
  );

  const move = useCallback(
    (delta: number) => {
      if (items.length === 0) return;
      const next = (index + delta + items.length) % items.length;
      select(next);
    },
    [items, index, select],
  );

  const accept = useCallback(
    (mode: 'run' | 'insert', item?: CompletionItem) => {
      const chosen = item ?? items[index];
      if (!chosen) return;
      if (kind === 'path') {
        const target = pathQuery(draft, cursor);
        if (!target) return;
        const next = draft[target.token.end];
        const trailing = chosen.isDirectory
          ? '/'
          : next === undefined || /\s/.test(next)
            ? ''
            : ' ';
        const applied = applyCompletion(draft, target.token, `${chosen.insert}${trailing}`);
        applyText(applied.text, applied.cursor);
        return;
      }
      const command = commands.find((candidate) => candidate.id === chosen.id);
      if (!command) return;
      if (mode === 'insert' || command.unavailable) {
        if (command.unavailable) {
          actions.notice(`${command.title} is unavailable: ${command.unavailable}`);
          return;
        }
        const insertion = `${chosen.insert} `;
        applyText(insertion, insertion.length);
        return;
      }
      applyText('', 0);
      command.run();
    },
    [actions, applyText, commands, cursor, draft, index, items, kind],
  );

  const dismiss = useCallback(() => setDismissedFor(token), [token]);

  return { kind, items, index, select, move, accept, dismiss };
}
