// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuthFlow, AuthProvider } from '../../src/shared/auth.js';
import { query, type Mounted } from './harness.js';
import { click, composer, press, renderApp, type } from './ui.js';

let mounted: Mounted | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

const provider: AuthProvider = {
  id: 'github-copilot',
  name: 'GitHub Copilot',
  methods: [{ type: 'oauth', label: 'Sign in', interactive: true }],
  configured: false,
  storedCredential: null,
};
const promptFlow: AuthFlow = {
  id: 'flow-1',
  providerId: provider.id,
  providerName: provider.name,
  authType: 'oauth',
  revision: 1,
  status: 'prompt',
  prompt: {
    id: 'prompt-1',
    type: 'text',
    message: 'GitHub Enterprise URL/domain (blank for github.com)',
  },
  notices: [],
  message: null,
};

async function openLogin(flow: AuthFlow = promptFlow) {
  const result = await renderApp({
    capabilities: { providerLogin: true },
    results: { 'auth.providers': [provider], 'auth.login.start': flow },
  });
  mounted = result.view;
  await type(composer(result.view), '/login github-copilot');
  await press(composer(result.view), 'Enter');
  return result;
}

describe('auth modal', () => {
  it('submits a blank answer so the native provider can select its default', async () => {
    const { view, bridge } = await openLogin();
    await act(async () => {
      query(view.container, '.auth-prompt').dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });
    expect(bridge.payloads('auth.login.respond')).toEqual([
      { flowId: promptFlow.id, promptId: promptFlow.prompt!.id, value: '' },
    ]);
  });

  it.each(['running', 'prompt'] as const)(
    'restores a %s login after opening the command palette',
    async (status) => {
      const flow: AuthFlow = {
        ...promptFlow,
        status,
        prompt: status === 'prompt' ? promptFlow.prompt : null,
        message: status === 'running' ? 'Waiting for authorization' : null,
      };
      const { view, bridge } = await openLogin(flow);
      await press(query(view.container, '[data-modal-name="login"]'), 'k', { ctrlKey: true });
      const palette = query(view.container, '[data-modal-name="palette"]');
      await type(query<HTMLInputElement>(palette, 'input'), '/login');
      await click(query(palette, '[role="option"]'));

      const login = query(view.container, '[data-modal-name="login"]');
      expect(login.textContent).toContain(flow.prompt?.message ?? flow.message);
      expect(bridge.payloads('auth.login.start')).toHaveLength(1);
      expect(bridge.payloads('auth.login.cancel')).toHaveLength(0);
      if (status === 'prompt') {
        await type(query<HTMLInputElement>(login, 'input'), 'company.ghe.com');
        await act(async () => {
          query(login, 'form').dispatchEvent(
            new Event('submit', { bubbles: true, cancelable: true }),
          );
          await Promise.resolve();
        });
        expect(bridge.payloads('auth.login.respond')).toEqual([
          { flowId: flow.id, promptId: flow.prompt!.id, value: 'company.ghe.com' },
        ]);
        expect(query<HTMLInputElement>(login, 'input').value).toBe('');
      }
      await press(login, 'Escape');
      expect(bridge.payloads('auth.login.cancel')).toEqual([{ flowId: flow.id }]);
      expect(view.container.querySelector('[data-modal-name="login"]')).toBeNull();
    },
  );
});
