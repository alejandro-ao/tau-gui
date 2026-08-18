// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, query, type Mounted } from './harness.js';
import { click, options, press, selectedOption, type } from './ui.js';
import { Picker, type PickerItem } from '../../src/renderer/src/components/modals/Picker.js';

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

const ITEMS: PickerItem[] = [
  { id: 'alpha', label: 'alpha', detail: 'first entry' },
  { id: 'beta', label: 'beta', detail: 'second entry' },
  { id: 'gamma', label: 'gamma', reason: 'needs runtime support' },
];

async function renderPicker(
  items: PickerItem[] = ITEMS,
): Promise<{ view: Mounted; accepted: PickerItem[]; closed: () => number }> {
  const accepted: PickerItem[] = [];
  const onClose = vi.fn();
  const view = await mount(
    <Picker
      name="test"
      title="test picker"
      subtitle="detail text stays selectable"
      items={items}
      onAccept={(item) => accepted.push(item)}
      onClose={onClose}
    />,
  );
  mounted = view;
  return { view, accepted, closed: () => onClose.mock.calls.length };
}

describe('picker framework', () => {
  it('exposes dialog semantics and marks the container as a modal', async () => {
    const { view } = await renderPicker();
    const dialog = query(view.container, '[role="dialog"]');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('data-modal')).toBe('true');
    expect(dialog.getAttribute('aria-labelledby')).toBe('modal-title-test');
    const input = query<HTMLInputElement>(view.container, '.picker-input');
    expect(input.getAttribute('role')).toBe('combobox');
    expect(document.activeElement).toBe(input);
    expect(view.container.textContent).toContain('first entry');
  });

  it('navigates with Up/Down and accepts with Enter', async () => {
    const { view, accepted } = await renderPicker();
    const input = query(view.container, '.picker-input');
    expect(selectedOption(view.container)).toContain('alpha');

    await press(input, 'ArrowDown');
    expect(selectedOption(view.container)).toContain('beta');
    await press(input, 'ArrowUp');
    expect(selectedOption(view.container)).toContain('alpha');
    // Wrapping keeps the list navigable from either end.
    await press(input, 'ArrowUp');
    expect(selectedOption(view.container)).toContain('gamma');

    await press(input, 'Enter');
    expect(accepted.map((item) => item.id)).toEqual(['gamma']);
  });

  it('accepts a mouse click on any row, including unavailable entries', async () => {
    const { view, accepted } = await renderPicker();
    const rows = [...view.container.querySelectorAll('[role="option"]')];
    await click(rows[2]!);
    expect(accepted.map((item) => item.id)).toEqual(['gamma']);
    expect(view.container.textContent).toContain('needs runtime support');
  });

  it('cancels on Escape', async () => {
    const { view, closed } = await renderPicker();
    await press(query(view.container, '.picker-input'), 'Escape');
    expect(closed()).toBe(1);
  });

  it('traps Tab inside the dialog', async () => {
    const { view } = await renderPicker();
    const focusable = [...view.container.querySelectorAll<HTMLElement>('button, input')];
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    act(() => last.focus());
    await press(last, 'Tab');
    expect(document.activeElement).toBe(first);
    await press(first, 'Tab', { shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('filters fuzzily and keeps the selection stable across refreshes', async () => {
    const { view } = await renderPicker();
    const input = query<HTMLInputElement>(view.container, '.picker-input');
    await type(input, 'gma');
    expect(options(view.container)).toHaveLength(1);
    expect(selectedOption(view.container)).toContain('gamma');

    // An async refresh adds an item; the highlight must not jump.
    await act(async () => {
      view.root.render(
        <Picker
          name="test"
          title="test picker"
          items={[...ITEMS, { id: 'sigma', label: 'sigma' }]}
          onAccept={() => undefined}
          onClose={() => undefined}
        />,
      );
      await Promise.resolve();
    });
    expect(selectedOption(view.container)).toContain('gamma');
  });
});
