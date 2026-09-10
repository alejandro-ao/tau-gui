import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { SessionEntry, TreeNode, TreeSnapshot } from '../../../../shared/domain.js';
import { useStore } from '../../state/store.js';
import { firstLine } from '../format.js';
import { Picker, type PickerItem } from './Picker.js';

interface Row {
  entry: SessionEntry;
  depth: number;
}

interface VisibleNode {
  entry: SessionEntry;
  children: VisibleNode[];
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
  const [showTools, setShowTools] = useState(true);
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

  const rows = useMemo<Row[]>(
    () => flatten(projectVisible(snapshot?.tree ?? [], showTools), 0),
    [snapshot, showTools],
  );
  const activeId = useMemo(
    () => activeVisibleEntry(snapshot, new Set(rows.map((row) => row.entry.id))),
    [snapshot, rows],
  );

  const items = useMemo<PickerItem[]>(
    () =>
      rows.map((row) => ({
        id: row.entry.id,
        label: label(row.entry),
        depth: row.depth,
        tone: prominence(row.entry),
        hint: timestamp(row.entry.timestamp),
        detail: `${row.entry.kind} · ${row.entry.id}`,
        current: row.entry.id === activeId,
        keywords: `${row.entry.kind} ${row.entry.summary}`,
      })),
    [rows, activeId],
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
      emptyLabel={supported ? 'no user or assistant messages yet' : 'unavailable for this runtime'}
      footer={
        supported ? (
          <button
            type="button"
            className="ghost-button"
            aria-pressed={showTools}
            title="Toggle tool calls (Ctrl+T)"
            onClick={() => setShowTools((shown) => !shown)}
          >
            tools · {showTools ? 'shown' : 'hidden'}
          </button>
        ) : null
      }
      onPickerKeyDown={(event) => {
        if (!(event.ctrlKey && event.key.toLowerCase() === 't')) return false;
        event.preventDefault();
        setShowTools((shown) => !shown);
        return true;
      }}
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

function projectVisible(nodes: TreeNode[], showTools: boolean): VisibleNode[] {
  const visible: VisibleNode[] = [];
  for (const node of nodes) {
    const children = projectVisible(node.children, showTools);
    if (isConversationEntry(node.entry) && (showTools || !isToolCall(node.entry))) {
      visible.push({ entry: node.entry, children });
    } else {
      // Keep visible descendants connected when metadata or tools are hidden.
      visible.push(...children);
    }
  }
  return visible;
}

/**
 * Keep a linear conversation flush-left. Only a second (or later) child starts
 * a visibly indented branch, and that branch keeps its indentation downstream.
 */
function flatten(nodes: VisibleNode[], parentDepth: number): Row[] {
  const rows: Row[] = [];
  const depths = nodes.map((_, index) => parentDepth + (index > 0 ? 1 : 0));
  nodes.forEach((node, index) => rows.push({ entry: node.entry, depth: depths[index] ?? 0 }));
  nodes.forEach((node, index) => rows.push(...flatten(node.children, depths[index] ?? 0)));
  return rows;
}

function isConversationEntry(entry: SessionEntry): boolean {
  return entry.kind === 'message' && ['user', 'assistant'].includes(entry.message?.role ?? '');
}

function isToolCall(entry: SessionEntry): boolean {
  return entry.message?.role === 'assistant' && entry.message.toolCalls.length > 0;
}

function activeVisibleEntry(snapshot: TreeSnapshot | null, visibleIds: Set<string>): string | null {
  if (!snapshot?.leafId) return null;
  const parents = new Map<string, string | null>();
  const visit = (nodes: TreeNode[], parentId: string | null): void => {
    for (const node of nodes) {
      parents.set(node.entry.id, parentId);
      visit(node.children, node.entry.id);
    }
  };
  visit(snapshot.tree, null);

  let candidate: string | null = snapshot.leafId;
  while (candidate !== null) {
    if (visibleIds.has(candidate)) return candidate;
    candidate = parents.get(candidate) ?? null;
  }
  return null;
}

function prominence(entry: SessionEntry): 'primary' | 'muted' {
  return entry.message?.role === 'user' ? 'primary' : 'muted';
}

function label(entry: SessionEntry): string {
  const message = entry.message;
  if (message?.role === 'assistant' && message.toolCalls.length > 0 && !message.text.trim()) {
    return `tool call · ${message.toolCalls.map((call) => call.name).join(', ')}`;
  }
  const preview = firstLine(entry.summary) || entry.summary;
  return `${message?.role ?? 'message'} · ${truncate(preview, 90)}`;
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function timestamp(value: string): string {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? value : new Date(parsed).toISOString().slice(11, 19);
}
