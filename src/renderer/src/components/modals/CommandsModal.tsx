import { useMemo, type ReactNode } from 'react';
import { useStore } from '../../state/store.js';
import { buildCommands } from './commands.js';
import { Picker, type PickerItem } from './Picker.js';

/**
 * Commands and prompt templates discovered from the active agent service.
 * Entries execute only when the desktop command registry provides a handler.
 */
export function CommandsModal(): ReactNode {
  const { state, actions } = useStore();
  const commands = useMemo(() => buildCommands(state, actions), [state, actions]);

  const items = useMemo<PickerItem[]>(
    () =>
      state.commands.map((command) => {
        const registered = commands.find((candidate) => candidate.slash === `/${command.name}`);
        return {
          id: command.name,
          label: `/${command.name}`,
          detail: command.description,
          badge: registered?.unavailable ? 'unavailable' : null,
          reason: registered?.unavailable,
          keywords: command.description,
        };
      }),
    [commands, state.commands],
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
              : `/${item.id} cannot be executed because the desktop application contract only lists it.`,
          );
          return;
        }
        command.run(`/${item.id}`);
      }}
    />
  );
}
