import type { ReactNode } from 'react';
import { useElapsedSeconds } from '../hooks/useElapsed.js';
import type { ToolBlock, ToolState } from '../state/types.js';
import { ToolBlockView } from './ToolBlockView.js';
import { toolIntent } from './format.js';

export function ToolGroupView({
  blocks,
  expanded,
  onToggle,
  isBlockExpanded,
  onToggleBlock,
  settled,
  nested = false,
}: {
  blocks: ToolBlock[];
  expanded: boolean;
  onToggle: () => void;
  isBlockExpanded: (id: string) => boolean;
  onToggleBlock: (id: string) => void;
  settled: boolean;
  nested?: boolean;
}): ReactNode {
  const first = blocks[0];
  const state = aggregateState(blocks);
  const running = state === 'running';
  const startedAt = Math.min(...blocks.map((block) => block.startedAt));
  const liveSeconds = useElapsedSeconds(
    Number.isFinite(startedAt) ? startedAt : Date.now(),
    running,
  );

  if (!first) return null;

  if (!settled) {
    return (
      <article
        className={`tool-run tool-run-live${nested ? ' tool-run-nested' : ''}`}
        data-state={state}
        data-tool-count={blocks.length}
        aria-label="tool activity"
      >
        <div className="tool-run-items">
          {blocks.map((block) => {
            const blockExpanded = isBlockExpanded(block.id);
            return (
              <button
                key={block.id}
                type="button"
                className="tool-run-item"
                data-state={block.state}
                onClick={() => onToggleBlock(block.id)}
                aria-expanded={blockExpanded}
              >
                <span className="tool-marker" aria-hidden="true">
                  {marker(block.state)}
                </span>
                <span className="tool-name">{block.name}</span>
                <span className="tool-intent">{toolIntent(block.name, block.args)}</span>
              </button>
            );
          })}
        </div>
        {blocks.map((block) =>
          isBlockExpanded(block.id) ? (
            <div className="tool-run-expanded" key={`detail-${block.id}`}>
              <ToolBlockView block={block} expanded onToggle={() => onToggleBlock(block.id)} />
            </div>
          ) : null,
        )}
      </article>
    );
  }

  const elapsedSeconds = running ? liveSeconds : settledSeconds(blocks, startedAt);
  const label = `Worked for ${formatDuration(elapsedSeconds)} · ${blocks.length} ${blocks.length === 1 ? 'tool' : 'tools'} called`;

  return (
    <article
      className={`tool-run${nested ? ' tool-run-nested' : ''}`}
      data-state={state}
      data-tool-count={blocks.length}
    >
      <button type="button" className="tool-run-header" onClick={onToggle} aria-expanded={expanded}>
        <span className="tool-marker" aria-hidden="true">
          {marker(state)}
        </span>
        <span>{label}</span>
        <span className="tool-run-chevron" aria-hidden="true">
          {expanded ? '▾' : '▸'}
        </span>
      </button>

      {expanded ? (
        <div className="tool-run-detail">
          {blocks.map((block) => (
            <ToolBlockView
              key={block.id}
              block={block}
              expanded={isBlockExpanded(block.id)}
              onToggle={() => onToggleBlock(block.id)}
            />
          ))}
        </div>
      ) : null}
    </article>
  );
}

function marker(state: ToolState): string {
  return state === 'running' ? '◐' : state === 'error' ? '✕' : '●';
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
