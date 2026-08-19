import { Fragment, useEffect, useRef, type ReactNode } from 'react';
import type { DirectiveKind } from './directives.js';

export interface CompletionItem {
  id: string;
  label: string;
  detail?: string | null;
  badge?: string | null;
  reason?: string | null;
  /** Resource directives are colour-coded to match the composer pill. */
  kind?: DirectiveKind | null;
  /** Text inserted into the draft, before any trailing separator. */
  insert: string;
  /** Header grouping consecutive items, like Tau's completion categories. */
  section?: string | null;
  /** Prefix items (like `/skill:`) insert without a trailing space so the popup stays open. */
  keepOpen?: boolean;
  /** Directory completions keep the popup usable for the next segment. */
  isDirectory?: boolean;
}

export interface CompletionPopupProps {
  kind: 'slash' | 'path';
  items: CompletionItem[];
  index: number;
  onHover: (index: number) => void;
  onAccept: (item: CompletionItem) => void;
}

/**
 * Inline completion list above the composer.
 *
 * Navigation lives in the composer so the textarea keeps focus; this component
 * only renders and forwards mouse selection.
 */
export function CompletionPopup({
  kind,
  items,
  index,
  onHover,
  onAccept,
}: CompletionPopupProps): ReactNode {
  const selected = useRef<HTMLLIElement | null>(null);

  // The slash list shows every command, so keyboard navigation has to keep the
  // highlighted row visible inside the scrolling popup.
  useEffect(() => {
    const element = selected.current;
    // jsdom does not implement scrollIntoView, so tests must not depend on it.
    if (typeof element?.scrollIntoView === 'function') element.scrollIntoView({ block: 'nearest' });
  }, [index, items]);

  return (
    <div className="completion" data-kind={kind} data-testid={`completion-${kind}`}>
      <ul className="completion-list" role="listbox" aria-label={`${kind} completion`}>
        {items.map((item, position) => {
          // Sections are consecutive, so a header opens whenever it changes.
          const section =
            item.section != null && item.section !== items[position - 1]?.section
              ? item.section
              : null;
          return (
            <Fragment key={item.id}>
              {section ? (
                <li className="completion-section" role="presentation" aria-hidden="true">
                  {section}
                </li>
              ) : null}
              <li
                ref={position === index ? selected : null}
                className="completion-option"
                role="option"
                aria-selected={position === index}
                data-selected={position === index}
                data-unavailable={Boolean(item.reason)}
                data-kind={item.kind ?? undefined}
                onMouseMove={() => onHover(position)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onAccept(item)}
              >
                <span className="completion-label">{item.label}</span>
                {item.badge ? <span className="completion-badge">{item.badge}</span> : null}
                {item.detail ? <span className="completion-detail">{item.detail}</span> : null}
                {item.reason ? <span className="completion-reason">{item.reason}</span> : null}
              </li>
            </Fragment>
          );
        })}
      </ul>
    </div>
  );
}
