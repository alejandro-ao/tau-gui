import type { ReactNode } from 'react';
import { useElapsedSeconds } from '../hooks/useElapsed.js';
import type { ThinkingBlock, ToolBlock, ToolState } from '../state/types.js';
import { ToolBlockView } from './ToolBlockView.js';
import { toolIntent, toolPaths } from './format.js';

export type ActivityBlock = ToolBlock | ThinkingBlock;

type ActivityRow =
  { kind: 'thinking'; block: ThinkingBlock } | { kind: 'tools'; blocks: ToolBlock[] };

const FILE_TOOLS = new Set(['read', 'edit', 'write']);

export function ToolGroupView({
  blocks,
  activity = blocks,
  expanded,
  onToggle,
  isBlockExpanded,
  onToggleBlock,
  settled,
  turnStartedAt,
  turnEndedAt,
  nested = false,
}: {
  blocks: ToolBlock[];
  activity?: ActivityBlock[];
  expanded: boolean;
  onToggle: () => void;
  isBlockExpanded: (id: string) => boolean;
  onToggleBlock: (id: string) => void;
  settled: boolean;
  turnStartedAt?: number;
  turnEndedAt?: number;
  nested?: boolean;
}): ReactNode {
  const first = blocks[0];
  const state = aggregateState(blocks);
  const running = state === 'running';
  const firstToolStartedAt = Math.min(...blocks.map((block) => block.startedAt));
  const startedAt = turnStartedAt ?? firstToolStartedAt;
  const liveSeconds = useElapsedSeconds(
    Number.isFinite(startedAt) ? startedAt : Date.now(),
    running,
  );

  if (!first) return null;

  const feed = (
    <ActivityFeed
      activity={activity}
      isBlockExpanded={isBlockExpanded}
      onToggleBlock={onToggleBlock}
    />
  );

  if (!settled) {
    return (
      <article
        className={`tool-run tool-run-live${nested ? ' tool-run-nested' : ''}`}
        data-state={state}
        data-tool-count={blocks.length}
        aria-label="tool activity"
      >
        {feed}
      </article>
    );
  }

  const elapsedSeconds = running
    ? liveSeconds
    : turnEndedAt === undefined
      ? settledSeconds(blocks, firstToolStartedAt)
      : Math.max(0, Math.floor((turnEndedAt - startedAt) / 1000));
  const label = `Worked for ${formatDuration(elapsedSeconds)} · ${blocks.length} ${blocks.length === 1 ? 'tool call' : 'tool calls'}`;

  return (
    <article
      className={`tool-run tool-run-settled${nested ? ' tool-run-nested' : ''}`}
      data-state={state}
      data-tool-count={blocks.length}
    >
      <button type="button" className="tool-run-header" onClick={onToggle} aria-expanded={expanded}>
        <span>{label}</span>
        <span className="tool-run-chevron" aria-hidden="true">
          {expanded ? '▾' : '▸'}
        </span>
      </button>
      {expanded ? <div className="tool-run-detail">{feed}</div> : null}
    </article>
  );
}

function ActivityFeed({
  activity,
  isBlockExpanded,
  onToggleBlock,
}: {
  activity: ActivityBlock[];
  isBlockExpanded: (id: string) => boolean;
  onToggleBlock: (id: string) => void;
}): ReactNode {
  return (
    <div className="tool-run-items">
      {activityRows(activity).map((row) => {
        if (row.kind === 'thinking') {
          return (
            <p className="tool-run-thinking" key={row.block.id}>
              {row.block.text}
              {row.block.streaming ? <span className="streaming-caret"> ▌</span> : null}
            </p>
          );
        }
        return (
          <ToolRow
            key={row.blocks.map((block) => block.id).join(':')}
            blocks={row.blocks}
            isBlockExpanded={isBlockExpanded}
            onToggleBlock={onToggleBlock}
          />
        );
      })}
    </div>
  );
}

function ToolRow({
  blocks,
  isBlockExpanded,
  onToggleBlock,
}: {
  blocks: ToolBlock[];
  isBlockExpanded: (id: string) => boolean;
  onToggleBlock: (id: string) => void;
}): ReactNode {
  const first = blocks[0];
  if (!first) return null;

  const clustered = blocks.length > 1;
  return (
    <div className="tool-run-row" data-state={aggregateState(blocks)}>
      <div className="tool-run-row-main">
        <span className="tool-marker" aria-hidden="true">
          {marker(aggregateState(blocks))}
        </span>
        {clustered ? (
          <span className="tool-cluster-label">{fileClusterLabel(first.name, blocks)}</span>
        ) : (
          <button
            type="button"
            className="tool-run-item"
            onClick={() => onToggleBlock(first.id)}
            aria-expanded={isBlockExpanded(first.id)}
          >
            <span className="tool-name">{first.name}</span>
            <span className="tool-intent">{toolIntent(first.name, first.args)}</span>
          </button>
        )}
      </div>

      {clustered ? (
        <div className="tool-cluster-paths">
          {blocks.map((block) => (
            <div className="tool-cluster-member" key={block.id}>
              <button
                type="button"
                className="tool-cluster-path"
                onClick={() => onToggleBlock(block.id)}
                aria-expanded={isBlockExpanded(block.id)}
              >
                {toolPaths(block.args)[0] ?? toolIntent(block.name, block.args)}
              </button>
              <ToolBlockView
                block={block}
                expanded={isBlockExpanded(block.id)}
                onToggle={() => onToggleBlock(block.id)}
                compact
              />
            </div>
          ))}
        </div>
      ) : (
        <ToolBlockView
          block={first}
          expanded={isBlockExpanded(first.id)}
          onToggle={() => onToggleBlock(first.id)}
          compact
        />
      )}
    </div>
  );
}

function activityRows(activity: ActivityBlock[]): ActivityRow[] {
  const rows: ActivityRow[] = [];
  for (const block of activity) {
    if (block.kind === 'thinking') {
      rows.push({ kind: 'thinking', block });
      continue;
    }
    const previous = rows.at(-1);
    if (
      previous?.kind === 'tools' &&
      FILE_TOOLS.has(block.name) &&
      previous.blocks[0]?.name === block.name
    ) {
      previous.blocks.push(block);
    } else {
      rows.push({ kind: 'tools', blocks: [block] });
    }
  }
  return rows;
}

function fileClusterLabel(name: string, blocks: ToolBlock[]): string {
  const complete = blocks.every((block) => block.state !== 'running');
  const verb = complete
    ? name === 'write'
      ? 'wrote'
      : name === 'edit'
        ? 'edited'
        : 'read'
    : name === 'write'
      ? 'writing'
      : name === 'edit'
        ? 'editing'
        : 'reading';
  const failed = blocks.filter((block) => block.state === 'error').length;
  return `${verb} ${blocks.length} files${failed ? ` · ${failed} failed` : ''}`;
}

function marker(state: ToolState): string {
  return state === 'running' ? '◐' : state === 'error' ? '×' : '–';
}

function aggregateState(blocks: ToolBlock[]): ToolState {
  if (blocks.some((block) => block.state === 'running')) return 'running';
  if (blocks.some((block) => block.state === 'error')) return 'error';
  return 'success';
}

function settledSeconds(blocks: ToolBlock[], startedAt: number): number {
  const endedAt = Math.max(...blocks.map((block) => block.endedAt ?? block.startedAt));
  return Math.max(0, Math.floor((endedAt - startedAt) / 1000));
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return '<1 minute';
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
}
