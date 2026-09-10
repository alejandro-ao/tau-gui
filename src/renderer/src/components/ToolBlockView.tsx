import type { ReactNode } from 'react';
import { useElapsedSeconds } from '../hooks/useElapsed.js';
import type { ToolBlock } from '../state/types.js';
import { AnimatedCollapse } from './AnimatedCollapse.js';
import { CopyButton } from './CopyButton.js';
import { Diff, looksLikeDiff } from './Diff.js';
import { boundedArgs, formatArgs, skillRead, toolIntent, toolPaths } from './format.js';

const MARKERS: Record<ToolBlock['state'], string> = {
  running: '◐',
  success: '●',
  error: '✕',
};

export function ToolBlockView({
  block,
  expanded,
  onToggle,
  compact = false,
}: {
  block: ToolBlock;
  expanded: boolean;
  onToggle: () => void;
  compact?: boolean;
}): ReactNode {
  const paths = toolPaths(block.args);
  const skill = skillRead(block.name, block.args);

  if (compact) {
    return (
      <AnimatedCollapse open={expanded} className="tool-call-collapse">
        <article
          className={`block-tool block-tool-compact${skill ? ' block-tool-skill' : ''}`}
          data-state={block.state}
          data-tool={skill ? 'skill' : block.name}
          data-skill={skill?.name}
        >
          <ToolDetail block={block} compact />
        </article>
      </AnimatedCollapse>
    );
  }

  return (
    <article
      className={`block block-tool${skill ? ' block-tool-skill' : ''}`}
      data-state={block.state}
      data-tool={skill ? 'skill' : block.name}
      data-skill={skill?.name}
    >
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
          <span className="tool-name">{skill ? 'skill' : block.name}</span>
          {skill ? <span className="tool-skill-name">{skill.name}</span> : null}
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

        <AnimatedCollapse open={expanded} className="tool-call-collapse">
          <ToolDetail block={block} />
        </AnimatedCollapse>
      </div>
    </article>
  );
}

function ToolDetail({
  block,
  compact = false,
}: {
  block: ToolBlock;
  compact?: boolean;
}): ReactNode {
  const command = typeof block.args['command'] === 'string' ? block.args['command'] : '';
  const skill = skillRead(block.name, block.args);
  return (
    <div className={`tool-detail${compact ? ' tool-detail-compact' : ''}`}>
      <h4>invocation</h4>
      {skill ? <p className="tool-skill-detail">{skill.name}</p> : null}
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
