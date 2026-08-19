// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { query, texts, type Mounted } from './harness.js';
import { click, options, press, renderApp, type } from './ui.js';
import type { AgentState, AppSettings, Model } from '../../src/shared/domain.js';
import { DEFAULT_SETTINGS } from '../../src/shared/domain.js';

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

const MODELS: Model[] = [
  {
    id: 'gpt-5',
    name: 'GPT-5',
    provider: 'openai',
    api: 'responses',
    reasoning: true,
    input: ['text'],
    contextWindow: 400_000,
    maxTokens: 128_000,
    cost: { input: 1.25, output: 10, cacheRead: 0.13, cacheWrite: 0 },
  },
  {
    id: 'sonnet-4',
    name: 'Claude Sonnet 4',
    provider: 'anthropic',
    api: 'messages',
    reasoning: false,
    input: ['text'],
    contextWindow: 200_000,
    maxTokens: 64_000,
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  },
  {
    id: 'haiku',
    name: 'Claude Haiku',
    provider: 'anthropic',
    api: 'messages',
    reasoning: false,
    input: ['text'],
    contextWindow: 200_000,
    maxTokens: 32_000,
    cost: { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
  },
];

const AGENT: AgentState = {
  model: MODELS[0]!,
  thinkingLevel: 'medium',
  isStreaming: false,
  isCompacting: false,
  sessionFile: null,
  sessionId: 'session-1',
  sessionName: 'scoping',
  autoCompactionEnabled: true,
  messageCount: 0,
  pendingMessageCount: 0,
};

function scoped(keys: string[]): Partial<AppSettings> {
  return { scopedModels: { ...DEFAULT_SETTINGS.scopedModels, tau: keys } };
}

/** Opens `/scoped-models` from the command palette, the way users reach it. */
async function openScopedModal(view: Mounted): Promise<HTMLElement> {
  await press(window, 'k', { ctrlKey: true });
  const input = query<HTMLInputElement>(view.container, '.picker-input');
  await type(input, 'scoped-models');
  await press(input, 'Enter');
  return query<HTMLElement>(view.container, '[data-modal-name="scoped"]');
}

describe('scoped models modal', () => {
  it('toggles scope through validated settings IPC without switching the model', async () => {
    const { view, bridge } = await renderApp({
      agent: AGENT,
      results: { 'models.list': MODELS },
    });
    mounted = view;
    const dialog = await openScopedModal(view);

    expect(options(dialog)).toHaveLength(3);
    expect(texts(dialog, '.picker-badge')).toEqual([]);

    // Emulate the main process persisting the toggle before it echoes settings.
    const persisted = { ...DEFAULT_SETTINGS, ...scoped(['anthropic:sonnet-4']) };
    bridge.setResult('settings.update', persisted);
    const rows = [...dialog.querySelectorAll('[role="option"]')];
    await click(rows[1]!);
    await view.flush();

    expect(bridge.payloads('settings.update')).toEqual([
      { scopedModels: { tau: ['anthropic:sonnet-4'], pi: [] } },
    ]);
    // Scoping is not model selection, and the dialog stays open for more edits.
    expect(bridge.payloads('models.set')).toEqual([]);
    expect(view.container.querySelector('[data-modal-name="scoped"]')).not.toBeNull();
    expect(texts(view.container, '.picker-badge')).toEqual(['scoped']);
    expect(query(view.container, '.modal-footer').textContent).toContain(
      '1 scoped · Ctrl+P cycles every model until two are scoped',
    );

    // Toggling again removes the entry.
    bridge.setResult('settings.update', DEFAULT_SETTINGS);
    await click([...view.container.querySelectorAll('[role="option"]')][1]!);
    await view.flush();
    expect(bridge.payloads('settings.update').at(-1)).toEqual({
      scopedModels: { tau: [], pi: [] },
    });
  });

  it('explains the empty state when the runtime reports no models', async () => {
    const { view } = await renderApp({ agent: AGENT, results: { 'models.list': [] } });
    mounted = view;
    const dialog = await openScopedModal(view);
    expect(dialog.textContent).toContain('the runtime reported no models');
  });

  it('explains the empty state when the runtime is not running', async () => {
    const { view } = await renderApp({ status: 'failed', results: { 'models.list': [] } });
    mounted = view;
    const dialog = await openScopedModal(view);
    expect(dialog.textContent).toContain('the runtime is not running');
  });
});

describe('scoped model cycling', () => {
  it('cycles only scoped models once two are scoped', async () => {
    const { view, bridge } = await renderApp({
      agent: AGENT,
      settings: scoped(['openai:gpt-5', 'anthropic:haiku']),
      results: { 'models.list': MODELS },
    });
    mounted = view;

    await press(window, 'p', { ctrlKey: true });
    await view.flush();
    expect(bridge.payloads('models.set')).toEqual([{ provider: 'anthropic', modelId: 'haiku' }]);
    expect(bridge.payloads('models.cycle')).toEqual([]);
  });

  it('falls back to the runtime cycle when scoping cannot resolve two models', async () => {
    const { view, bridge } = await renderApp({
      agent: AGENT,
      settings: scoped(['openai:gpt-5', 'openai:retired']),
      results: { 'models.list': MODELS },
    });
    mounted = view;

    await press(window, 'p', { ctrlKey: true });
    await view.flush();
    expect(bridge.payloads('models.set')).toEqual([]);
    expect(bridge.payloads('models.cycle')).toHaveLength(1);
  });
});

describe('model picker', () => {
  it('marks scoped models without changing selection behavior', async () => {
    const { view, bridge } = await renderApp({
      agent: AGENT,
      settings: scoped(['anthropic:haiku']),
      results: { 'models.list': MODELS },
    });
    mounted = view;
    await click(query(view.container, '.status-right .status-link'));
    const dialog = query(view.container, '[data-modal-name="model"]');
    expect(texts(dialog, '.picker-badge')).toEqual(['scoped']);

    const rows = [...dialog.querySelectorAll('[role="option"]')];
    await click(rows[2]!);
    expect(bridge.payloads('models.set')).toEqual([{ provider: 'anthropic', modelId: 'haiku' }]);
  });
});
