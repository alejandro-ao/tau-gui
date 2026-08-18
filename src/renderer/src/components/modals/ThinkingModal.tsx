import type { ReactNode } from 'react';
import type { ThinkingLevel } from '../../../../shared/domain.js';
import { useStore } from '../../state/store.js';
import { Picker, type PickerItem } from './Picker.js';

/** Thinking-level picker built from the levels the runtime reports. */
export function ThinkingModal(): ReactNode {
  const { state, actions } = useStore();
  const levels = state.thinkingLevels;
  const active = state.agent?.thinkingLevel ?? null;

  const items: PickerItem[] = levels.map((level) => ({
    id: level,
    label: level,
    current: level === active,
  }));

  return (
    <Picker
      name="thinking"
      title="thinking levels"
      subtitle={
        levels.length === 0
          ? 'the runtime reported no levels, which means the active model has no reasoning support'
          : 'Shift+Tab cycles levels · Ctrl+T toggles thinking visibility'
      }
      items={items}
      emptyLabel="no thinking levels for this model"
      onClose={() => actions.openModal(null)}
      onAccept={(item) => {
        actions.openModal(null);
        void actions.setThinking(item.id as ThinkingLevel);
      }}
    />
  );
}
