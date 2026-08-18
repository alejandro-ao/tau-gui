import { useEffect, useState } from 'react';

/** Whole seconds since `startedAt`, ticking only while `active`. */
export function useElapsedSeconds(startedAt: number, active: boolean): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [active, startedAt]);

  return Math.max(0, Math.floor((now - startedAt) / 1000));
}
