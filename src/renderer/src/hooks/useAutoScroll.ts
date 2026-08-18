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
 */
export function useAutoScroll(viewport: RefObject<HTMLElement | null>, signal: string): AutoScroll {
  const [atBottom, setAtBottom] = useState(true);
  const [hasNewOutput, setHasNewOutput] = useState(false);
  const atBottomRef = useRef(true);

  const scrollToBottom = useCallback(() => {
    const element = viewport.current;
    if (element) element.scrollTop = element.scrollHeight;
    atBottomRef.current = true;
    setAtBottom(true);
    setHasNewOutput(false);
  }, [viewport]);

  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const onScroll = (): void => {
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
      if (element) element.scrollTop = element.scrollHeight;
      setHasNewOutput(false);
    } else {
      setHasNewOutput(true);
    }
  }, [signal, viewport]);

  return { atBottom, hasNewOutput, scrollToBottom };
}
