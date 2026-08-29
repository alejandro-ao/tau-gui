import { useEffect, useState, type ReactNode } from 'react';
import { useStore } from '../../state/store.js';
import { Modal } from './Modal.js';

export function ExtensionDialogModal(): ReactNode {
  const { state, actions } = useStore();
  const dialog = state.extensionDialog;
  const [value, setValue] = useState('');

  useEffect(() => {
    setValue(dialog && 'initialValue' in dialog ? dialog.initialValue : '');
  }, [dialog]);

  if (!dialog) return null;
  const close = (response: string | boolean | null): void => {
    void actions.respondExtensionDialog(dialog.requestId, response);
  };

  return (
    <Modal
      name="extensionDialog"
      title={dialog.title || 'extension request'}
      subtitle="isolated extension UI request"
      onClose={() => close(null)}
    >
      {dialog.kind === 'select' ? (
        <div className="extension-dialog-options">
          {dialog.options.map((option) => (
            <button type="button" key={option.id} onClick={() => close(option.id)}>
              {option.label}
              {option.description ? <small>{option.description}</small> : null}
            </button>
          ))}
        </div>
      ) : null}
      {dialog.kind === 'confirm' ? (
        <div className="extension-dialog-form">
          <p>{dialog.message}</p>
          <div className="settings-inline">
            <button type="button" onClick={() => close(true)}>
              confirm
            </button>
            <button type="button" className="ghost-button" onClick={() => close(false)}>
              cancel
            </button>
          </div>
        </div>
      ) : null}
      {dialog.kind === 'input' || dialog.kind === 'editor' ? (
        <div className="extension-dialog-form">
          <label htmlFor="extension-dialog-value">{dialog.message}</label>
          {dialog.kind === 'editor' ? (
            <textarea
              id="extension-dialog-value"
              value={value}
              maxLength={100_000}
              onChange={(event) => setValue(event.target.value)}
            />
          ) : (
            <input
              id="extension-dialog-value"
              value={value}
              maxLength={4_096}
              placeholder={dialog.placeholder ?? undefined}
              onChange={(event) => setValue(event.target.value)}
            />
          )}
          <button type="button" onClick={() => close(value)}>
            submit
          </button>
        </div>
      ) : null}
    </Modal>
  );
}
