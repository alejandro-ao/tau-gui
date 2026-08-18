import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

export interface VirtualWindow {
  /** First mounted index. */
  start: number;
  /** One past the last mounted index. */
  end: number;
  topPad: number;
  bottomPad: number;
  measure: (index: number, element: HTMLElement | null) => void;
  recompute: () => void;
}

const ESTIMATED_HEIGHT = 140;
const FALLBACK_VIEWPORT = 800;
const OVERSCAN_PX = 1200;

interface Range {
  start: number;
  end: number;
  topPad: number;
  bottomPad: number;
}

/**
 * Windowing over measured item heights. Only items near the viewport are
 * mounted; state is never trimmed, and spacer padding preserves scroll height.
 */
export function useVirtualWindow(
  count: number,
  viewport: RefObject<HTMLElement | null>,
): VirtualWindow {
  const heights = useRef<number[]>([]);
  const [range, setRange] = useState<Range>({ start: 0, end: count, topPad: 0, bottomPad: 0 });

  const recompute = useCallback(() => {
    const element = viewport.current;
    const scrollTop = element?.scrollTop ?? 0;
    const clientHeight =
      element && element.clientHeight > 0 ? element.clientHeight : FALLBACK_VIEWPORT;
    const windowTop = Math.max(0, scrollTop - OVERSCAN_PX);
    const windowBottom = scrollTop + clientHeight + OVERSCAN_PX;

    let offset = 0;
    let start = 0;
    let end = count;
    let topPad = 0;
    let startFound = false;

    for (let index = 0; index < count; index += 1) {
      const height = heights.current[index] ?? ESTIMATED_HEIGHT;
      if (!startFound && offset + height >= windowTop) {
        start = index;
        topPad = offset;
        startFound = true;
      }
      if (startFound && offset > windowBottom) {
        end = index;
        break;
      }
      offset += height;
    }
    if (!startFound) {
      start = Math.max(0, count - 1);
      topPad = offset;
      end = count;
    }

    let bottomPad = 0;
    for (let index = end; index < count; index += 1) {
      bottomPad += heights.current[index] ?? ESTIMATED_HEIGHT;
    }

    setRange((previous) =>
      previous.start === start &&
      previous.end === end &&
      previous.topPad === topPad &&
      previous.bottomPad === bottomPad
        ? previous
        : { start, end, topPad, bottomPad },
    );
  }, [count, viewport]);

  useEffect(() => {
    recompute();
  }, [recompute]);

  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    element.addEventListener('scroll', recompute, { passive: true });
    return () => element.removeEventListener('scroll', recompute);
  }, [recompute, viewport]);

  const measure = useCallback(
    (index: number, element: HTMLElement | null) => {
      if (!element) return;
      const height = element.offsetHeight;
      // jsdom and pre-layout frames report 0; keep the estimate in that case.
      if (height <= 0) return;
      if (Math.abs((heights.current[index] ?? ESTIMATED_HEIGHT) - height) < 1) return;
      heights.current[index] = height;
      recompute();
    },
    [recompute],
  );

  return { ...range, measure, recompute };
}
