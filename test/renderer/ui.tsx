import { act } from 'react';
import {
  installFakeBridge,
  mount,
  query,
  type FakeBridge,
  type FakeBridgeOptions,
} from './harness.js';
import type { Mounted } from './harness.js';

export interface RenderedApp {
  bridge: FakeBridge;
  view: Mounted;
}

/** Mounts the full app against a fake bridge, then clears bootstrap calls. */
export async function renderApp(options: FakeBridgeOptions = {}): Promise<RenderedApp> {
  const bridge = installFakeBridge(options);
  // Imported lazily so the fake bridge exists before the store bootstraps.
  const { StoreProvider } = await import('../../src/renderer/src/state/store.js');
  const { App } = await import('../../src/renderer/src/App.js');
  const view = await mount(
    <StoreProvider>
      <App />
    </StoreProvider>,
  );
  await view.flush();
  bridge.calls.length = 0;
  return { bridge, view };
}

const valueDescriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
const inputValueDescriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');

/** Types into a controlled field using the native setter React tracks. */
export async function type(
  element: HTMLTextAreaElement | HTMLInputElement,
  value: string,
): Promise<void> {
  const descriptor =
    element instanceof HTMLTextAreaElement ? valueDescriptor : inputValueDescriptor;
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const setValue = descriptor?.set;
  await act(async () => {
    if (setValue) Reflect.apply(setValue, element, [value]);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    await Promise.resolve();
  });
}

export async function press(
  target: Element | Window,
  key: string,
  modifiers: Partial<KeyboardEventInit> = {},
): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...modifiers }));
    await Promise.resolve();
  });
}

export async function click(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
  });
}

export async function settle(view: Mounted): Promise<void> {
  await view.flush();
  await view.flush();
}

export function composer(view: Mounted): HTMLTextAreaElement {
  return query<HTMLTextAreaElement>(view.container, 'textarea.composer-input');
}

export function options(root: ParentNode): string[] {
  return [...root.querySelectorAll('[role="option"]')].map(
    (element) => element.textContent?.trim() ?? '',
  );
}

export function selectedOption(root: ParentNode): string {
  const element = root.querySelector('[role="option"][data-selected="true"]');
  return element?.textContent?.trim() ?? '';
}
