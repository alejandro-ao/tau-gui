import type { ReactNode } from 'react';
import { useStore } from '../../state/store.js';
import { CopyButton } from '../CopyButton.js';
import { Modal } from './Modal.js';

/** Local-only system-prompt inspection. Content never enters transcript/session state. */
export function SystemPromptModal(): ReactNode {
  const { state, actions } = useStore();
  const inspection = state.systemPromptInspection;
  const text = inspection?.text ?? '';

  return (
    <Modal
      name="system"
      title="system prompt"
      subtitle="local-only active Pi state; never sent to the model or stored in the session"
      onClose={() => actions.openModal(null)}
      footer={<CopyButton text={text} label="system prompt" />}
    >
      {inspection ? (
        <>
          <p className="modal-note introspection-summary">
            {inspection.origin} · {inspection.totalCharacters.toLocaleString()} characters
            {inspection.truncated ? ' · display truncated' : ''}
          </p>
          <pre className="introspection-output">{text}</pre>
        </>
      ) : (
        <p className="picker-empty">system prompt unavailable</p>
      )}
    </Modal>
  );
}
