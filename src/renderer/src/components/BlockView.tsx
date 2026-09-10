import type { ReactNode } from 'react';
import { useElapsedSeconds } from '../hooks/useElapsed.js';
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
        <article className="block-notice" data-tone={block.tone}>
          <div className="notice-head">
            <span className="notice-marker" aria-hidden="true">
              {block.tone === 'warn' ? '!' : '·'}
            </span>
            <span>{block.tone === 'warn' ? 'warning' : 'status'}</span>
          </div>
          <p className="notice-text">{block.text}</p>
        </article>
      );

    case 'error':
      return (
        <article className="block-error">
          <div className="block-label">
            <span className="error-marker" aria-hidden="true">
              ×
            </span>
            <span>error</span>
          </div>
          <pre className="block-text">{block.text}</pre>
          <div className="block-actions">
            <CopyButton text={block.text} label="error" />
          </div>
        </article>
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

/**
 * A command the user ran from the composer (`!cmd`). It keeps the tool-block
 * typography — status marker, quiet lowercase label, code-styled boxes for
 * command and output — but without a colored rail, so it reads as quiet user
 * activity rather than a model tool call.
 */
function ShellBlockView({ block }: { block: ShellBlock }): ReactNode {
  const failed = block.exitCode !== null && block.exitCode !== 0;
  const state = block.running ? 'running' : failed ? 'error' : 'success';
  const elapsed = useElapsedSeconds(block.timestamp, block.running);

  return (
    <article className="block block-shell" data-state={state} data-running={block.running}>
      <div className="role-bar" aria-hidden="true" />
      <div className="block-body">
        <div className="shell-header">
          <span className="tool-marker" aria-hidden="true">
            {state === 'running' ? '◐' : state === 'error' ? '✕' : '●'}
          </span>
          <span className="block-label">shell</span>
          {block.excludeFromContext ? <span className="shell-flag">excluded from context</span> : null}
          {block.running ? (
            <span className="tool-elapsed">{elapsed}s</span>
          ) : block.exitCode !== null ? (
            <span className="shell-exit" data-ok={block.exitCode === 0}>
              exit {block.exitCode}
            </span>
          ) : null}
        </div>
        <pre className="shell-command">
          <span className="shell-prompt" aria-hidden="true">
            ${' '}
          </span>
          {block.command}
        </pre>
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
