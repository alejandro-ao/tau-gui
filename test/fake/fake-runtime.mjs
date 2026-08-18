#!/usr/bin/env node
/**
 * Deterministic fake Tau/Pi RPC runtime.
 *
 * Speaks the same strict LF-only JSONL protocol as `tau --mode rpc` and replays
 * scripted event streams selected by keywords in the prompt. Used by unit,
 * contract, and Electron end-to-end tests so no paid provider is ever required.
 *
 * Usage: node fake-runtime.mjs --mode rpc [--cwd DIR] [...ignored]
 */
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const cwdIndex = args.indexOf('--cwd');
const cwd = cwdIndex >= 0 ? args[cwdIndex + 1] : process.cwd();
const kind = process.env.FAKE_RUNTIME_KIND === 'pi' ? 'pi' : 'tau';
const baseDelay = Number(process.env.FAKE_RUNTIME_DELAY_MS ?? '0');
let stepDelay = baseDelay;

const MODELS = [
  {
    id: 'fake-large',
    name: 'Fake Large',
    api: 'openai-responses',
    provider: 'fake',
    baseUrl: 'http://localhost:0/v1',
    reasoning: true,
    input: ['text', 'image'],
    contextWindow: 200000,
    maxTokens: 32768,
    cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
  },
  {
    id: 'fake-small',
    name: 'Fake Small',
    api: 'openai-completions',
    provider: 'fake',
    baseUrl: 'http://localhost:0/v1',
    reasoning: false,
    input: ['text'],
    contextWindow: 64000,
    maxTokens: 8192,
    cost: { input: 0.2, output: 0.4, cacheRead: 0, cacheWrite: 0 },
  },
];

const state = {
  modelIndex: 0,
  thinkingLevel: 'medium',
  autoCompaction: true,
  sessionId: 'fake-session-1',
  sessionName: null,
  sessionFile: `${cwd}/.fake/session-1.jsonl`,
  streaming: false,
  messages: [],
  entries: [],
  steering: [],
  followUp: [],
  aborted: false,
  toolCalls: 0,
  turns: 0,
  lastExtensionResponse: null,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const now = () => 1700000000000 + state.messages.length * 1000;

function write(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function respond(id, command, data, includeData = false) {
  const record = { type: 'response', command, success: true };
  if (id !== undefined) record.id = id;
  if (data !== undefined || includeData) record.data = data ?? null;
  write(record);
}

function fail(id, command, error) {
  const record = { type: 'response', command, success: false, error };
  if (id !== undefined) record.id = id;
  write(record);
}

function model() {
  return MODELS[state.modelIndex];
}

function pushEntry(message) {
  state.messages.push(message);
  state.entries.push({
    type: 'message',
    id: `entry-${state.entries.length + 1}`,
    parentId: state.entries.length ? `entry-${state.entries.length}` : null,
    timestamp: new Date(now()).toISOString().replace('.000Z', 'Z'),
    message,
  });
}

function usage(input, output) {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    cacheWrite1h: null,
    reasoning: null,
    totalTokens: input + output,
    cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
  };
}

function assistant(content, stopReason, errorMessage = null) {
  return {
    role: 'assistant',
    content,
    api: model().api,
    provider: model().provider,
    model: model().id,
    responseModel: model().id,
    responseProvider: model().provider,
    responseId: 'resp-1',
    diagnostics: null,
    usage: usage(120, 30),
    stopReason,
    errorMessage,
    timestamp: now(),
  };
}

async function streamAssistant({
  text = '',
  thinking = '',
  toolCalls = [],
  stopReason = 'stop',
  errorMessage = null,
}) {
  const content = [];
  if (thinking)
    content.push({ type: 'thinking', thinking: '', thinkingSignature: null, redacted: false });
  write({ type: 'message_start', message: assistant(content, null) });

  if (thinking) {
    for (const chunk of chunks(thinking)) {
      content[0].thinking += chunk;
      write({
        type: 'message_update',
        message: assistant(structuredClone(content), null),
        assistantMessageEvent: {
          type: 'thinking_delta',
          contentIndex: 0,
          delta: chunk,
          partial: assistant(structuredClone(content), null),
        },
      });
      if (stepDelay) await sleep(stepDelay);
      if (state.aborted) return abortAssistant(content);
    }
  }

  if (text) {
    const index = content.length;
    content.push({ type: 'text', text: '', textSignature: null });
    for (const chunk of chunks(text)) {
      content[index].text += chunk;
      write({
        type: 'message_update',
        message: assistant(structuredClone(content), null),
        assistantMessageEvent: {
          type: 'text_delta',
          contentIndex: index,
          delta: chunk,
          partial: assistant(structuredClone(content), null),
        },
      });
      if (stepDelay) await sleep(stepDelay);
      if (state.aborted) return abortAssistant(content);
    }
  }

  for (const call of toolCalls) {
    content.push({
      type: 'toolCall',
      id: call.id,
      name: call.name,
      arguments: call.args,
      thoughtSignature: null,
    });
  }

  const message = assistant(
    structuredClone(content),
    errorMessage ? 'error' : stopReason,
    errorMessage,
  );
  pushEntry(message);
  write({ type: 'message_end', message });
  return message;
}

function abortAssistant(content) {
  const message = assistant(structuredClone(content), 'aborted', null);
  pushEntry(message);
  write({ type: 'message_end', message });
  return message;
}

function chunks(text) {
  const parts = [];
  for (let index = 0; index < text.length; index += 12) parts.push(text.slice(index, index + 12));
  return parts;
}

async function runTool(call, output, isError = false) {
  state.toolCalls += 1;
  write({
    type: 'tool_execution_start',
    toolCallId: call.id,
    toolName: call.name,
    args: call.args,
  });
  write({
    type: 'tool_execution_update',
    toolCallId: call.id,
    toolName: call.name,
    args: call.args,
    partialResult: {
      content: [{ type: 'text', text: output.slice(0, 8) }],
      details: {},
      addedToolNames: null,
      terminate: null,
    },
  });
  if (stepDelay) await sleep(stepDelay);
  const result = {
    content: [{ type: 'text', text: output }],
    details: { exit_code: isError ? 1 : 0 },
    addedToolNames: null,
    terminate: null,
  };
  write({ type: 'tool_execution_end', toolCallId: call.id, toolName: call.name, result, isError });
  const message = {
    role: 'toolResult',
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: 'text', text: output }],
    details: result.details,
    addedToolNames: null,
    isError,
    timestamp: now(),
  };
  pushEntry(message);
  write({ type: 'message_start', message });
  write({ type: 'message_end', message });
}

