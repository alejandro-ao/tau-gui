import type { ReactNode } from 'react';
import { useStore } from '../../state/store.js';
import { Modal } from './Modal.js';

const SHORTCUTS: { keys: string; description: string }[] = [
  { keys: 'Enter', description: 'send now, or queue priority guidance during a run' },
  { keys: 'Shift+Enter', description: 'newline in the composer' },
  { keys: 'Alt+Enter', description: 'queue a follow-up' },
  { keys: 'Esc', description: 'close the top modal, otherwise abort the active run' },
  { keys: 'Up (empty composer)', description: 'remove and edit the newest queued prompt' },
  { keys: 'Ctrl+C', description: 'clear the composer (never while text is selected)' },
  { keys: 'Cmd/Ctrl+Z', description: 'undo composer editing' },
  { keys: 'Cmd+Shift+Z / Ctrl+Y', description: 'redo composer editing' },
  { keys: 'Ctrl+K', description: 'command palette' },
  { keys: 'Ctrl+O', description: 'expand or collapse every block' },
  { keys: 'Ctrl+P', description: 'cycle model' },
  { keys: 'Shift+Tab', description: 'cycle thinking level' },
  { keys: 'Ctrl+T', description: 'toggle thinking visibility' },
  { keys: 'Ctrl+B', description: 'toggle the session sidebar' },
  { keys: 'Shift+Ctrl+N', description: 'choose a directory for a new session' },
  { keys: 'Ctrl+R', description: 'restart the runtime' },
  { keys: '/', description: 'slash command completion in the composer' },
  { keys: '@', description: 'file path completion in the composer' },
  { keys: '! / !!', description: 'direct shell command, with or without context' },
];

/** Local shortcut reference. */
export function HotkeysModal(): ReactNode {
  const { actions } = useStore();
  return (
    <Modal
      name="hotkeys"
      title="keyboard shortcuts"
      subtitle="all shortcuts are handled locally by the desktop app"
      onClose={() => actions.openModal(null)}
    >
      <dl className="hotkey-list">
        {SHORTCUTS.map((shortcut) => (
          <div className="hotkey-row" key={shortcut.keys}>
            <dt>{shortcut.keys}</dt>
            <dd>{shortcut.description}</dd>
          </div>
        ))}
      </dl>
    </Modal>
  );
}
