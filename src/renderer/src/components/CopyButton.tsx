import { useState, type ReactNode } from 'react';
import { invoke } from '../bridge.js';

export function CopyButton({ text, label }: { text: string; label: string }): ReactNode {
  const [copied, setCopied] = useState(false);

  const copy = (): void => {
    void invoke('ui.copyText', { text })
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      })
      .catch(() => undefined);
  };

  const accessibleLabel = copied ? `Copied ${label}` : `Copy ${label}`;

  return (
    <button
      type="button"
      className="ghost-button copy-button"
      onClick={copy}
      title={accessibleLabel}
      aria-label={accessibleLabel}
      disabled={text.length === 0}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </button>
  );
}

function CopyIcon(): ReactNode {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <rect x="5.5" y="5.5" width="8" height="8" rx="1" />
      <path d="M3.5 10.5h-1a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1v1" />
    </svg>
  );
}

function CheckIcon(): ReactNode {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="m2.5 8.5 3.5 3.5 7.5-8" />
    </svg>
  );
}
