import type { ReactNode } from 'react';
import { Markdown } from '../markdown.js';
import type { ShellBlock, SummaryBlock, TranscriptBlock } from '../state/types.js';
import { CopyButton } from './CopyButton.js';
import { Diff, looksLikeDiff } from './Diff.js';
import { ToolBlockView } from './ToolBlockView.js';

export function BlockView({
  block,
  expanded,
  onToggle,
}: {
  block: TranscriptBlock;
  expanded: boolean;
  onToggle: () => void;
}): ReactNode {
  switch (block.kind) {
    case 'tool':
      return <ToolBlockView block={block} expanded={expanded} onToggle={onToggle} />;

    case 'shell':
      return <ShellBlockView block={block} />;

    case 'user':
      return (
        <div className="message-block message-block-user">
          <BlockFrame kind="user">
            <pre className="block-text">{block.text}</pre>
          </BlockFrame>
          <div className="message-actions">
            <CopyButton text={block.text} label="message" />
          </div>
        </div>
      );

    case 'assistant':
      return (
        <div className="message-block">
          <BlockFrame
            kind="assistant"
            label={block.aborted ? 'assistant · aborted' : 'assistant'}
            labelExtra={
              block.streaming ? (
                <span className="streaming-caret" aria-label="streaming">
                  ▌
                </span>
              ) : null
            }
          >
            {/* An `errorMessage` renders once, as its own error block. */}
            <Markdown text={block.text} />
          </BlockFrame>
          <div className="message-actions">
            <CopyButton text={block.text} label="message" />
          </div>
        </div>
      );

    case 'thinking':
      return (
        <BlockFrame kind="thinking" label="thinking">
          <pre className="block-text">{block.text}</pre>
        </BlockFrame>
      );

    case 'status':
      return (
        <BlockFrame kind="status" label={block.tone === 'warn' ? 'warning' : 'status'}>
          <p className="block-text">{block.text}</p>
        </BlockFrame>
      );

    case 'error':
      return (
        <BlockFrame kind="error" label="error">
          <pre className="block-text">{block.text}</pre>
          <div className="block-actions">
            <CopyButton text={block.text} label="error" />
          </div>
        </BlockFrame>
      );

    case 'custom':
      return (
        <BlockFrame kind="custom" label={block.customType}>
          <Markdown text={block.text} />
        </BlockFrame>
      );

    case 'compaction':
    case 'branch':
      return <SummaryBlockView block={block} expanded={expanded} onToggle={onToggle} />;
  }
}

/**
 * Summaries are context bookkeeping rather than conversation, so they render
 * collapsed behind a one-line header and only expand on demand. The messages
 * they summarise stay in the transcript, so the summary must not dominate it.
 */
function SummaryBlockView({
  block,
  expanded,
  onToggle,
}: {
  block: SummaryBlock;
  expanded: boolean;
  onToggle: () => void;
}): ReactNode {
  const label = block.kind === 'branch' ? 'branch summary' : 'compaction summary';
  return (
    <article className={`block block-${block.kind}`}>
      <div className="role-bar" aria-hidden="true" />
      <div className="block-body">
        <button
          type="button"
          className="summary-header"
          onClick={onToggle}
          aria-expanded={expanded}
        >
          <span className="summary-label">{label}</span>
          {block.detail ? <span className="summary-detail">{block.detail}</span> : null}
          <span className="summary-chevron" aria-hidden="true">
            {expanded ? '▾' : '▸'}
          </span>
        </button>
        {expanded ? (
          <div className="summary-body">
            <Markdown text={block.summary} />
            <div className="block-actions">
              <CopyButton text={block.summary} label="summary" />
            </div>
          </div>
        ) : null}
      </div>
    </article>
  );
}

function BlockFrame({
  kind,
  label,
  labelExtra,
  children,
}: {
  kind: string;
  label?: string;
  labelExtra?: ReactNode;
  children: ReactNode;
}): ReactNode {
  return (
    <article className={`block block-${kind}`}>
      <div className="role-bar" aria-hidden="true" />
      <div className="block-body">
        {label ? (
          <div className="block-label">
            <span>{label}</span>
            {labelExtra}
          </div>
        ) : null}
        {children}
      </div>
    </article>
  );
}

function ShellBlockView({ block }: { block: ShellBlock }): ReactNode {
  return (
    <article className="block block-shell" data-running={block.running}>
      <div className="role-bar" aria-hidden="true" />
      <div className="block-body">
        <div className="block-label">
          <span>shell</span>
          {block.excludeFromContext ? <span className="faint">excluded from context</span> : null}
          {block.exitCode !== null ? (
            <span className="shell-exit" data-ok={block.exitCode === 0}>
              exit {block.exitCode}
            </span>
          ) : null}
        </div>
        <pre className="shell-command">$ {block.command}</pre>
        {block.output.trim().length > 0 ? (
          looksLikeDiff(block.output) ? (
            <Diff text={block.output} />
          ) : (
            <pre className="tool-output">{block.output}</pre>
          )
        ) : (
          <p className="faint">{block.running ? '(running…)' : '(no output)'}</p>
        )}
        <div className="block-actions">
          <CopyButton text={block.command} label="command" />
          <CopyButton text={block.output} label="output" />
        </div>
      </div>
    </article>
  );
}
