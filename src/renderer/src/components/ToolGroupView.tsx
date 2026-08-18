import type { ReactNode } from 'react';
import type { ToolBlock, ToolState } from '../state/types.js';
import { ToolBlockView } from './ToolBlockView.js';
import { toolIntent, toolPaths } from './format.js';

export function ToolGroupView({
  name,
  blocks,
  expanded,
  onToggle,
  isBlockExpanded,
  onToggleBlock,
}: {
  name: string;
  blocks: ToolBlock[];
  expanded: boolean;
  onToggle: () => void;
  isBlockExpanded: (id: string) => boolean;
  onToggleBlock: (id: string) => void;
}): ReactNode {
  const first = blocks[0];
  if (!first) return null;
  if (blocks.length === 1) {
    return (
      <ToolBlockView
        block={first}
        expanded={isBlockExpanded(first.id)}
        onToggle={() => onToggleBlock(first.id)}
      />
    );
  }

  const paths = blocks.flatMap((block) => toolPaths(block.args));
  const state = aggregateState(blocks);

  return (
    <article className="block block-tool" data-state={state} data-tool={name} data-group="true">
      <div className="role-bar" aria-hidden="true" />
      <div className="block-body">
        <button type="button" className="block-header" onClick={onToggle} aria-expanded={expanded}>
          <span className="tool-marker" aria-hidden="true">
            {state === 'running' ? '◐' : state === 'error' ? '✕' : '●'}
          </span>
          <span className="tool-name">{name}</span>
          <span className="tool-intent">
            {paths.length > 0 ? `${paths.length} paths` : `${blocks.length} calls`}
          </span>
        </button>

        {/* Grouped calls list intents only; file contents stay behind expansion. */}
        <ul className="path-list">
          {(paths.length > 0 ? paths : blocks.map((block) => toolIntent(name, block.args))).map(
            (entry, index) => (
              <li key={`${entry}-${index}`}>{entry}</li>
            ),
          )}
        </ul>

        {expanded ? (
          <div className="tool-detail">
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
      </div>
    </article>
  );
}

function aggregateState(blocks: ToolBlock[]): ToolState {
  if (blocks.some((block) => block.state === 'running')) return 'running';
  if (blocks.some((block) => block.state === 'error')) return 'error';
  return 'success';
}
