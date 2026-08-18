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
 *
 * Heights are cached by item id, not list index: transcript items are inserted,
 * replaced, and filtered, so an index-keyed cache would attribute a measured
 * height to an unrelated block.
 */
export function useVirtualWindow(
  ids: string[],
  viewport: RefObject<HTMLElement | null>,
): VirtualWindow {
  const count = ids.length;
  const heights = useRef(new Map<string, number>());
  const idsRef = useRef(ids);
  idsRef.current = ids;
  const [range, setRange] = useState<Range>({ start: 0, end: count, topPad: 0, bottomPad: 0 });

  const heightAt = useCallback((index: number): number => {
    const id = idsRef.current[index];
    return (id === undefined ? undefined : heights.current.get(id)) ?? ESTIMATED_HEIGHT;
  }, []);

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
      const height = heightAt(index);
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
      // Everything sits above the window: mount the last item only, and keep its
      // own height out of the spacer that stands in for the items above it.
      start = Math.max(0, count - 1);
      topPad = count > 0 ? Math.max(0, offset - heightAt(count - 1)) : 0;
      end = count;
    }

    let bottomPad = 0;
    for (let index = end; index < count; index += 1) {
      bottomPad += heightAt(index);
    }

    setRange((previous) =>
      previous.start === start &&
      previous.end === end &&
      previous.topPad === topPad &&
      previous.bottomPad === bottomPad
        ? previous
        : { start, end, topPad, bottomPad },
    );
  }, [count, heightAt, viewport]);

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
      const id = idsRef.current[index];
      if (!element || id === undefined) return;
      const height = element.offsetHeight;
      // jsdom and pre-layout frames report 0; keep the estimate in that case.
      if (height <= 0) return;
      if (Math.abs((heights.current.get(id) ?? ESTIMATED_HEIGHT) - height) < 1) return;
      heights.current.set(id, height);
      recompute();
    },
    [recompute],
  );

  return { ...range, measure, recompute };
}
