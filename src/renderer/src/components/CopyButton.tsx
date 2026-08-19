import { useState, type ReactNode } from 'react';

export function CopyButton({ text, label }: { text: string; label: string }): ReactNode {
  const [copied, setCopied] = useState(false);

  const copy = (): void => {
    void navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      })
      .catch(() => undefined);
  };

  return (
    <button
      type="button"
      className="ghost-button"
      onClick={copy}
      title={`Copy ${label}`}
      disabled={text.length === 0}
    >
      {copied ? 'copied' : `copy ${label}`}
    </button>
  );
}
