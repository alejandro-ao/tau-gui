// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { query, type Mounted } from './harness.js';
import { click, press, renderApp, type } from './ui.js';

let mounted: Mounted | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

describe('extension isolation UI', () => {
  it('shows fail-closed metadata and never offers execution', async () => {
    const extensionId = crypto.randomUUID();
    const rendered = await renderApp({
      results: {
        'extensions.list': [
          {
            id: extensionId,
            name: 'untrusted-extension',
            scope: 'project',
            enabledRequested: true,
            trusted: true,
            execution: 'blocked',
            reason: 'public adapter unavailable',
          },
        ],
        'extensions.policy.get': {
          userEnabled: false,
          projectEnabled: true,
          executionAvailable: false,
          blocker: 'Pi has no public serializable extension-host adapter',
        },
      },
    });
    mounted = rendered.view;
    await press(window, 'k', { ctrlKey: true });
    const search = query<HTMLInputElement>(rendered.view.container, '.picker-input');
    await type(search, '/extensions');
    await press(search, 'Enter');
    await rendered.view.flush();

    expect(rendered.view.container.textContent).toContain('untrusted-extension');
    expect(rendered.view.container.textContent).toContain('blocked');
    expect(rendered.view.container.textContent).toContain('no public serializable');
    expect(rendered.view.container.querySelector('button')?.textContent).not.toContain('run');
  });

  it('renders bounded dialogs and routes responses without extension code in renderer', async () => {
    const rendered = await renderApp({});
    mounted = rendered.view;
    const requestId = crypto.randomUUID();
    await act(async () => {
      rendered.bridge.emit({
        type: 'extensionUi',
        event: {
          type: 'dialog',
          dialog: {
            requestId,
            extensionId: crypto.randomUUID(),
            kind: 'input',
            title: 'Extension input',
            message: 'Value',
            placeholder: 'safe text',
            initialValue: '',
            timeoutMs: 1_000,
          },
        },
      });
      await Promise.resolve();
    });
    const input = query<HTMLInputElement>(rendered.view.container, '#extension-dialog-value');
    await type(input, '<img src=x onerror=alert(1)>');
    const submit = [...rendered.view.container.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'submit',
    );
    if (!submit) throw new Error('submit missing');
    await click(submit);
    expect(rendered.bridge.payloads('extensions.dialog.respond')).toEqual([
      { requestId, value: '<img src=x onerror=alert(1)>' },
    ]);
    expect(rendered.view.container.querySelector('img')).toBeNull();
  });

  it('renders bounded extension status and sidebar sections as inert text', async () => {
    const rendered = await renderApp({});
    mounted = rendered.view;
    const extensionId = crypto.randomUUID();
    await act(async () => {
      rendered.bridge.emit({
        type: 'extensionUi',
        event: { type: 'status', extensionId, key: 'mode', text: '<b>active</b>' },
      });
      rendered.bridge.emit({
        type: 'extensionUi',
        event: {
          type: 'sidebar',
          extensionId,
          key: 'tasks',
          title: 'Extension tasks',
          lines: ['<script>bad()</script>', 'safe'],
        },
      });
      await Promise.resolve();
    });
    expect(rendered.view.container.textContent).toContain('<b>active</b>');
    expect(rendered.view.container.textContent).toContain('<script>bad()</script>');
    expect(rendered.view.container.querySelector('script')).toBeNull();
  });
});
