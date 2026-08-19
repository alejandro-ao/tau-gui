import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

export interface AutoScroll {
  atBottom: boolean;
  hasNewOutput: boolean;
  scrollToBottom: () => void;
}

const BOTTOM_THRESHOLD_PX = 80;

/**
 * Scroll anchoring for streaming output: follow the tail only while the reader
 * is already near the bottom, otherwise surface a jump-to-bottom affordance.
 *
 * Programmatic pins are tagged with their target scrollTop: the pin's own
 * scroll event can arrive after virtualized tail blocks mount and the real
 * scrollHeight outgrows the estimate the pin was aimed at. Judging that late
 * event by distance would mistake settling for a user scroll and break the
 * follow, so an event landing exactly on the tagged position always keeps it.
 */
export function useAutoScroll(viewport: RefObject<HTMLElement | null>, signal: string): AutoScroll {
  const [atBottom, setAtBottom] = useState(true);
  const [hasNewOutput, setHasNewOutput] = useState(false);
  const atBottomRef = useRef(true);
  const expectedScroll = useRef<number | null>(null);

  /** Scrolls to the tail, tagging the target only when the position actually
      changes — a no-op pin must not leave a stale tag for a later user scroll. */
  const pin = useCallback((element: HTMLElement): void => {
    // scrollTop is clamped to this maximum by the browser. Tagging scrollHeight
    // itself makes the resulting scroll event look user-originated once tail
    // measurements grow, which can strand a newly sent message under the composer.
    const target = Math.max(0, element.scrollHeight - element.clientHeight);
    if (element.scrollTop === target) return;
    element.scrollTop = target;
    expectedScroll.current = target;
  }, []);

  const scrollToBottom = useCallback(() => {
    const element = viewport.current;
    if (element) pin(element);
    atBottomRef.current = true;
    setAtBottom(true);
    setHasNewOutput(false);
  }, [pin, viewport]);

  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const onScroll = (): void => {
      const expected = expectedScroll.current;
      expectedScroll.current = null;
      if (expected !== null && element.scrollTop === expected) {
        // Our own pin; heights may still be settling around it. Keep following.
        atBottomRef.current = true;
        setAtBottom(true);
        setHasNewOutput(false);
        return;
      }
      const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
      const near = distance <= BOTTOM_THRESHOLD_PX;
      atBottomRef.current = near;
      setAtBottom(near);
      if (near) setHasNewOutput(false);
    };
    element.addEventListener('scroll', onScroll, { passive: true });
    return () => element.removeEventListener('scroll', onScroll);
  }, [viewport]);

  useEffect(() => {
    if (atBottomRef.current) {
      const element = viewport.current;
      if (element) pin(element);
      setHasNewOutput(false);
    } else {
      setHasNewOutput(true);
    }
  }, [pin, signal, viewport]);

  return { atBottom, hasNewOutput, scrollToBottom };
}
