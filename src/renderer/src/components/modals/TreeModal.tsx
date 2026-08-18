import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { SessionEntry, TreeNode, TreeSnapshot } from '../../../../shared/domain.js';
import { useStore } from '../../state/store.js';
import { firstLine } from '../format.js';
import { Picker, type PickerItem } from './Picker.js';

interface Row {
  entry: SessionEntry;
  depth: number;
}

/**
 * Session tree browser.
 *
 * User turns stay prominent, assistant/tool nodes are compact, the active leaf
 * is marked, and accepting a row forks the session at that entry. The forked
 * prompt text is returned by the runtime and prefilled into the composer.
 */
export function TreeModal(): ReactNode {
  const { state, actions } = useStore();
  const [snapshot, setSnapshot] = useState<TreeSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const supported = state.snapshot.capabilities.sessionTree;

  useEffect(() => {
    if (!supported) return;
    let cancelled = false;
    void actions.loadTree().then((loaded) => {
      if (cancelled) return;
      if (loaded) setSnapshot(loaded);
      else setError('The runtime did not return a session tree.');
    });
    return () => {
      cancelled = true;
    };
  }, [actions, supported]);

  const rows = useMemo<Row[]>(() => flatten(snapshot?.tree ?? [], 0), [snapshot]);
  const leafId = snapshot?.leafId ?? null;

  const items = useMemo<PickerItem[]>(
    () =>
      rows.map((row) => ({
        id: row.entry.id,
        label: label(row.entry),
        depth: row.depth,
        tone: prominence(row.entry),
        hint: timestamp(row.entry.timestamp),
        detail: `${row.entry.kind} · ${row.entry.id}`,
        current: row.entry.id === leafId,
        keywords: `${row.entry.kind} ${row.entry.summary}`,
      })),
    [rows, leafId],
  );

  const subtitle = supported
    ? 'Enter forks the session at the selected entry; existing branches are preserved'
    : 'this runtime does not expose session tree inspection';

  return (
    <Picker
      name="tree"
      title="session tree"
      subtitle={error ?? subtitle}
      placeholder="search entries…"
      items={items}
      emptyLabel={supported ? 'no entries yet' : 'unavailable for this runtime'}
      onClose={() => actions.openModal(null)}
      onAccept={(item) => {
        if (!supported) {
          actions.notice('This runtime does not support session forking.');
          return;
        }
        actions.openModal(null);
        void actions.fork(item.id).then((text) => {
          if (text) actions.setDraft(text);
        });
      }}
    />
  );
}

function flatten(nodes: TreeNode[], depth: number): Row[] {
  const rows: Row[] = [];
  for (const node of nodes) {
    rows.push({ entry: node.entry, depth });
    rows.push(...flatten(node.children, depth + 1));
  }
  return rows;
}

function prominence(entry: SessionEntry): 'primary' | 'muted' {
  const role = entry.message?.role;
  if (role === 'user') return 'primary';
  if (entry.kind === 'compaction' || entry.kind === 'branch_summary') return 'primary';
  return 'muted';
}

function label(entry: SessionEntry): string {
  const role = entry.message?.role;
  const prefix =
    role === 'user'
      ? 'user'
      : role === 'assistant'
        ? 'assistant'
        : role === 'toolResult'
          ? 'tool'
          : entry.kind.replaceAll('_', ' ');
  const preview = firstLine(entry.summary) || entry.summary;
  return `${prefix} · ${truncate(preview, 90)}`;
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function timestamp(value: string): string {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? value : new Date(parsed).toISOString().slice(11, 19);
}
