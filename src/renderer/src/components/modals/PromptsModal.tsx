import { type ReactNode } from 'react';
import { useStore } from '../../state/store.js';
import { Picker, type PickerItem } from './Picker.js';

/** Search loaded Tau prompt templates and insert their slash invocation. */
export function PromptsModal(): ReactNode {
  const { state, actions } = useStore();
  const items: PickerItem[] = state.resources.prompts.map((prompt) => ({
    id: prompt.name,
    label: `/${prompt.name}`,
    detail: prompt.description,
    hint: prompt.origin,
    badge: 'prompt',
    keywords: `${prompt.description ?? ''} ${prompt.origin}`,
  }));

  return (
    <Picker
      name="prompts"
      title="prompt templates"
      subtitle="Enter inserts the template invocation; add arguments in the composer"
      placeholder="search names and descriptions…"
      items={items}
      emptyLabel="no Tau prompt templates loaded"
      onClose={() => actions.openModal(null)}
      onAccept={(item) => {
        actions.setDraft(`/${item.id} `);
        actions.openModal(null);
      }}
    />
  );
}
