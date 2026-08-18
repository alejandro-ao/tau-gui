import { useEffect, useRef } from 'react';
import { platform } from '../bridge.js';

export interface GlobalKeyHandlers {
  openPalette: () => void;
  closeModal: () => void;
  modalOpen: boolean;
  toggleExpandAll: () => void;
  toggleSidebar: () => void;
  cycleModel: () => void;
  cycleThinking: () => void;
  toggleThinking: () => void;
  newSession: () => void;
  restart: () => void;
}

/**
 * Window-level shortcuts.
 *
 * Ctrl+C is deliberately not bound so native copy keeps working whenever the
 * user has a transcript selection. Escape only closes the top modal here; the
 * composer keeps ownership of Escape-aborts while no modal is open. On macOS the
 * Cmd modifier is accepted alongside Ctrl.
 */
export function useGlobalKeys(handlers: GlobalKeyHandlers): void {
  const latest = useRef(handlers);
  latest.current = handlers;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const current = latest.current;

      if (event.key === 'Escape') {
        if (!current.modalOpen) return;
        event.preventDefault();
        current.closeModal();
        return;
      }

      if (event.key === 'Tab' && event.shiftKey && !event.ctrlKey && !event.metaKey) {
        // Reverse tab navigation stays intact unless the composer (or nothing in
        // particular) owns focus, so buttons and pickers keep normal behavior.
        if (current.modalOpen || !ownsGlobalTab(event.target)) return;
        event.preventDefault();
        current.cycleThinking();
        return;
      }

      const accelerator = event.ctrlKey || (isMac() && event.metaKey);
      if (!accelerator || event.altKey) return;
      const key = event.key.toLowerCase();

      if (key === 'k') {
        event.preventDefault();
        current.openPalette();
        return;
      }
      // Remaining shortcuts stay out of the way while a modal owns the keyboard.
      if (current.modalOpen) return;

      switch (key) {
        case 'o':
          event.preventDefault();
          current.toggleExpandAll();
          return;
        case 'b':
          event.preventDefault();
          current.toggleSidebar();
          return;
        case 'p':
          event.preventDefault();
          current.cycleModel();
          return;
        case 't':
          event.preventDefault();
          current.toggleThinking();
          return;
        case 'n':
          event.preventDefault();
          current.newSession();
          return;
        case 'r':
          event.preventDefault();
          current.restart();
          return;
        default:
          return;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}

function isMac(): boolean {
  return platform() === 'darwin';
}

/** True when Shift+Tab is not being used for focus movement. */
function ownsGlobalTab(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return true;
  if (target === target.ownerDocument.body) return true;
  return target.classList.contains('composer-input');
}
