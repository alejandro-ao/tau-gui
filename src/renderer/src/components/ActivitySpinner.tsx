import type { ReactNode } from 'react';

const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function ActivitySpinner(): ReactNode {
  return (
    <span className="activity-spinner" role="status" aria-label="Model working">
      {frames.map((frame) => (
        <span key={frame} className="activity-spinner-frame" aria-hidden="true">
          {frame}
        </span>
      ))}
    </span>
  );
}
