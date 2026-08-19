// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { query, texts, type Mounted } from './harness.js';
import { click, composer, options, press, renderApp, selectedOption, type } from './ui.js';
import type {
  AgentState,
  Model,
  SessionEntry,
  SessionRef,
  TreeSnapshot,
} from '../../src/shared/domain.js';

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

async function runPaletteCommand(view: Mounted, search: string): Promise<void> {
  await press(window, 'k', { ctrlKey: true });
  const input = query<HTMLInputElement>(view.container, '.picker-input');
  await type(input, search);
  await press(input, 'Enter');
}

async function runComposerCommand(view: Mounted, command: string): Promise<void> {
  const input = composer(view);
  await type(input, command);
  await press(input, 'Enter');
}

const MODELS: Model[] = [
  {
    id: 'gpt-5',
    name: 'GPT-5',
    provider: 'openai',
    api: 'responses',
    reasoning: true,
    input: ['text', 'image'],
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
];

const AGENT: AgentState = {
  model: MODELS[0]!,
  thinkingLevel: 'medium',
  isStreaming: false,
  isCompacting: false,
  sessionFile: '/work/project/.tau/sessions/current.jsonl',
  sessionId: 'session-1',
  sessionName: 'refactor transport',
  autoCompactionEnabled: true,
  messageCount: 12,
  pendingMessageCount: 0,
};

const RECENTS: SessionRef[] = [
  {
    id: 'session-1',
    name: 'refactor transport',
    path: '/work/project/.tau/sessions/one.jsonl',
    cwd: '/work/project',
    runtime: 'tau',
    lastSeen: 1_760_000_000_000,
  },
  {
    id: 'session-2',
    name: null,
    path: '/work/project/.tau/sessions/two.jsonl',
    cwd: '/work/project',
    runtime: 'tau',
    lastSeen: 1_759_000_000_000,
  },
];

function entry(id: string, summary: string, role: 'user' | 'assistant'): SessionEntry {
  return {
    id,
    parentId: null,
    timestamp: '2026-01-02T03:04:05.000Z',
    kind: 'message',
    message:
      role === 'user'
        ? { role: 'user', text: summary, images: [], timestamp: 0 }
        : {
            role: 'assistant',
            text: summary,
            thinking: '',
            toolCalls: [],
            provider: 'openai',
            model: 'gpt-5',
            usage: null,
            stopReason: 'stop',
            errorMessage: null,
            timestamp: 0,
          },
    summary,
    raw: {},
  };
}

const TREE: TreeSnapshot = {
  tree: [
    {
      entry: entry('e1', 'add jsonl framing tests', 'user'),
      children: [
        { entry: entry('e2', 'sure, adding them now', 'assistant'), children: [] },
        { entry: entry('e3', 'second branch reply', 'assistant'), children: [] },
      ],
    },
  ],
  leafId: 'e3',
};

describe('model picker', () => {
  it('shows full metadata and sets the model through RPC', async () => {
    const { view, bridge } = await renderApp({
      agent: AGENT,
      results: { 'models.list': MODELS },
    });
    mounted = view;
    // Mouse parity: the status row model chip opens the picker.
    await click(query(view.container, '.status-right .status-link'));

    const dialog = query(view.container, '[data-modal-name="model"]');
    const detail = texts(dialog, '.picker-detail').join('\n');
    expect(detail).toContain('gpt-5');
    expect(detail).toContain('text/image · reasoning');
    expect(detail).toContain('context 400.0k · max output 128.0k');
    expect(detail).toContain('in $1.25/Mtok');
    // The active model is marked.
    expect(selectedOption(dialog)).toContain('GPT-5');

    const rows = [...dialog.querySelectorAll('[role="option"]')];
    await click(rows[1]!);
    expect(bridge.payloads('models.set')).toEqual([{ provider: 'anthropic', modelId: 'sonnet-4' }]);
    expect(view.container.querySelector('[data-modal-name="model"]')).toBeNull();
  });
});

describe('session picker', () => {
  it('switches to an app-owned recent session and can forget one', async () => {
    const { view, bridge } = await renderApp({
      agent: AGENT,
      settings: { recentSessions: RECENTS },
    });
    mounted = view;
    await runPaletteCommand(view, '/resume');
    const dialog = query(view.container, '[data-modal-name="session"]');
    expect(dialog.textContent).toContain('needs runtime list_sessions support');
    expect(options(dialog)).toHaveLength(2);

    await click(query(dialog, '[role="option"]:nth-child(2) button'));
    expect(bridge.payloads('settings.forgetSession')).toEqual([{ id: 'session-2' }]);
    // Forgetting must not switch sessions.
    expect(bridge.payloads('session.switch')).toEqual([]);

    const rows = [...dialog.querySelectorAll('[role="option"]')];
    await click(rows[1]!);
    expect(bridge.payloads('session.switch')).toEqual([
      { ref: '/work/project/.tau/sessions/two.jsonl' },
    ]);
  });
});

describe('tree modal', () => {
  it('renders branches, marks the active leaf, and forks into the composer', async () => {
    const { view, bridge } = await renderApp({
      agent: AGENT,
      capabilities: { sessionTree: true },
      results: { 'agent.tree': TREE, 'session.fork': 'add jsonl framing tests' },
    });
    mounted = view;
    await runComposerCommand(view, '/tree');
    await view.flush();

    const dialog = query(view.container, '[data-modal-name="tree"]');
    const rows = [...dialog.querySelectorAll('[role="option"]')];
    expect(rows).toHaveLength(3);
    expect(rows[0]!.textContent).toContain('user · add jsonl framing tests');
    expect(rows[0]!.getAttribute('data-tone')).toBe('primary');
    expect(rows[1]!.getAttribute('data-tone')).toBe('muted');
    // Branch children are indented and the active leaf is marked.
    expect(rows[1]!.getAttribute('style')).toContain('padding-left');
    expect(rows[2]!.getAttribute('data-current')).toBe('true');

    await click(rows[0]!);
    await view.flush();
    expect(bridge.payloads('session.fork')).toEqual([{ entryId: 'e1' }]);
    expect(composer(view).value).toBe('add jsonl framing tests');
  });

  it('reports when the runtime cannot expose the tree', async () => {
    const { view } = await renderApp({ capabilities: { sessionTree: false } });
    mounted = view;
    await runComposerCommand(view, '/tree');
    expect(view.container.textContent).toContain('does not expose session tree inspection');
  });
});

describe('session details', () => {
  it('renames the session and lists usage context', async () => {
    const { view, bridge } = await renderApp({ agent: AGENT });
    mounted = view;
    await runComposerCommand(view, '/session');
    const dialog = query(view.container, '[data-modal-name="details"]');
    expect(dialog.textContent).toContain('session-1');
    expect(dialog.textContent).toContain('auto-compaction');

    const name = query<HTMLInputElement>(dialog, '#session-name');
    await type(name, 'transport rewrite');
    await click(query(dialog, 'button[type="submit"]'));
    expect(bridge.payloads('session.name')).toEqual([{ name: 'transport rewrite' }]);
  });
});

describe('thinking picker', () => {
  it('explains an empty level list', async () => {
    const { view } = await renderApp({ agent: AGENT, results: { 'thinking.list': [] } });
    mounted = view;
    await press(window, 'k', { ctrlKey: true });
    const input = query<HTMLInputElement>(view.container, '.picker-input');
    await type(input, 'thinking');
    await press(input, 'Enter');
    const dialog = query(view.container, '[data-modal-name="thinking"]');
    expect(dialog.textContent).toContain('no reasoning support');
  });
});
