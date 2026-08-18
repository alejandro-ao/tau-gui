import {
  useCallback,
  useEffect,
  useRef,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';

const FOCUSABLE =
  'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

export interface ModalProps {
  /** Stable id used for aria wiring and test selectors. */
  name: string;
  title: string;
  subtitle?: string | null;
  onClose: () => void;
  footer?: ReactNode;
  children: ReactNode;
}

/**
 * Accessible modal shell shared by every picker.
 *
 * Escape cancels, Tab is trapped inside the dialog, and the container is marked
 * `data-modal` so the composer does not steal focus back on window clicks.
 */
export function Modal({ name, title, subtitle, onClose, footer, children }: ModalProps): ReactNode {
  const dialog = useRef<HTMLDivElement | null>(null);
  const titleId = `modal-title-${name}`;
  const descriptionId = `modal-description-${name}`;

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    // Pickers mark their filter input so the keyboard lands where users type.
    const target =
      element.querySelector<HTMLElement>('[data-autofocus="true"]') ??
      element.querySelector<HTMLElement>(FOCUSABLE);
    (target ?? element).focus();
  }, []);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const element = dialog.current;
      if (!element) return;
      const focusable = [...element.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      const active = element.ownerDocument.activeElement;
      if (event.shiftKey && (active === first || active === element)) {
        event.preventDefault();
        last.focus();
        return;
      }
      if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [onClose],
  );

  return (
    <div
      className="modal-backdrop"
      data-testid={`modal-${name}`}
      onMouseDown={backdropClose(onClose)}
    >
      <div
        className="modal"
        data-modal="true"
        data-modal-name={name}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={subtitle ? descriptionId : undefined}
        tabIndex={-1}
        ref={dialog}
        onKeyDown={onKeyDown}
      >
        <header className="modal-header">
          <h2 id={titleId}>{title}</h2>
          <button
            type="button"
            className="ghost-button"
            onClick={onClose}
            aria-label="close dialog"
          >
            esc
          </button>
        </header>
        {subtitle ? (
          <p className="modal-subtitle" id={descriptionId}>
            {subtitle}
          </p>
        ) : null}
        <div className="modal-body">{children}</div>
        {footer ? <footer className="modal-footer">{footer}</footer> : null}
      </div>
    </div>
  );
}

/** Clicking the backdrop cancels, matching Escape. */
function backdropClose(onClose: () => void) {
  return (event: MouseEvent<HTMLDivElement>): void => {
    if (event.target === event.currentTarget) onClose();
  };
}
