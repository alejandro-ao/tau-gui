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
 * Programmatic pins are tagged and retained while virtualized heights settle.
 * Scroll events can overlap those measurements, so settling is cancelled by
 * explicit reader input rather than by an intermediate scroll position.
 */
export function useAutoScroll(viewport: RefObject<HTMLElement | null>, signal: string): AutoScroll {
  const [atBottom, setAtBottom] = useState(true);
  const [hasNewOutput, setHasNewOutput] = useState(false);
  const atBottomRef = useRef(true);
  const expectedScroll = useRef<number | null>(null);
  const settlingFrame = useRef<number | null>(null);

  /** Scrolls to the tail, tagging the clamped position before assigning it. */
  const pin = useCallback((element: HTMLElement): number => {
    const target = Math.max(0, element.scrollHeight - element.clientHeight);
    if (element.scrollTop !== target) {
      expectedScroll.current = target;
      element.scrollTop = target;
    }
    return target;
  }, []);

  const stopSettling = useCallback((element?: HTMLElement) => {
    if (settlingFrame.current === null) return;
    element?.ownerDocument.defaultView?.cancelAnimationFrame(settlingFrame.current);
    settlingFrame.current = null;
    expectedScroll.current = null;
  }, []);

  /** Virtual rows replace estimates with measured heights after the send render.
      Re-pin for consecutive stable frames so overlapping scroll events cannot
      turn that measurement settling into a false user-scroll signal. */
  const settleAtBottom = useCallback(
    (element: HTMLElement): void => {
      stopSettling(element);
      const view = element.ownerDocument.defaultView;
      if (!view) {
        pin(element);
        return;
      }

      let previousTarget = pin(element);
      let stableFrames = 0;
      let frameCount = 0;
      const settle = (): void => {
        frameCount += 1;
        const target = pin(element);
        stableFrames =
          target === previousTarget && element.scrollTop === target ? stableFrames + 1 : 0;
        previousTarget = target;
        if (stableFrames >= 2 || frameCount >= 30) {
          settlingFrame.current = null;
          expectedScroll.current = null;
          return;
        }
        settlingFrame.current = view.requestAnimationFrame(settle);
      };
      settlingFrame.current = view.requestAnimationFrame(settle);
    },
    [pin, stopSettling],
  );

  const scrollToBottom = useCallback(() => {
    const element = viewport.current;
    if (element) settleAtBottom(element);
    atBottomRef.current = true;
    setAtBottom(true);
    setHasNewOutput(false);
  }, [settleAtBottom, viewport]);

  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const onScroll = (): void => {
      const target = Math.max(0, element.scrollHeight - element.clientHeight);
      const expected = expectedScroll.current;
      if (
        settlingFrame.current !== null ||
        (expected !== null && (element.scrollTop === expected || element.scrollTop === target))
      ) {
        // Programmatic pins can overlap while virtual heights settle. Keep the
        // tag until settling ends instead of letting the oldest event consume it.
        atBottomRef.current = true;
        setAtBottom(true);
        setHasNewOutput(false);
        return;
      }
      expectedScroll.current = null;
      stopSettling(element);
      const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
      const near = distance <= BOTTOM_THRESHOLD_PX;
      atBottomRef.current = near;
      setAtBottom(near);
      if (near) setHasNewOutput(false);
    };
    const stopForUserInput = (): void => stopSettling(element);
    element.addEventListener('scroll', onScroll, { passive: true });
    element.addEventListener('wheel', stopForUserInput, { passive: true });
    element.addEventListener('touchstart', stopForUserInput, { passive: true });
    element.addEventListener('pointerdown', stopForUserInput, { passive: true });
    return () => {
      stopSettling(element);
      element.removeEventListener('scroll', onScroll);
      element.removeEventListener('wheel', stopForUserInput);
      element.removeEventListener('touchstart', stopForUserInput);
      element.removeEventListener('pointerdown', stopForUserInput);
    };
  }, [stopSettling, viewport]);

  useEffect(() => {
    if (atBottomRef.current) {
      const element = viewport.current;
      if (element) settleAtBottom(element);
      setHasNewOutput(false);
    } else {
      setHasNewOutput(true);
    }
  }, [settleAtBottom, signal, viewport]);

  return { atBottom, hasNewOutput, scrollToBottom };
}
