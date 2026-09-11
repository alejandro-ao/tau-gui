import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useAutoScroll } from '../hooks/useAutoScroll.js';
import { useVirtualWindow } from '../hooks/useVirtualWindow.js';
import { groupBlocks, isExpanded, type BlockGroup } from '../state/reducer.js';
import { useStore } from '../state/store.js';
import type { TranscriptBlock } from '../state/types.js';
import { BlockView, SkillInvocationView } from './BlockView.js';
import { ToolGroupView } from './ToolGroupView.js';
import { Welcome } from './Welcome.js';

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
  const userGroupIndices = useMemo(
    () => groups.flatMap((group, index) => (userForGroup(group) === null ? [] : [index])),
    [groups],
  );
  const vwin = useVirtualWindow(ids, viewport, userGroupIndices);
  const signal = useMemo(() => streamSignal(visible), [visible]);
  const { atBottom, hasNewOutput, scrollToBottom } = useAutoScroll(viewport, signal);

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
  const [pinnedUserIndex, setPinnedUserIndex] = useState<number | null>(null);
  const pinnedUserIndexRef = useRef<number | null>(null);
  const [revealedUserIndex, setRevealedUserIndex] = useState<number | null>(null);
  const updatePinnedUser = useCallback(() => {
    const container = viewport.current;
    if (!container) return;
    const viewportTop = container.getBoundingClientRect().top;
    let candidate: number | null = null;
    for (const element of container.querySelectorAll<HTMLElement>('[data-user-group-index]')) {
      const index = Number(element.dataset.userGroupIndex);
      if (element.getBoundingClientRect().top < viewportTop - 1) candidate = index;
    }
    const previous = pinnedUserIndexRef.current;
    if (previous !== null && (candidate === null || candidate < previous)) {
      setRevealedUserIndex(previous);
    }
    pinnedUserIndexRef.current = candidate;
    setPinnedUserIndex((current) => (current === candidate ? current : candidate));
  }, []);

  useEffect(() => {
    const container = viewport.current;
    if (!container) return;
    container.addEventListener('scroll', updatePinnedUser, { passive: true });
    return () => container.removeEventListener('scroll', updatePinnedUser);
  }, [updatePinnedUser]);

  useEffect(() => updatePinnedUser(), [groups, updatePinnedUser, vwin.end, vwin.start]);

  useEffect(() => {
    if (revealedUserIndex === null) return;
    const timeout = window.setTimeout(() => setRevealedUserIndex(null), 360);
    return () => window.clearTimeout(timeout);
  }, [revealedUserIndex]);

  const pinnedUser = pinnedUserIndex === null ? null : userForGroup(groups[pinnedUserIndex]);

  return (
    <div className="transcript-wrap">
      {pinnedUser ? (
        <aside
          key={pinnedUser.id}
          className={
            pinnedUser.skill ? 'pinned-user-message pinned-skill-invocation' : 'pinned-user-message'
          }
          aria-label={
            pinnedUser.skill ? `Current skill ${pinnedUser.skill.name}` : 'Current user message'
          }
        >
          {pinnedUser.skill ? (
            <SkillInvocationView skill={pinnedUser.skill} />
          ) : (
            <pre>{pinnedUser.text}</pre>
          )}
        </aside>
      ) : null}
      <div className="transcript" ref={viewport} role="log" aria-label="transcript">
        <div style={{ height: vwin.topPad }} aria-hidden="true" />

        {state.sessionTransitioning ? (
          <ConversationSkeleton />
        ) : groups.length === 0 ? (
          <Welcome />
        ) : null}

        {mounted.map((group, offset) => {
          const index = vwin.start + offset;
          const key = ids[index];
          const user = userForGroup(group);
          return (
            <div key={key ?? index} ref={(element) => vwin.measure(index, element)}>
              {group.kind === 'user-tools' ? (
                <>
                  <div
                    className={revealedUserIndex === index ? 'user-message-reveal' : undefined}
                    data-user-group-index={index}
                  >
                    <BlockView
                      block={group.user}
                      expanded={expandedFor(group.user.id)}
                      onToggle={() => toggle(group.user.id)}
                    />
                  </div>
                  <ToolGroupView
                    blocks={group.blocks}
                    activity={group.activity}
                    turnStartedAt={group.startedAt}
                    turnEndedAt={group.endedAt}
                    expanded={expandedFor(`run-${group.user.id}`)}
                    onToggle={() => toggle(`run-${group.user.id}`)}
                    isBlockExpanded={expandedFor}
                    onToggleBlock={toggle}
                    settled={group.settled}
                    nested={!group.settled}
                  />
                </>
              ) : group.kind === 'tools' ? (
                <ToolGroupView
                  blocks={group.blocks}
                  activity={group.activity}
                  turnStartedAt={group.startedAt}
                  turnEndedAt={group.endedAt}
                  expanded={expandedFor(`run-${group.id}`)}
                  onToggle={() => toggle(`run-${group.id}`)}
                  isBlockExpanded={expandedFor}
                  onToggleBlock={toggle}
                  settled={group.settled}
                />
              ) : (
                <div
                  className={
                    user && revealedUserIndex === index ? 'user-message-reveal' : undefined
                  }
                  data-user-group-index={user ? index : undefined}
                >
                  <BlockView
                    block={group.block}
                    expanded={expandedFor(group.block.id)}
                    onToggle={() => toggle(group.block.id)}
                  />
                </div>
              )}
            </div>
          );
        })}

        <div style={{ height: vwin.bottomPad }} aria-hidden="true" />
      </div>

      {atBottom ? null : (
        <button
          type="button"
          className={
            hasNewOutput ? 'ghost-button new-output new-output-unread' : 'ghost-button new-output'
          }
          aria-label="Go to bottom"
          title="Go to bottom"
          onClick={() => scrollToBottom({ smooth: true })}
        >
          <span aria-hidden="true">↓</span>
        </button>
      )}
    </div>
  );
}

function ConversationSkeleton(): ReactNode {
  return (
    <div className="conversation-skeleton" role="status" aria-label="Loading conversation">
      <div className="skeleton-message skeleton-message-user" aria-hidden="true">
        <span className="skeleton-line skeleton-line-medium" />
        <span className="skeleton-line skeleton-line-short" />
      </div>
      <div className="skeleton-message skeleton-message-assistant" aria-hidden="true">
        <span className="skeleton-line skeleton-line-long" />
        <span className="skeleton-line skeleton-line-medium" />
        <span className="skeleton-line skeleton-line-short" />
      </div>
      <div className="skeleton-message skeleton-message-user" aria-hidden="true">
        <span className="skeleton-line skeleton-line-medium" />
      </div>
      <div className="skeleton-message skeleton-message-assistant" aria-hidden="true">
        <span className="skeleton-line skeleton-line-long" />
        <span className="skeleton-line skeleton-line-medium" />
      </div>
    </div>
  );
}

function userForGroup(
  group: BlockGroup | undefined,
): Extract<TranscriptBlock, { kind: 'user' }> | null {
  if (!group) return null;
  if (group.kind === 'user-tools') return group.user;
  return group.kind === 'single' && group.block.kind === 'user' ? group.block : null;
}

function groupId(group: BlockGroup, index: number): string {
  if (group.kind === 'user-tools') return group.user.id;
  if (group.kind === 'tools') return group.id || `group-${index}`;
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
