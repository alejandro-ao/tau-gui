import { useMemo, type ReactNode } from 'react';
import { useStore } from '../../state/store.js';
import { buildCommands } from './commands.js';
import { Picker, type PickerItem } from './Picker.js';

/**
 * Commands, skills, and prompt templates discovered from the runtime.
 *
 * Accepting an entry sends its slash form as a prompt so the runtime performs
 * the expansion, exactly as Tau's TUI does.
 */
export function CommandsModal(): ReactNode {
  const { state, actions } = useStore();
  const commands = useMemo(() => buildCommands(state, actions), [state, actions]);

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
        const command = commands.find((candidate) => candidate.slash === `/${item.id}`);
        if (!command || command.unavailable) {
          actions.notice(
            command?.unavailable
              ? `${command.title} is unavailable: ${command.unavailable}`
              : `/${item.id} cannot be executed because the runtime RPC only lists it.`,
          );
          return;
        }
        command.run(`/${item.id}`);
      }}
    />
  );
}
