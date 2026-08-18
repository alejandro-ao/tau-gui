import type { ReactNode } from 'react';
import { Markdown } from '../markdown.js';
import type { ShellBlock, TranscriptBlock } from '../state/types.js';
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
        <BlockFrame kind="user" label="you">
          <pre className="block-text">{block.text}</pre>
          <div className="block-actions">
            <CopyButton text={block.text} label="message" />
          </div>
        </BlockFrame>
      );

    case 'assistant':
      return (
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
          <div className="block-actions">
            <CopyButton text={block.text} label="message" />
          </div>
        </BlockFrame>
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
      return (
        <BlockFrame
          kind={block.kind}
          label={block.kind === 'branch' ? 'branch summary' : 'compaction'}
        >
          <Markdown text={block.summary} />
          {block.detail ? <p className="summary-detail">{block.detail}</p> : null}
        </BlockFrame>
      );
  }
}

function BlockFrame({
  kind,
  label,
  labelExtra,
  children,
}: {
  kind: string;
  label: string;
  labelExtra?: ReactNode;
  children: ReactNode;
}): ReactNode {
  return (
    <article className={`block block-${kind}`}>
      <div className="role-bar" aria-hidden="true" />
      <div className="block-body">
        <div className="block-label">
          <span>{label}</span>
          {labelExtra}
        </div>
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
