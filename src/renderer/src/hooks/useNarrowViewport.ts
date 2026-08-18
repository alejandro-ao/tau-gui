import { useEffect, useState } from 'react';

/** True while the window is at or below `maxWidth`, using matchMedia when available. */
export function useNarrowViewport(maxWidth = 900): boolean {
  const [narrow, setNarrow] = useState(() => measure(maxWidth));

  useEffect(() => {
    const query = window.matchMedia?.(`(max-width: ${maxWidth}px)`);
    const update = (): void => setNarrow(query ? query.matches : measure(maxWidth));
    update();
    if (query?.addEventListener) {
      query.addEventListener('change', update);
      return () => query.removeEventListener('change', update);
    }
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [maxWidth]);

  return narrow;
}

function measure(maxWidth: number): boolean {
  return typeof window !== 'undefined' && window.innerWidth > 0 && window.innerWidth <= maxWidth;
}
