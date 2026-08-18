import { useEffect, useRef } from 'react';

export interface GlobalKeyHandlers {
  toggleExpandAll: () => void;
  toggleSidebar: () => void;
}

/**
 * Window-level shortcuts. Ctrl+C is deliberately not bound so native copy keeps
 * working whenever the user has a transcript selection.
 */
export function useGlobalKeys(handlers: GlobalKeyHandlers): void {
  const latest = useRef(handlers);
  latest.current = handlers;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!event.ctrlKey || event.metaKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === 'o') {
        event.preventDefault();
        latest.current.toggleExpandAll();
        return;
      }
      if (key === 'b') {
        event.preventDefault();
        latest.current.toggleSidebar();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
