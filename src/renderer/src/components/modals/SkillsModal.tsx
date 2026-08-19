import { type ReactNode } from 'react';
import { useStore } from '../../state/store.js';
import { Picker, type PickerItem } from './Picker.js';

/** Search loaded Tau skills and insert an explicit invocation into the composer. */
export function SkillsModal(): ReactNode {
  const { state, actions } = useStore();
  const items: PickerItem[] = state.resources.skills.map((skill) => ({
    id: skill.name,
    label: skill.name,
    detail: skill.description,
    hint: skill.origin,
    badge: skill.disableModelInvocation ? 'user only' : 'skill',
    keywords: `${skill.description ?? ''} ${skill.origin}`,
  }));

  return (
    <Picker
      name="skills"
      title="skills"
      subtitle="Enter inserts /skill:<name>; add your request in the composer"
      placeholder="search names and descriptions…"
      items={items}
      emptyLabel="no Tau skills loaded"
      onClose={() => actions.openModal(null)}
      onAccept={(item) => {
        actions.setDraft(`/skill:${item.id} `);
        actions.openModal(null);
      }}
    />
  );
}
