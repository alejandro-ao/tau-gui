import { useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Modal } from './Modal.js';
import { fuzzyFilter } from './fuzzy.js';

export interface PickerItem {
  id: string;
  label: string;
  /** Selectable, copyable detail text rendered under the label. */
  detail?: string | null;
  /** Right-aligned metadata such as a provider or timestamp. */
  hint?: string | null;
  /** Origin marker: `backend`, `frontend`, `local`, … */
  badge?: string | null;
  /** Present when the entry cannot run; always shown to the user. */
  reason?: string | null;
  /** Extra text included in fuzzy matching. */
  keywords?: string;
  /** Indentation level for tree-shaped lists. */
  depth?: number;
  /** `primary` keeps user turns prominent, `muted` compacts tool/assistant rows. */
  tone?: 'primary' | 'muted';
  /** Marks the active leaf or current selection. */
  current?: boolean;
}

export interface PickerProps {
  name: string;
  title: string;
  subtitle?: string | null;
  placeholder?: string;
  items: PickerItem[];
  onAccept: (item: PickerItem) => void;
  onClose: () => void;
  /** Optional per-row controls, e.g. forgetting a recent session. */
  rowActions?: (item: PickerItem) => ReactNode;
  emptyLabel?: string;
  footer?: ReactNode;
}

/**
 * Keyboard-first list picker.
 *
 * Up/Down move, Enter accepts, mouse click accepts, and the selection is kept
 * by id so asynchronous refreshes of `items` do not move it.
 */
export function Picker({
  name,
  title,
  subtitle,
  placeholder = 'type to filter…',
  items,
  onAccept,
  onClose,
  rowActions,
  emptyLabel = 'nothing to show',
  footer,
}: PickerProps): ReactNode {
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(items[0]?.id ?? null);

  const filtered = useMemo(
    () => fuzzyFilter(items, query, (item) => `${item.label} ${item.keywords ?? ''}`),
    [items, query],
  );

  // Keep the highlighted row stable unless it disappeared from the list.
  useEffect(() => {
    setSelectedId((current) => {
      if (current !== null && filtered.some((item) => item.id === current)) return current;
      return filtered[0]?.id ?? null;
    });
  }, [filtered]);

  const selectedIndex = filtered.findIndex((item) => item.id === selectedId);

  const move = (delta: number): void => {
    if (filtered.length === 0) return;
    const base = selectedIndex < 0 ? 0 : selectedIndex;
    const next = (base + delta + filtered.length) % filtered.length;
    setSelectedId(filtered[next]?.id ?? null);
  };

  const accept = (item: PickerItem | undefined): void => {
    if (!item) return;
    onAccept(item);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      move(1);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      move(-1);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      accept(selectedIndex < 0 ? filtered[0] : filtered[selectedIndex]);
    }
  };

  return (
    <Modal name={name} title={title} subtitle={subtitle ?? null} onClose={onClose} footer={footer}>
      {/* The wrapper owns list navigation so it works from the filter input too. */}
      <div onKeyDown={onKeyDown} className="picker">
        <input
          className="picker-input"
          type="text"
          data-autofocus="true"
          role="combobox"
          aria-expanded="true"
          aria-controls={`picker-list-${name}`}
          aria-activedescendant={selectedId ? optionId(name, selectedId) : undefined}
          aria-label={`filter ${title}`}
          placeholder={placeholder}
          spellCheck={false}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <ul className="picker-list" id={`picker-list-${name}`} role="listbox" aria-label={title}>
          {filtered.map((item) => (
            <li
              key={item.id}
              id={optionId(name, item.id)}
              className="picker-option"
              role="option"
              aria-selected={item.id === selectedId}
              aria-disabled={Boolean(item.reason)}
              data-selected={item.id === selectedId}
              data-unavailable={Boolean(item.reason)}
              data-tone={item.tone ?? 'primary'}
              data-current={item.current ?? false}
              style={item.depth ? { paddingLeft: `${8 + item.depth * 14}px` } : undefined}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => accept(item)}
            >
              <div className="picker-option-main">
                <span className="picker-option-label">
                  {item.current ? <span aria-hidden="true">▸ </span> : null}
                  {item.label}
                </span>
                {item.badge ? <span className="picker-badge">{item.badge}</span> : null}
                {item.hint ? <span className="picker-hint">{item.hint}</span> : null}
                {rowActions ? <span className="picker-row-actions">{rowActions(item)}</span> : null}
              </div>
              {item.detail ? <div className="picker-detail">{item.detail}</div> : null}
              {item.reason ? (
                <div className="picker-reason">unavailable · {item.reason}</div>
              ) : null}
            </li>
          ))}
        </ul>
        {filtered.length === 0 ? <p className="picker-empty">{emptyLabel}</p> : null}
      </div>
    </Modal>
  );
}

function optionId(name: string, id: string): string {
  let encodedId = '';
  for (let index = 0; index < id.length; index += 1) {
    encodedId += id.charCodeAt(index).toString(16).padStart(4, '0');
  }
  return `picker-${name}-option-${encodedId}`;
}
