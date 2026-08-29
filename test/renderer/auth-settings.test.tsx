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

const PREFERENCES = {
  steeringMode: 'one-at-a-time' as const,
  followUpMode: 'one-at-a-time' as const,
  transport: 'auto' as const,
  retryEnabled: true,
  retryMaxRetries: 3,
  retryBaseDelayMs: 2_000,
  providerTimeoutMs: null,
  providerMaxRetries: 0,
  providerMaxRetryDelayMs: 60_000,
  isRetrying: false,
  retryAttempt: 0,
  autoCompactionEnabled: true,
  compactionReserveTokens: 16_384,
  compactionKeepRecentTokens: 20_000,
  defaultProvider: null,
  defaultModel: null,
  defaultThinkingLevel: null,
  writable: {
    queueModes: true,
    transport: true,
    retryEnabled: true,
    retryPolicy: false,
    autoCompaction: true,
    compactionThresholds: false,
    modelDefaults: true,
  },
};

describe('provider auth and Pi preferences', () => {
  it('keeps secret challenges local and sends only the explicit response to main', async () => {
    const rendered = await renderApp({
      runtime: 'pi',
      capabilities: { providerLogin: true },
      results: {
        'auth.providers': [
          {
            id: 'openai',
            name: 'OpenAI',
            methods: ['api_key', 'oauth'],
            configured: false,
            credentialType: null,
            source: null,
          },
        ],
      },
    });
    mounted = rendered.view;

    await press(window, 'k', { ctrlKey: true });
    const search = query<HTMLInputElement>(rendered.view.container, '.picker-input');
    await type(search, '/login');
    await press(search, 'Enter');
    await rendered.view.flush();

    const apiKey = [...rendered.view.container.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'API key',
    );
    if (!apiKey) throw new Error('API key button missing');
    await click(apiKey);
    await act(async () => {
      rendered.bridge.emit({
        type: 'auth',
        event: {
          flowId: 'flow-1',
          type: 'prompt',
          challengeId: 'challenge-1',
          input: 'secret',
          message: 'Enter API key',
          placeholder: null,
          options: [],
        },
      });
      await Promise.resolve();
    });
    await rendered.view.flush();

    const secret = query<HTMLInputElement>(rendered.view.container, '#auth-response');
    expect(secret.type).toBe('password');
    await type(secret, 'not-a-real-key');
    const submit = [...rendered.view.container.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'continue',
    );
    if (!submit) throw new Error('continue button missing');
    await click(submit);
    expect(rendered.bridge.payloads('auth.respond')).toEqual([
      { flowId: 'flow-1', challengeId: 'challenge-1', value: 'not-a-real-key' },
    ]);
    expect(
      JSON.stringify(rendered.bridge.calls.filter((call) => call.action !== 'auth.respond')),
    ).not.toContain('not-a-real-key');
  });

  it('restores Pi preferences and exposes only supported writable controls', async () => {
    const rendered = await renderApp({
      runtime: 'pi',
      capabilities: { retryControls: true },
      results: {
        'pi.preferences.get': PREFERENCES,
        'pi.preferences.update': { ...PREFERENCES, retryEnabled: false },
      },
    });
    mounted = rendered.view;

    await press(window, 'k', { ctrlKey: true });
    const search = query<HTMLInputElement>(rendered.view.container, '.picker-input');
    await type(search, '/settings');
    await press(search, 'Enter');
    await rendered.view.flush();
    expect(rendered.view.container.textContent).toContain('3 retries · 2000ms base');
    expect(rendered.view.container.textContent).toContain('reserve 16384');

    const retry = query<HTMLInputElement>(rendered.view.container, '#setting-auto-retry');
    await click(retry);
    expect(rendered.bridge.payloads('pi.preferences.update')).toEqual([{ retryEnabled: false }]);
  });
});
