import { useState, type ReactNode } from 'react';

export interface DisclosureItem {
  label: string;
  title?: string;
  /**
   * Dimmed entries exist but are restricted — e.g. a skill the agent may not
   * call automatically. Rendered with a vignette so the restriction is visible.
   */
  dimmed?: boolean;
}

/**
 * Collapsible sidebar section in the TUI style: `▸ skills (7 · ~616 tokens)`.
 * Used for every resource list; sections whose data the runtime does not
 * report are omitted by the caller instead of rendered empty.
 */
export function Disclosure({
  title,
  count,
  meta,
  items,
  defaultOpen = false,
}: {
  title: string;
  count: number;
  meta?: string;
  items: DisclosureItem[];
  defaultOpen?: boolean;
}): ReactNode {
  const [open, setOpen] = useState(defaultOpen);
  const summary = meta ? `(${count} · ${meta})` : `(${count})`;
  return (
    <section className="sidebar-section disclosure">
      <button
        type="button"
        className="disclosure-toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="disclosure-caret" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
        <span className="disclosure-title">{title}</span>
        <span className="disclosure-summary">{summary}</span>
      </button>
      {open ? (
        <ul className="disclosure-body">
          {items.map((item) => (
            <li
              key={item.label}
              className={item.dimmed ? 'disclosure-item dimmed' : 'disclosure-item'}
              title={item.title}
            >
              {item.label}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
