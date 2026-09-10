import { useEffect, useState, type ReactNode } from 'react';

const ANIMATION_MS = 180;

/** Keeps closing content mounted just long enough for a smooth height transition. */
export function AnimatedCollapse({
  open,
  className = '',
  children,
}: {
  open: boolean;
  className?: string;
  children: ReactNode;
}): ReactNode {
  const [present, setPresent] = useState(open);

  useEffect(() => {
    if (open) {
      setPresent(true);
      return undefined;
    }
    if (!present) return undefined;

    const timer = window.setTimeout(() => setPresent(false), ANIMATION_MS);
    return () => window.clearTimeout(timer);
  }, [open, present]);

  if (!open && !present) return null;

  return (
    <div
      className={`animated-collapse${className ? ` ${className}` : ''}`}
      data-open={open}
      aria-hidden={!open}
      inert={!open}
      onAnimationEnd={(event) => {
        if (!open && event.currentTarget === event.target) setPresent(false);
      }}
    >
      <div className="animated-collapse-inner">{children}</div>
    </div>
  );
}
