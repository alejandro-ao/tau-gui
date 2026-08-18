import type { ReactNode } from 'react';
import { useElapsedSeconds } from '../hooks/useElapsed.js';
import type { ToolBlock } from '../state/types.js';
import { CopyButton } from './CopyButton.js';
import { Diff, looksLikeDiff } from './Diff.js';
import { boundedArgs, formatArgs, toolIntent, toolPaths } from './format.js';

const MARKERS: Record<ToolBlock['state'], string> = {
  running: '◐',
  success: '●',
  error: '✕',
};

export function ToolBlockView({
  block,
  expanded,
  onToggle,
}: {
  block: ToolBlock;
  expanded: boolean;
  onToggle: () => void;
}): ReactNode {
  const paths = toolPaths(block.args);
  const command = typeof block.args['command'] === 'string' ? block.args['command'] : '';

  return (
    <article className="block block-tool" data-state={block.state} data-tool={block.name}>
      <div className="role-bar" aria-hidden="true" />
      <div className="block-body">
        <button
          type="button"
          className="block-header"
          onClick={onToggle}
          aria-expanded={expanded}
          title={expanded ? 'Collapse (Ctrl+O toggles all)' : 'Expand (Ctrl+O toggles all)'}
        >
          <span className="tool-marker" aria-hidden="true">
            {MARKERS[block.state]}
          </span>
          <span className="tool-name">{block.name}</span>
          <span className="tool-intent">{toolIntent(block.name, block.args)}</span>
          <ToolElapsed block={block} />
        </button>

        {!expanded && paths.length > 1 ? (
          <ul className="path-list">
            {paths.map((path) => (
              <li key={path}>{path}</li>
            ))}
          </ul>
        ) : null}

        {expanded ? (
          <div className="tool-detail">
            <h4>invocation</h4>
            <pre className="tool-args">{formatArgs(block.args)}</pre>
            <h4>output</h4>
            {block.output.trim().length === 0 ? (
              <p className="faint">{block.state === 'running' ? '(running…)' : '(no output)'}</p>
            ) : looksLikeDiff(block.output) ? (
              <Diff text={block.output} />
            ) : (
              <pre className="tool-output">{block.output}</pre>
            )}
            <div className="block-actions">
              {command ? <CopyButton text={command} label="command" /> : null}
              <CopyButton text={boundedArgs(block.args, 100_000)} label="args" />
              <CopyButton text={block.output} label="output" />
            </div>
          </div>
        ) : null}
      </div>
    </article>
  );
}

function ToolElapsed({ block }: { block: ToolBlock }): ReactNode {
  const running = block.state === 'running';
  const live = useElapsedSeconds(block.startedAt, running);
  const seconds = running
    ? live
    : Math.floor(Math.max(0, (block.endedAt ?? block.startedAt) - block.startedAt) / 1000);
  if (seconds < 1) return null;
  return <span className="tool-elapsed">{seconds}s</span>;
}
