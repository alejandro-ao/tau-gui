import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { TreeRow, TreeSnapshot, TreeSummaryMode } from '../../../../shared/domain.js';
import { useStore } from '../../state/store.js';
import { firstLine } from '../format.js';
import { Picker, type PickerItem } from './Picker.js';

/** Bounded session-tree browser. Rows contain previews only, never full messages/details. */
export function TreeModal(): ReactNode {
  const { state, actions } = useStore();
  const [snapshot, setSnapshot] = useState<TreeSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<TreeSummaryMode>('none');
  const [instructions, setInstructions] = useState('');
  const [summaryLabel, setSummaryLabel] = useState('');
  const [navigating, setNavigating] = useState(false);
  const loadGeneration = useRef(0);
  const supported = state.snapshot.capabilities.sessionTree;

  const load = (): void => {
    const generation = ++loadGeneration.current;
    setError(null);
    void actions.loadTree().then((loaded) => {
      if (generation !== loadGeneration.current) return;
      if (loaded) setSnapshot(loaded);
      else setError('The runtime did not return a session tree.');
    });
  };

  useEffect(() => {
    if (!supported) return;
    load();
    return () => {
      loadGeneration.current += 1;
    };
    // actions is stable for the mounted provider.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supported]);

  const rows = useMemo(() => snapshot?.rows ?? [], [snapshot]);
  const leafId = snapshot?.leafId ?? null;
  const items = useMemo<PickerItem[]>(
    () =>
      rows.map((row) => ({
        id: row.id,
        label: rowLabel(row),
        depth: row.depth,
        tone: prominence(row),
        hint: timestamp(row.timestamp),
        detail: `${row.kind} · ${row.id}${row.label ? ` · ${row.label}` : ''}`,
        current: row.id === leafId,
        keywords: `${row.kind} ${row.preview}`,
        reason: navigating ? 'navigation is already in progress' : null,
      })),
    [rows, leafId, navigating],
  );

  const subtitle = error
    ? error
    : snapshot?.truncated
      ? 'Tree limit reached; refine the session before navigating omitted rows.'
      : supported
        ? 'Navigate in place; choose whether to summarize the branch being left.'
        : 'this runtime does not expose session tree inspection';

  return (
    <Picker
      name="tree"
      title="session tree"
      subtitle={subtitle}
      placeholder="search bounded previews…"
      items={items}
      emptyLabel={supported ? 'no entries yet' : 'unavailable for this runtime'}
      onClose={() => actions.openModal(null)}
      footer={
        <div className="tree-summary-controls">
          <label>
            branch summary
            <select
              aria-label="branch summary mode"
              value={mode}
              disabled={navigating}
              onChange={(event) => setMode(event.target.value as TreeSummaryMode)}
            >
              <option value="none">none</option>
              <option value="default">default</option>
              <option value="custom">custom focus</option>
            </select>
          </label>
          {mode === 'custom' ? (
            <input
              aria-label="branch summary focus"
              maxLength={2_000}
              value={instructions}
              disabled={navigating}
              onChange={(event) => setInstructions(event.target.value)}
              placeholder="what should the summary focus on?"
            />
          ) : null}
          {mode !== 'none' ? (
            <input
              aria-label="branch summary label"
              maxLength={120}
              value={summaryLabel}
              disabled={navigating}
              onChange={(event) => setSummaryLabel(event.target.value)}
              placeholder="optional summary label"
            />
          ) : null}
          {error ? (
            <button type="button" disabled={navigating} onClick={load}>
              retry
            </button>
          ) : null}
        </div>
      }
      rowActions={(item) => {
        const row = rows.find((candidate) => candidate.id === item.id);
        if (!row) return null;
        return (
          <button
            type="button"
            className="ghost-button"
            title={row.label ? 'Clear bookmark' : 'Bookmark entry'}
            disabled={navigating}
            onClick={(event) => {
              event.stopPropagation();
              void actions
                .setLabel(item.id, row.label ? null : 'bookmark')
                .then(() => actions.loadTree())
                .then((loaded) => {
                  if (loaded) setSnapshot(loaded);
                });
            }}
          >
            {row.label ? 'unlabel' : 'label'}
          </button>
        );
      }}
      onAccept={(item) => {
        if (!supported || navigating) return;
        const customInstructions = instructions.trim();
        if (mode === 'custom' && !customInstructions) {
          setError('Enter summary focus instructions before navigating.');
          return;
        }
        setNavigating(true);
        setError(null);
        void actions
          .fork(item.id, {
            summary: mode,
            ...(mode === 'custom' ? { customInstructions } : {}),
            ...(mode !== 'none' && summaryLabel.trim() ? { label: summaryLabel.trim() } : {}),
          })
          .then((text) => {
            if (text === null) {
              setError('Tree navigation was cancelled, aborted, or failed. You can retry.');
              return;
            }
            if (text) actions.setDraft(text);
            actions.openModal(null);
          })
          .catch(() => setError('Tree navigation failed. You can retry or cancel.'))
          .finally(() => setNavigating(false));
      }}
    />
  );
}

function prominence(row: TreeRow): 'primary' | 'muted' {
  return row.role === 'user' || row.kind === 'compaction' || row.kind === 'branch_summary'
    ? 'primary'
    : 'muted';
}

function rowLabel(row: TreeRow): string {
  const prefix = row.role ?? row.kind.replaceAll('_', ' ');
  const preview = firstLine(row.preview) || row.preview;
  return `${row.label ? `[${row.label}] ` : ''}${prefix} · ${truncate(preview, 90)}`;
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function timestamp(value: string): string {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? value : new Date(parsed).toISOString().slice(11, 19);
}
