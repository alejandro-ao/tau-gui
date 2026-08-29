import { DEFAULT_CAPABILITIES, THINKING_LEVELS } from '../../shared/domain.js';
import type {
  AgentMessage,
  BashResult,
  CommandInfo,
  CompactionResult,
  EntrySnapshot,
  Model,
  ModelCycleResult,
  ModelRef,
  PromptInput,
  RuntimeCapabilities,
  RuntimeLaunchConfig,
  SessionStats,
  SessionSummary,
  ThinkingLevel,
  TreeSnapshot,
} from '../../shared/domain.js';
import type { AgentRuntime, RuntimeAgentState, RuntimeSink } from './agent-runtime.js';

const MODELS: Model[] = [
  {
    id: 'fake-large',
    name: 'Fake Large',
    provider: 'fake',
    api: 'test',
    reasoning: true,
    input: ['text', 'image'],
    contextWindow: 128_000,
    maxTokens: 16_384,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: 'fake-small',
    name: 'Fake Small',
    provider: 'fake',
    api: 'test',
    reasoning: false,
    input: ['text'],
    contextWindow: 32_000,
    maxTokens: 4_096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
];
const MODEL = MODELS[0]!;

/** Deterministic in-process Pi-domain fake used only by tests and Electron E2E. */
export class FakePiRuntime implements AgentRuntime {
  readonly kind = 'pi' as const;
  readonly capabilities: RuntimeCapabilities = {
    ...DEFAULT_CAPABILITIES,
    textPrompt: true,
    imagePrompt: true,
    steering: true,
    followUps: true,
    directBash: true,
    abortBash: true,
    retryControls: true,
    sessionTree: true,
  };
  private state: RuntimeAgentState = freshState();
  private messages: AgentMessage[] = [];
  private stopped = true;
  private sessionSequence = 1;
  private held: { resolve: () => void } | null = null;

  constructor(
    private readonly sink: RuntimeSink,
    private readonly initialSessionId = 'fake-session-1',
  ) {
    this.state = freshState(initialSessionId);
  }

  async start(config: RuntimeLaunchConfig): Promise<void> {
    this.stopped = false;
    this.state = {
      ...freshState(config.sessionRef ?? this.initialSessionId),
      sessionFile: null,
    };
    this.sink.status('starting');
    await Promise.resolve();
    this.sink.status('idle');
  }
  stop(): Promise<void> {
    this.stopped = true;
    this.held?.resolve();
    this.held = null;
    this.sink.status('stopped');
    return Promise.resolve();
  }

  async prompt(input: PromptInput): Promise<void> {
    if (this.stopped) throw new Error('Fake Pi is stopped');
    const user = userMessage(input.text);
    this.messages.push(user);
    this.state = { ...this.state, isStreaming: true, messageCount: this.messages.length };
    this.sink.status('running');
    this.sink.event({ type: 'agent_start' });
    this.sink.event({ type: 'turn_start' });
    this.sink.event({ type: 'message_start', message: user });
    this.sink.event({ type: 'message_end', message: user });

    if (input.text.includes('hold assistant') || input.text === 'slow run please') {
      await new Promise<void>((resolve) => {
        this.held = { resolve };
      });
      return;
    }
    if (input.text.includes('trigger an error')) {
      const assistant = assistantMessage('I could not reach the provider.', 'error');
      this.emitAssistant(assistant, false);
      this.sink.event({ type: 'runtime_error', message: 'provider unavailable (503)' });
      this.settle();
      return;
    }
    if (input.text.includes('show thinking')) {
      const assistant = assistantMessage('Here is the answer.');
      this.sink.event({ type: 'message_start', message: assistant });
      this.sink.event({
        type: 'message_delta',
        kind: 'thinking',
        delta: 'Considering the request carefully.',
        message: assistant,
      });
      this.sink.event({
        type: 'message_delta',
        kind: 'text',
        delta: assistant.text,
        message: assistant,
      });
      this.sink.event({ type: 'message_end', message: assistant });
      this.messages.push({ ...assistant, thinking: 'Considering the request carefully.' });
      this.settle();
      return;
    }
    if (
      input.text.includes('use a tool') ||
      input.text.includes('tool work') ||
      input.text.includes('reason about')
    ) {
      await new Promise((resolve) => setTimeout(resolve, 80));
      this.emitToolRun(input.text.includes('reason about'));
      return;
    }
    const assistant = assistantMessage('Hello from the embedded fake Pi runtime.');
    this.sink.event({ type: 'message_start', message: assistant });
    this.sink.event({
      type: 'message_delta',
      kind: 'text',
      delta: assistant.text,
      message: assistant,
    });
    await new Promise((resolve) => setTimeout(resolve, input.text.includes('slow run') ? 500 : 80));
    this.sink.event({ type: 'message_end', message: assistant });
    this.messages.push(assistant);
    this.settle();
  }

  steer(input: PromptInput): Promise<void> {
    return this.prompt(input);
  }
  followUp(input: PromptInput): Promise<void> {
    return this.prompt(input);
  }
  abort(): Promise<void> {
    this.held?.resolve();
    this.held = null;
    if (this.state.isStreaming) {
      this.emitAssistant(assistantMessage('Cancelled.', 'aborted'), false);
      this.settle();
    }
    return Promise.resolve();
  }
  getState(): Promise<RuntimeAgentState> {
    return Promise.resolve({ ...this.state });
  }
  getMessages(): Promise<AgentMessage[]> {
    return Promise.resolve([...this.messages]);
  }
  getEntries(): Promise<EntrySnapshot> {
    return Promise.resolve({ entries: [], leafId: null });
  }
  getTree(): Promise<TreeSnapshot> {
    return Promise.resolve({ rows: [], leafId: null, truncated: false });
  }
  getStats(): Promise<SessionStats> {
    return Promise.resolve({
      persisted: this.state.persisted,
      sessionId: this.state.sessionId,
      userMessages: this.messages.filter((message) => message.role === 'user').length,
      assistantMessages: this.messages.filter((message) => message.role === 'assistant').length,
      toolCalls: this.messages.filter((message) => message.role === 'toolResult').length,
      totalMessages: this.messages.length,
      tokens: { input: 1200, output: 340, cacheRead: 800, cacheWrite: 100, total: 2440 },
      cost: 0,
      contextUsage: { tokens: 2440, contextWindow: MODEL.contextWindow, percent: 1.9 },
    });
  }
  listModels(): Promise<Model[]> {
    return Promise.resolve([...MODELS]);
  }
  setModel(ref: ModelRef): Promise<Model | null> {
    const model =
      MODELS.find(
        (candidate) => candidate.provider === ref.provider && candidate.id === ref.modelId,
      ) ?? null;
    if (model) this.state = { ...this.state, model };
    return Promise.resolve(model);
  }
  cycleModel(): Promise<ModelCycleResult | null> {
    const index = MODELS.findIndex((model) => model.id === this.state.model?.id);
    const model = MODELS[(index + 1) % MODELS.length]!;
    this.state = { ...this.state, model };
    return Promise.resolve({ model, thinkingLevel: this.state.thinkingLevel, isScoped: false });
  }
  listThinkingLevels(): Promise<ThinkingLevel[]> {
    return Promise.resolve([...THINKING_LEVELS]);
  }
  setThinking(level: ThinkingLevel): Promise<void> {
    this.state = { ...this.state, thinkingLevel: level };
    return Promise.resolve();
  }
  cycleThinking(): Promise<ThinkingLevel | null> {
    return Promise.resolve(this.state.thinkingLevel);
  }
  setAutoCompaction(enabled: boolean): Promise<void> {
    this.state = { ...this.state, autoCompactionEnabled: enabled };
    return Promise.resolve();
  }
  compact(): Promise<CompactionResult> {
    return Promise.resolve({
      summary: 'Fake compacted context',
      firstKeptEntryId: null,
      tokensBefore: 1000,
      estimatedTokensAfter: 200,
    });
  }
  runShell(command: string): Promise<BashResult> {
    return Promise.resolve({
      command,
      output: command.includes('echo hi') ? 'hi\n' : 'ok\n',
      exitCode: 0,
      cancelled: false,
      truncated: false,
    });
  }
  abortShell(): Promise<void> {
    return Promise.resolve();
  }
  newSession(): Promise<void> {
    this.messages = [];
    this.sessionSequence += 1;
    this.state = freshState(`${this.initialSessionId}-new-${this.sessionSequence}`);
    this.sink.status('idle');
    return Promise.resolve();
  }
  switchSession(ref: string): Promise<void> {
    this.messages = [];
    this.state = { ...freshState(), sessionId: ref };
    return Promise.resolve();
  }
  nameSession(name: string): Promise<void> {
    this.state = { ...this.state, sessionName: name };
    return Promise.resolve();
  }
  fork(): Promise<{
    editorText: string | null;
    editorTextTruncated: boolean;
    cancelled: boolean;
    aborted: boolean;
  }> {
    return Promise.resolve({
      editorText: '',
      editorTextTruncated: false,
      cancelled: false,
      aborted: false,
    });
  }
  setLabel(): Promise<void> {
    return Promise.resolve();
  }
  clone(): Promise<void> {
    this.state = freshState(`${this.state.sessionId}-clone`);
    return Promise.resolve();
  }
  importJsonl(path: string): Promise<void> {
    this.state = freshState(path);
    return Promise.resolve();
  }
  listSessions(): Promise<SessionSummary[]> {
    return Promise.resolve([]);
  }
  exportJsonl(path: string): Promise<string> {
    return Promise.resolve(path);
  }
  exportHtml(path = '/tmp/fake-pi-session.html'): Promise<string> {
    return Promise.resolve(path);
  }
  listCommands(): Promise<CommandInfo[]> {
    return Promise.resolve([]);
  }
  getResources() {
    return Promise.resolve({ skills: [], prompts: [], diagnostics: [] });
  }
  getContextFiles() {
    return Promise.resolve([]);
  }

  private emitAssistant(
    message: Extract<AgentMessage, { role: 'assistant' }>,
    stream: boolean,
  ): void {
    this.sink.event({ type: 'message_start', message });
    if (stream)
      this.sink.event({ type: 'message_delta', kind: 'text', delta: message.text, message });
    this.sink.event({ type: 'message_end', message });
    this.messages.push(message);
  }
  private emitToolRun(reasoning: boolean): void {
    const tools = reasoning
      ? [
          {
            id: 'tool-1',
            name: 'grep',
            args: { pattern: 'value', path: 'src' },
            text: 'src/index.ts:1',
          },
        ]
      : [
          {
            id: 'tool-1',
            name: 'read',
            args: { path: 'src/index.ts' },
            text: 'export const value = 1;',
          },
          {
            id: 'tool-2',
            name: 'edit',
            args: { path: 'src/index.ts', oldText: 'a', newText: 'b' },
            text: '--- a/src/index.ts\n+++ b/src/index.ts\n@@\n-a\n+b',
          },
          {
            id: 'tool-3',
            name: 'bash',
            args: { command: 'npm test', description: 'Running tests' },
            text: '2 passed, 0 failed',
          },
        ];
    const note = {
      ...assistantMessage(reasoning ? 'Searching the project first.' : 'Inspecting the project.'),
      thinking: reasoning ? 'Planning the search.' : '',
      toolCalls: tools.map((tool) => ({ id: tool.id, name: tool.name, arguments: tool.args })),
    };
    this.sink.event({ type: 'message_start', message: note });
    if (reasoning)
      this.sink.event({
        type: 'message_delta',
        kind: 'thinking',
        delta: note.thinking,
        message: note,
      });
    this.sink.event({ type: 'message_delta', kind: 'text', delta: note.text, message: note });
    this.sink.event({ type: 'message_end', message: note });
    this.messages.push(note);
    for (const tool of tools) {
      const details = tool.name === 'edit' ? { diff: tool.text, patch: tool.text } : {};
      this.sink.event({
        type: 'tool_start',
        toolCallId: tool.id,
        toolName: tool.name,
        args: tool.args,
      });
      this.sink.event({
        type: 'tool_end',
        toolCallId: tool.id,
        toolName: tool.name,
        text: tool.text,
        details,
        isError: false,
      });
      this.messages.push({
        role: 'toolResult',
        toolCallId: tool.id,
        toolName: tool.name,
        text: tool.text,
        details,
        isError: false,
        timestamp: Date.now(),
      });
    }
    const answer = assistantMessage(reasoning ? 'Found one match.' : 'Done: tests pass.');
    this.emitAssistant(answer, false);
    this.settle();
  }
  private settle(): void {
    this.sink.event({ type: 'turn_end' });
    this.sink.event({ type: 'agent_end', willRetry: false });
    this.sink.event({ type: 'agent_settled' });
    this.state = { ...this.state, isStreaming: false, messageCount: this.messages.length };
    this.sink.status('idle');
  }
}

function freshState(sessionId = 'fake-session-1'): RuntimeAgentState {
  return {
    model: MODEL,
    thinkingLevel: 'medium',
    isStreaming: false,
    isCompacting: false,
    sessionFile: null,
    persisted: false,
    sessionId,
    sessionName: null,
    autoCompactionEnabled: true,
    messageCount: 0,
    pendingMessageCount: 0,
  };
}
function userMessage(text: string): Extract<AgentMessage, { role: 'user' }> {
  return { role: 'user', text, images: [], timestamp: Date.now() };
}
function assistantMessage(
  text: string,
  stopReason: 'stop' | 'error' | 'aborted' = 'stop',
): Extract<AgentMessage, { role: 'assistant' }> {
  return {
    role: 'assistant',
    text,
    thinking: '',
    toolCalls: [],
    provider: 'fake',
    model: MODEL.id,
    usage: {
      input: 1_200,
      output: 340,
      cacheRead: 800,
      cacheWrite: 100,
      reasoning: 0,
      totalTokens: 2_440,
      cost: 0,
    },
    stopReason,
    errorMessage: stopReason === 'error' ? 'provider unavailable (503)' : null,
    timestamp: Date.now(),
  };
}
