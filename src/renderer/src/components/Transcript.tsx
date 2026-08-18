import { useCallback, useMemo, useRef, type ReactNode } from 'react';
import { useAutoScroll } from '../hooks/useAutoScroll.js';
import { useVirtualWindow } from '../hooks/useVirtualWindow.js';
import { groupBlocks, isExpanded } from '../state/reducer.js';
import { useStore } from '../state/store.js';
import type { TranscriptBlock } from '../state/types.js';
import { BlockView } from './BlockView.js';
import { ToolGroupView } from './ToolGroupView.js';

export function Transcript(): ReactNode {
  const { state, dispatch } = useStore();
  const viewport = useRef<HTMLDivElement | null>(null);

  const visible = useMemo(
    () =>
      state.settings.showThinking
        ? state.blocks
        : state.blocks.filter((block) => block.kind !== 'thinking'),
    [state.blocks, state.settings.showThinking],
  );
  const groups = useMemo(() => groupBlocks(visible), [visible]);

  const vwin = useVirtualWindow(groups.length, viewport);
  const signal = useMemo(() => streamSignal(visible), [visible]);
  const { hasNewOutput, scrollToBottom } = useAutoScroll(viewport, signal);

  const toggle = useCallback((id: string) => dispatch({ type: 'toggleExpanded', id }), [dispatch]);
  const expandedFor = useCallback((id: string) => isExpanded(state, id), [state]);

  const mounted = groups.slice(vwin.start, vwin.end);

  return (
    <div className="transcript-wrap">
      <div className="transcript" ref={viewport} role="log" aria-label="transcript">
        {vwin.start > 0 ? (
          <div className="boundary" data-edge="top">
            ── older output above ({vwin.start}) ──
          </div>
        ) : null}
        <div style={{ height: vwin.topPad }} aria-hidden="true" />

        {groups.length === 0 ? (
          <p className="transcript-empty">No messages yet. Type a prompt to start the session.</p>
        ) : null}

        {mounted.map((group, offset) => {
          const index = vwin.start + offset;
          const key = group.kind === 'tools' ? group.blocks[0]?.id : group.block.id;
          return (
            <div key={key ?? index} ref={(element) => vwin.measure(index, element)}>
              {group.kind === 'tools' ? (
                <ToolGroupView
                  name={group.name}
                  blocks={group.blocks}
                  expanded={expandedFor(group.blocks[0]?.id ?? '')}
                  onToggle={() => toggle(group.blocks[0]?.id ?? '')}
                  isBlockExpanded={expandedFor}
                  onToggleBlock={toggle}
                />
              ) : (
                <BlockView
                  block={group.block}
                  expanded={expandedFor(group.block.id)}
                  onToggle={() => toggle(group.block.id)}
                />
              )}
            </div>
          );
        })}

        <div style={{ height: vwin.bottomPad }} aria-hidden="true" />
        {vwin.end < groups.length ? (
          <div className="boundary" data-edge="bottom">
            ── newer output below ({groups.length - vwin.end}) ──
          </div>
        ) : null}
      </div>

      {hasNewOutput ? (
        <button type="button" className="ghost-button new-output" onClick={scrollToBottom}>
          new output ↓
        </button>
      ) : null}
    </div>
  );
}

/** Cheap fingerprint of the transcript tail, used to drive scroll anchoring. */
function streamSignal(blocks: TranscriptBlock[]): string {
  const last = blocks.at(-1);
  if (!last) return '0';
  const size =
    'text' in last
      ? last.text.length
      : 'output' in last
        ? last.output.length
        : 'summary' in last
          ? last.summary.length
          : 0;
  return `${blocks.length}:${last.id}:${size}`;
}
