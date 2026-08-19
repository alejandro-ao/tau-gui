import type { ReactNode } from 'react';
import type { ThemeName } from '../../../../shared/domain.js';
import { useStore } from '../../state/store.js';
import { Picker, type PickerItem } from './Picker.js';

const THEMES: { name: ThemeName; description: string }[] = [
  { name: 'tau-dark', description: 'Tau dark palette' },
  { name: 'tau-light', description: 'Tau light palette' },
  { name: 'high-contrast', description: 'High contrast palette' },
];

/** Local theme picker; themes are GUI-owned and never sent to the runtime. */
export function ThemeModal(): ReactNode {
  const { state, actions } = useStore();

  const items: PickerItem[] = THEMES.map((theme) => ({
    id: theme.name,
    label: theme.name,
    detail: theme.description,
    current: state.settings.theme === theme.name,
  }));

  return (
    <Picker
      name="theme"
      title="themes"
      subtitle="stored in GUI settings, independent from Tau/Pi TUI configuration"
      items={items}
      onClose={() => actions.openModal(null)}
      onAccept={(item) => {
        actions.openModal(null);
        void actions.updateSettings({ theme: item.id });
      }}
    />
  );
}
