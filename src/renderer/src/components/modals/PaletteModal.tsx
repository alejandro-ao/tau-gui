import { useMemo, type ReactNode } from 'react';
import { useStore } from '../../state/store.js';
import { Picker, type PickerItem } from './Picker.js';
import { buildCommands, buildPaletteExtras, type AppCommand } from './commands.js';

/** Ctrl+K palette merging runtime commands, GUI commands, and quick settings. */
export function PaletteModal(): ReactNode {
  const { state, actions } = useStore();

  const commands = useMemo<AppCommand[]>(
    () => [...buildCommands(state, actions), ...buildPaletteExtras(state, actions)],
    [state, actions],
  );

  const items = useMemo<PickerItem[]>(
    () =>
      commands.map((command) => ({
        id: command.id,
        label: command.title,
        detail: command.description,
        badge: command.unavailable ? 'unavailable' : command.origin,
        reason: command.unavailable,
        keywords: `${command.group} ${command.description} ${command.slash ?? ''}`,
      })),
    [commands],
  );

  return (
    <Picker
      name="palette"
      title="command palette"
      subtitle="backend entries need the runtime · frontend entries are local to this app"
      placeholder="search commands, models, themes, sessions…"
      items={items}
      emptyLabel="no matching command"
      onClose={() => actions.openModal(null)}
      onAccept={(item) => {
        const command = commands.find((candidate) => candidate.id === item.id);
        if (!command) return;
        if (command.unavailable) {
          actions.notice(`${command.title} is unavailable: ${command.unavailable}`);
          return;
        }
        actions.openModal(null);
        command.run();
      }}
    />
  );
}
