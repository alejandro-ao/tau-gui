import { useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { useAutoScroll } from '../hooks/useAutoScroll.js';
import { useVirtualWindow } from '../hooks/useVirtualWindow.js';
import { groupBlocks, isExpanded, type BlockGroup } from '../state/reducer.js';
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

  // Stable per-group ids so measured heights survive insertions and filtering.
  const ids = useMemo(() => groups.map(groupId), [groups]);
  const vwin = useVirtualWindow(ids, viewport);
  const signal = useMemo(() => streamSignal(visible), [visible]);
  const { hasNewOutput, scrollToBottom } = useAutoScroll(viewport, signal);

  // Sending a message (or shell command) always jumps to the tail, even when
  // the reader has scrolled up; incoming runtime output alone never does.
  const sentCount = useMemo(
    () =>
      state.blocks.reduce(
        (count, block) => (block.kind === 'user' || block.kind === 'shell' ? count + 1 : count),
        0,
      ),
    [state.blocks],
  );
  const lastSentCount = useRef(sentCount);
  useEffect(() => {
    if (sentCount > lastSentCount.current) scrollToBottom();
    lastSentCount.current = sentCount;
  }, [sentCount, scrollToBottom]);

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

        {state.sessionTransitioning ? (
          <div className="thread-loading" role="status" aria-label="Loading thread">
            <span className="thread-loading-spinner" aria-hidden="true" />
          </div>
        ) : groups.length === 0 ? (
          <p className="transcript-empty">No messages yet. Type a prompt to start the session.</p>
        ) : null}

        {mounted.map((group, offset) => {
          const index = vwin.start + offset;
          const key = ids[index];
          return (
            <div key={key ?? index} ref={(element) => vwin.measure(index, element)}>
              {group.kind === 'user-tools' ? (
                <>
                  <BlockView
                    block={group.user}
                    expanded={expandedFor(group.user.id)}
                    onToggle={() => toggle(group.user.id)}
                  />
                  <ToolGroupView
                    blocks={group.blocks}
                    activity={group.activity}
                    turnStartedAt={group.startedAt}
                    expanded={expandedFor(`run-${group.user.id}`)}
                    onToggle={() => toggle(`run-${group.user.id}`)}
                    isBlockExpanded={expandedFor}
                    onToggleBlock={toggle}
                    settled={false}
                    nested
                  />
                </>
              ) : group.kind === 'tools' ? (
                <ToolGroupView
                  blocks={group.blocks}
                  activity={group.activity}
                  turnStartedAt={group.startedAt}
                  turnEndedAt={group.endedAt}
                  expanded={expandedFor(`run-${group.blocks[0]?.id ?? ''}`)}
                  onToggle={() => toggle(`run-${group.blocks[0]?.id ?? ''}`)}
                  isBlockExpanded={expandedFor}
                  onToggleBlock={toggle}
                  settled={group.settled}
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

function groupId(group: BlockGroup, index: number): string {
  if (group.kind === 'user-tools') return group.user.id;
  if (group.kind === 'tools') return group.blocks[0]?.id ?? `group-${index}`;
  return group.block.id;
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
