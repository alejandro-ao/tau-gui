import { useEffect, type ReactNode } from 'react';
import { useStore } from '../../state/store.js';
import { CopyButton } from '../CopyButton.js';
import { Modal } from './Modal.js';

/** Bounded diagnostics list from the main process plus renderer notices. */
export function DiagnosticsModal(): ReactNode {
  const { state, actions } = useStore();

  useEffect(() => {
    void actions.loadDiagnostics();
  }, [actions]);

  const diagnostics = [...state.diagnostics, ...state.resources.diagnostics];
  const text = diagnostics.join('\n');

  return (
    <Modal
      name="diagnostics"
      title="diagnostics"
      subtitle="bounded runtime and application diagnostics; credentials are never recorded"
      onClose={() => actions.openModal(null)}
      footer={<CopyButton text={text} label="diagnostics" />}
    >
      {diagnostics.length === 0 ? (
        <p className="picker-empty">no diagnostics recorded</p>
      ) : (
        <ul className="diagnostic-list">
          {diagnostics.map((message, index) => (
            <li key={`${index}-${message}`}>{message}</li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