async function runPrompt(message) {
  state.streaming = true;
  state.aborted = false;
  state.turns += 1;
  write({ type: 'agent_start' });
  write({ type: 'turn_start' });

  const user = { role: 'user', content: message, timestamp: now() };
  pushEntry(user);
  write({ type: 'message_start', message: user });
  write({ type: 'message_end', message: user });

  const lower = message.toLowerCase();
  try {
    if (lower.includes('error')) {
      await streamAssistant({
        text: 'I could not reach the provider.',
        errorMessage: 'provider unavailable (503)',
      });
    } else if (lower.includes('tool')) {
      const read = { id: 'call-1', name: 'read', args: { path: 'src/index.ts' } };
      const edit = {
        id: 'call-2',
        name: 'edit',
        args: { path: 'src/index.ts', oldText: 'a', newText: 'b' },
      };
      const bash = {
        id: 'call-3',
        name: 'bash',
        args: { command: 'npm test', description: 'Running tests' },
      };
      await streamAssistant({ text: 'Inspecting the project.', toolCalls: [read, edit, bash] });
      await runTool(read, 'export const value = 1;\n');
      await runTool(edit, '--- src/index.ts\n+++ src/index.ts\n@@\n-a\n+b\n');
      await runTool(bash, '2 passed, 0 failed\n');
      write({ type: 'turn_end' });
      write({ type: 'turn_start' });
      await streamAssistant({ text: 'Done: tests pass.' });
    } else if (lower.includes('thinking')) {
      await streamAssistant({
        thinking: 'Considering the request carefully.',
        text: 'Here is the answer.',
      });
    } else if (lower.includes('compact')) {
      write({ type: 'compaction_start', reason: 'overflow' });
      write({
        type: 'compaction_end',
        reason: 'overflow',
        result: null,
        aborted: false,
        willRetry: true,
        errorMessage: null,
      });
      write({
        type: 'auto_retry_start',
        attempt: 1,
        maxAttempts: 1,
        delayMs: 0,
        errorMessage: 'Context overflow',
      });
      await streamAssistant({ text: 'Recovered after compaction.' });
      write({ type: 'auto_retry_end', success: true, attempt: 1, finalError: null });
    } else if (lower.includes('slow')) {
      // Deliberately paced so tests can cancel or steer mid-run.
      stepDelay = Math.max(baseDelay, 10);
      await streamAssistant({
        text: 'Working slowly so this run can be cancelled or steered. '.repeat(6),
      });
      stepDelay = baseDelay;
    } else {
      await streamAssistant({ text: `Hello from the ${kind} fake runtime.` });
    }

    while (state.steering.length > 0 || state.followUp.length > 0) {
      const queued = state.steering.shift() ?? state.followUp.shift();
      write({ type: 'turn_start' });
      const queuedUser = { role: 'user', content: queued, timestamp: now() };
      pushEntry(queuedUser);
      write({ type: 'message_start', message: queuedUser });
      write({ type: 'message_end', message: queuedUser });
      await streamAssistant({ text: `Acknowledged: ${queued}` });
      write({ type: 'queue_update', steering: [...state.steering], followUp: [...state.followUp] });
    }
  } finally {
    write({ type: 'turn_end' });
    write({ type: 'agent_end', messages: [], willRetry: false });
    write({ type: 'agent_settled' });
    state.streaming = false;
  }
}

