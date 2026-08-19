import { useMemo, type ReactNode } from 'react';
import { useStore } from '../../state/store.js';
import { Picker, type PickerItem } from './Picker.js';

/**
 * Commands, skills, and prompt templates discovered from the runtime.
 *
 * Accepting an entry sends its slash form as a prompt so the runtime performs
 * the expansion, exactly as Tau's TUI does.
 */
export function CommandsModal(): ReactNode {
  const { state, actions } = useStore();

  const items = useMemo<PickerItem[]>(
    () =>
      state.commands.map((command) => ({
        id: command.name,
        label: `/${command.name}`,
        detail: command.description,
        badge: command.source === 'runtime' ? 'backend' : 'frontend',
        keywords: command.description,
      })),
    [state.commands],
  );

  return (
    <Picker
      name="commands"
      title="runtime commands"
      subtitle="skills and prompt templates appear here when the runtime reports them"
      items={items}
      emptyLabel="the runtime reported no commands"
      onClose={() => actions.openModal(null)}
      onAccept={(item) => {
        actions.openModal(null);
        void actions.submit(`/${item.id}`);
      }}
    />
  );
}
