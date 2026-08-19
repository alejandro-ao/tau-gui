import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { quotePath } from '../../../shared/paths.js';
import type { FileCompletion } from '../../../shared/ipc.js';
import type { CompletionItem } from '../components/completion/CompletionPopup.js';
import { applyCompletion, pathQuery, slashQuery } from '../components/completion/tokens.js';
import { buildCommands, type AppCommand } from '../components/modals/commands.js';
import { fuzzyFilter } from '../components/modals/fuzzy.js';
import { useStore } from '../state/store.js';

// Slash completion is intentionally uncapped so every builtin command is
// reachable, like Tau's TUI; the popup scrolls. Path results stay capped
// because the filesystem can return far more.
const MAX_PATH_ITEMS = 12;
const DEBOUNCE_MS = 90;

export interface Completion {
  kind: 'slash' | 'path' | null;
  items: CompletionItem[];
  index: number;
  select: (index: number) => void;
  move: (delta: number) => void;
  /** `run` executes a slash command, `insert` only completes the draft text. */
  accept: (mode: 'run' | 'insert', item?: CompletionItem) => void;
  /** Execute a complete slash invocation, including arguments, when registered locally. */
  runInvocation: (text: string) => boolean;
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
    const haystack = (item: CompletionItem): string => `${item.label} ${item.detail ?? ''}`;
    // `/skill:<prefix>` completes skill names only, matching Tau's TUI.
    if (slash.startsWith('/skill:')) {
      return fuzzyFilter(
        state.resources.skills.map((skill) => ({
          id: `skill:${skill.name}`,
          label: `/skill:${skill.name}`,
          detail: skill.description,
          badge: skill.disableModelInvocation ? 'user only' : 'skill',
          kind: 'skill' as const,
          insert: `/skill:${skill.name}`,
        })),
        slash.slice('/skill:'.length),
        haystack,
      );
    }
    // Other colon-prefixed tokens offer no completions, like Tau.
    if (slash.includes(':')) return [];
    const promptSlashes = new Set(state.resources.prompts.map((prompt) => `/${prompt.name}`));
    const commandItems: CompletionItem[] = commands
      .filter(
        (command): command is AppCommand & { slash: string } =>
          command.slash !== null && !promptSlashes.has(command.slash),
      )
      .map((command) => ({
        id: command.id,
        label: command.slash,
        detail: command.description,
        badge: command.unavailable ? 'unavailable' : command.origin,
        reason: command.unavailable,
        insert: command.slash,
        section: 'Commands',
      }));
    // `/skill:` is an expansion prefix, not a GUI command: accepting it keeps
    // completion open so the skill list takes over, like Tau's skill command.
    if (state.snapshot.runtime === 'tau') {
      commandItems.push({
        id: 'skill:invoke',
        label: '/skill:',
        detail: 'Expand a loaded skill into your prompt',
        badge: 'skill',
        insert: '/skill:',
        keepOpen: true,
        section: 'Commands',
      });
    }
    const promptItems: CompletionItem[] = state.resources.prompts.map((prompt) => ({
      id: `prompt:${prompt.name}`,
      label: `/${prompt.name}`,
      detail: prompt.description,
      badge: 'prompt',
      kind: 'prompt' as const,
      insert: `/${prompt.name}`,
      section: 'Custom prompts',
    }));
    const query = slash.slice(1);
    // Filter within each section so commands and prompts never interleave.
    return [
      ...fuzzyFilter(commandItems, query, haystack),
      ...fuzzyFilter(promptItems, query, haystack),
    ];
  }, [commands, slash, state.resources, state.snapshot.runtime]);

  const pathItems = useMemo<CompletionItem[]>(
    () =>
      paths.slice(0, MAX_PATH_ITEMS).map((entry) => ({
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
      // Skills and custom prompts are expansion directives, not GUI commands.
      // Completion inserts them so the user can add arguments before submitting.
      if (!command) {
        // Prefix items like `/skill:` insert without a trailing space so
        // completion stays open and the skill list takes over.
        const insertion = chosen.keepOpen ? chosen.insert : `${chosen.insert} `;
        applyText(insertion, insertion.length);
        return;
      }
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
      command.run(command.slash ?? undefined);
    },
    [actions, applyText, commands, cursor, draft, index, items, kind],
  );

  const runInvocation = useCallback(
    (text: string): boolean => {
      const slash = text.trim().split(/\s+/, 1)[0]?.toLowerCase();
      if (!slash?.startsWith('/') || slash.startsWith('/skill:')) return false;
      // Tau expands custom prompt templates inside its prompt RPC. They take
      // precedence over same-named GUI commands, matching CodingSession.
      if (state.resources.prompts.some((prompt) => `/${prompt.name.toLowerCase()}` === slash)) {
        return false;
      }
      const command = commands.find((candidate) => candidate.slash === slash);
      if (!command) return false;
      if (command.unavailable) {
        actions.notice(`${command.title} is unavailable: ${command.unavailable}`);
      } else {
        command.run(text.trim());
      }
      return true;
    },
    [actions, commands, state.resources.prompts],
  );

  const dismiss = useCallback(() => setDismissedFor(token), [token]);

  return { kind, items, index, select, move, accept, runInvocation, dismiss };
}