function stats() {
  return {
    sessionFile: state.sessionFile,
    sessionId: state.sessionId,
    userMessages: state.messages.filter((m) => m.role === 'user').length,
    assistantMessages: state.messages.filter((m) => m.role === 'assistant').length,
    toolCalls: state.toolCalls,
    toolResults: state.toolCalls,
    totalMessages: state.messages.length,
    tokens: { input: 1200, output: 340, cacheRead: 800, cacheWrite: 100, total: 2440 },
    cost: 0.42,
    contextUsage: { tokens: 12000, contextWindow: model().contextWindow, percent: 6 },
  };
}

function tree() {
  const nodes = state.entries.map((entry) => ({ entry, children: [] }));
  for (let index = nodes.length - 1; index > 0; index -= 1) {
    nodes[index - 1].children.push(nodes[index]);
  }
  return nodes.length ? [nodes[0]] : [];
}

function leafId() {
  return state.entries.length ? `entry-${state.entries.length}` : null;
}

async function dispatch(command) {
  const id = command.id;
  const type = command.type;
  try {
    switch (type) {
      case 'prompt':
      case 'steer':
      case 'follow_up': {
        const message = command.message;
        if (typeof message !== 'string' || !message)
          throw new Error('message must be a non-empty string');
        let behavior = type === 'steer' ? 'steer' : type === 'follow_up' ? 'follow_up' : null;
        if (command.streamingBehavior === 'steer') behavior = 'steer';
        if (command.streamingBehavior === 'followUp') behavior = 'follow_up';
        if (state.streaming && behavior === null) {
          throw new Error('Agent is already streaming; set streamingBehavior to steer or followUp');
        }
        if (state.streaming && behavior === 'steer') {
          state.steering.push(message);
          respond(id, type);
          write({
            type: 'queue_update',
            steering: [...state.steering],
            followUp: [...state.followUp],
          });
          return;
        }
        if (state.streaming && behavior === 'follow_up') {
          state.followUp.push(message);
          respond(id, type);
          write({
            type: 'queue_update',
            steering: [...state.steering],
            followUp: [...state.followUp],
          });
          return;
        }
        respond(id, type);
        void runPrompt(message);
        return;
      }
      case 'abort':
        state.aborted = true;
        respond(id, type);
        return;
      case 'get_state':
        respond(id, type, {
          model: model(),
          thinkingLevel: state.thinkingLevel,
          isStreaming: state.streaming,
          isCompacting: false,
          steeringMode: 'one-at-a-time',
          followUpMode: 'one-at-a-time',
          sessionFile: state.sessionFile,
          sessionId: state.sessionId,
          sessionName: state.sessionName,
          autoCompactionEnabled: state.autoCompaction,
          messageCount: state.messages.length,
          pendingMessageCount: state.steering.length + state.followUp.length,
        });
        return;
      case 'get_messages':
        respond(id, type, { messages: state.messages });
        return;
      case 'get_available_models':
        respond(id, type, { models: MODELS });
        return;
      case 'set_model': {
        const index = MODELS.findIndex((item) => item.id === command.modelId);
        if (index < 0) throw new Error(`Model is not available: ${String(command.modelId)}`);
        state.modelIndex = index;
        respond(id, type, model());
        return;
      }
      case 'cycle_model':
        state.modelIndex = (state.modelIndex + 1) % MODELS.length;
        respond(id, type, { model: model(), thinkingLevel: state.thinkingLevel, isScoped: false });
        return;
      case 'get_available_thinking_levels':
        respond(id, type, { levels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] });
        return;
      case 'cycle_thinking_level': {
        const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];
        state.thinkingLevel = levels[(levels.indexOf(state.thinkingLevel) + 1) % levels.length];
        respond(id, type, { level: state.thinkingLevel });
        return;
      }
      case 'set_thinking_level': {
        const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];
        if (!levels.includes(command.level))
          throw new Error(`Unknown thinking mode: ${String(command.level)}`);
        state.thinkingLevel = command.level;
        respond(id, type);
        return;
      }
      case 'compact':
        respond(id, type, {
          summary: 'Compacted fake session.',
          firstKeptEntryId: leafId(),
          tokensBefore: 120000,
          estimatedTokensAfter: 4000,
          details: {},
        });
        return;
      case 'set_auto_compaction':
        if (typeof command.enabled !== 'boolean') throw new Error('enabled must be a boolean');
        state.autoCompaction = command.enabled;
        respond(id, type);
        return;
      case 'bash': {
        const shellCommand = command.command;
        if (typeof shellCommand !== 'string' || !shellCommand)
          throw new Error('command must be a non-empty string');
        respond(id, type, {
          output: `fake output for: ${shellCommand}\n`,
          exitCode: 0,
          cancelled: false,
          truncated: false,
        });
        return;
      }
      case 'abort_bash':
        if (kind === 'tau') throw new Error('abort_bash is not supported by Tau yet');
        respond(id, type, { cancelled: true });
        return;
      case 'new_session':
        state.messages = [];
        state.entries = [];
        state.sessionId = `fake-session-${Date.now()}`;
        state.sessionName = null;
        respond(id, type, { cancelled: false });
        return;
      case 'switch_session': {
        const ref = command.sessionId ?? command.sessionPath;
        if (typeof ref !== 'string') throw new Error('switch_session requires sessionPath');
        state.sessionId = ref;
        respond(id, type, { cancelled: false });
        return;
      }
      case 'get_session_stats':
        respond(id, type, stats());
        return;
      case 'export_html':
        respond(id, type, { path: command.outputPath ?? `${cwd}/session.html` });
        return;
      case 'get_entries': {
        let entries = state.entries;
        if (typeof command.since === 'string') {
          const index = entries.findIndex((entry) => entry.id === command.since);
          if (index < 0) throw new Error(`Entry not found: ${command.since}`);
          entries = entries.slice(index + 1);
        }
        respond(id, type, { entries, leafId: leafId() });
        return;
      }
      case 'get_tree':
        respond(id, type, { tree: tree(), leafId: leafId() });
        return;
      case 'get_fork_messages':
        respond(id, type, {
          messages: state.entries
            .filter((entry) => entry.message?.role === 'user')
            .map((entry) => ({ entryId: entry.id, text: entry.message.content })),
        });
        return;
      case 'get_last_assistant_text': {
        const last = [...state.messages].reverse().find((m) => m.role === 'assistant');
        respond(id, type, {
          text: last
            ? last.content
                .filter((b) => b.type === 'text')
                .map((b) => b.text)
                .join('')
            : null,
        });
        return;
      }
      case 'set_session_name':
        if (typeof command.name !== 'string' || !command.name)
          throw new Error('name must be a non-empty string');
        state.sessionName = command.name;
        respond(id, type);
        return;
      case 'fork': {
        const entry = state.entries.find((item) => item.id === command.entryId);
        if (!entry) throw new Error(`Unknown session entry: ${String(command.entryId)}`);
        respond(id, type, {
          text: entry.message?.role === 'user' ? entry.message.content : '',
          cancelled: false,
        });
        return;
      }
      case 'extension_dialog_probe':
        // Test hook: emit both a blocking dialog and a fire-and-forget status.
        write({
          type: 'extension_ui_request',
          id: 'dialog-1',
          method: 'confirm',
          message: 'Proceed?',
        });
        write({
          type: 'extension_ui_request',
          id: 'status-1',
          method: 'setStatus',
          statusKey: 'demo',
          statusText: '\u001b[38;2;138;190;183mdemo\u001b[39m connected',
        });
        respond(id, type);
        return;
      case 'extension_ui_response':
        state.lastExtensionResponse = command;
        return;
      case 'get_commands':
        respond(id, type, {
          commands: [
            {
              name: 'compact',
              description: 'Compact the session',
              source: 'extension',
              sourceInfo: {},
            },
            {
              name: 'review',
              description: 'Review the working tree',
              source: 'extension',
              sourceInfo: {},
            },
          ],
        });
        return;
      default:
        throw new Error(`Unknown command: ${String(type)}`);
    }
  } catch (error) {
    fail(id, typeof type === 'string' ? type : 'parse', error.message);
  }
}

const reader = createInterface({ input: process.stdin, crlfDelay: Infinity });
reader.on('line', (raw) => {
  const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
  if (!line.trim()) return;
  let value;
  try {
    value = JSON.parse(line);
  } catch (error) {
    fail(undefined, 'parse', `Failed to parse command: ${error.message}`);
    return;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(undefined, 'parse', 'Command must be a JSON object');
    return;
  }
  void dispatch(value);
});
reader.on('close', () => process.exit(0));
