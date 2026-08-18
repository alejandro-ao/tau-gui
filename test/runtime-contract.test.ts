import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEvent, RuntimeKind, RuntimeStatus } from '../src/shared/domain.js';
import { JsonlAgentRuntime } from '../src/main/runtime/agent-runtime.js';

const FAKE = fileURLToPath(new URL('./fake/fake-runtime.mjs', import.meta.url));

interface Harness {
  runtime: JsonlAgentRuntime;
  events: AgentEvent[];
  statuses: RuntimeStatus[];
  details: (string | null)[];
  diagnostics: string[];
  settled: () => Promise<void>;
}

async function launch(kind: RuntimeKind): Promise<Harness> {
  const events: AgentEvent[] = [];
  const statuses: RuntimeStatus[] = [];
  const details: (string | null)[] = [];
  const diagnostics: string[] = [];
  let notifySettled: (() => void) | null = null;

  const runtime = new JsonlAgentRuntime(kind, {
    event: (event) => {
      events.push(event);
      if (event.type === 'agent_settled') notifySettled?.();
    },
    status: (status, detail) => {
      statuses.push(status);
      details.push(detail ?? null);
    },
    diagnostic: (line) => diagnostics.push(line),
  });

  await runtime.start({
    kind,
    binary: FAKE,
    cwd: process.cwd(),
    provider: null,
    model: null,
    sessionRef: null,
    extraArgs: [],
    projectTrust: 'default',
  });

  return {
    runtime,
    events,
    statuses,
    details,
    diagnostics,
    settled: () =>
      new Promise<void>((resolve) => {
        if (events.some((event) => event.type === 'agent_settled')) {
          resolve();
          return;
        }
        notifySettled = resolve;
      }),
  };
}

let active: Harness | null = null;

afterEach(async () => {
  await active?.runtime.stop();
  active = null;
});

/**
 * The same application-domain contract runs against both adapters. Runtime
 * differences must appear only through capability flags.
 */
describe.each<RuntimeKind>(['tau', 'pi'])('%s adapter contract', (kind) => {
  it('reports a normalized state snapshot after start', async () => {
    active = await launch(kind);
    const state = await active.runtime.getState();
    expect(state.sessionId).toBe('fake-session-1');
    expect(state.model?.provider).toBe('fake');
    expect(state.thinkingLevel).toBe('medium');
    expect(active.statuses).toEqual(['starting', 'idle']);
  });

  it('streams a text turn and settles', async () => {
    active = await launch(kind);
    await active.runtime.prompt({ text: 'hello' });
    await active.settled();
    const types = active.events.map((event) => event.type);
    expect(types).toContain('agent_start');
    expect(types).toContain('message_delta');
    expect(types.at(-1)).toBe('agent_settled');

    const final = active.events.find(
      (event) => event.type === 'message_end' && event.message.role === 'assistant',
    );
    expect(
      final?.type === 'message_end' && final.message.role === 'assistant' && final.message.text,
    ).toContain('fake runtime');
  });

  it('streams thinking content', async () => {
    active = await launch(kind);
    await active.runtime.prompt({ text: 'show thinking' });
    await active.settled();
    const thinking = active.events.filter(
      (event) => event.type === 'message_delta' && event.kind === 'thinking',
    );
    expect(thinking.length).toBeGreaterThan(0);
  });

  it('reports tool lifecycle in order', async () => {
    active = await launch(kind);
    await active.runtime.prompt({ text: 'use a tool' });
    await active.settled();
    const tools = active.events.filter((event) => event.type.startsWith('tool_'));
    expect(tools.map((event) => event.type)).toEqual([
      'tool_start',
      'tool_update',
      'tool_end',
      'tool_start',
      'tool_update',
      'tool_end',
      'tool_start',
      'tool_update',
      'tool_end',
    ]);
    const end = tools.find((event) => event.type === 'tool_end');
    expect(end?.type === 'tool_end' && end.toolName).toBe('read');
  });

  it('surfaces provider errors on the assistant message', async () => {
    active = await launch(kind);
    await active.runtime.prompt({ text: 'trigger an error' });
    await active.settled();
    const failed = active.events.find(
      (event) =>
        event.type === 'message_end' &&
        event.message.role === 'assistant' &&
        event.message.stopReason === 'error',
    );
    expect(failed).toBeDefined();
  });

  it('emits compaction and retry events for overflow recovery', async () => {
    active = await launch(kind);
    await active.runtime.prompt({ text: 'force compact' });
    await active.settled();
    const types = active.events.map((event) => event.type);
    expect(types).toContain('compaction_start');
    expect(types).toContain('compaction_end');
    expect(types).toContain('retry_start');
    expect(types).toContain('retry_end');
  });

  it('queues steering and follow-up messages while running', async () => {
    active = await launch(kind);
    await active.runtime.prompt({ text: 'slow work' });
    await active.runtime.steer({ text: 'also check the docs' });
    await active.runtime.followUp({ text: 'then summarize' });
    await active.settled();
    const queue = active.events.filter((event) => event.type === 'queue_update');
    expect(queue.length).toBeGreaterThan(0);
    const acknowledged = active.events.filter(
      (event) =>
        event.type === 'message_end' &&
        event.message.role === 'assistant' &&
        event.message.text.startsWith('Acknowledged:'),
    );
    expect(acknowledged).toHaveLength(2);
  });

  it('supports models, thinking levels, sessions, shell, and export', async () => {
    active = await launch(kind);
    const runtime = active.runtime;

    const models = await runtime.listModels();
    expect(models.map((model) => model.id)).toEqual(['fake-large', 'fake-small']);
    expect(await runtime.setModel({ provider: 'fake', modelId: 'fake-small' })).toMatchObject({
      id: 'fake-small',
    });
    expect((await runtime.cycleModel())?.model.id).toBe('fake-large');

    expect(await runtime.listThinkingLevels()).toContain('xhigh');
    await runtime.setThinking('high');
    expect(await runtime.cycleThinking()).toBe('xhigh');

    const shell = await runtime.runShell('echo hi', true);
    expect(shell.output).toContain('echo hi');
    expect(shell.exitCode).toBe(0);

    await runtime.nameSession('contract session');
    expect((await runtime.getState()).sessionName).toBe('contract session');

    const compaction = await runtime.compact('be brief');
    expect(compaction.tokensBefore).toBeGreaterThan(0);

    expect(await runtime.exportHtml('/tmp/tau-gui-contract.html')).toBe(
      '/tmp/tau-gui-contract.html',
    );

    const commands = await runtime.listCommands();
    expect(commands.map((command) => command.name)).toContain('review');

    const stats = await runtime.getStats();
    expect(stats.contextUsage.contextWindow).toBeGreaterThan(0);
  });

  it('exposes entries and a tree after a turn', async () => {
    active = await launch(kind);
    await active.runtime.prompt({ text: 'hello' });
    await active.settled();
    const snapshot = await active.runtime.getEntries();
    expect(snapshot.entries.length).toBeGreaterThan(0);
    expect(snapshot.leafId).not.toBeNull();
    const tree = await active.runtime.getTree();
    expect(tree.tree).toHaveLength(1);
  });

  it('sends exactly one session reference field on switch_session', async () => {
    active = await launch(kind);
    await active.runtime.switchSession('session-ref-1');
    const client = active.runtime as unknown as {
      rpc: { request: (command: string) => Promise<unknown> };
    };
    const probe = (await client.rpc.request('switch_session_probe')) as { field: string };
    // Tau resumes by indexed id, Pi by session path (docs/rpc-protocol.md).
    expect(probe.field).toBe(kind === 'tau' ? 'sessionId' : 'sessionPath');
  });

  it('rejects unknown commands with the runtime error text', async () => {
    active = await launch(kind);
    await expect(active.runtime.setModel({ provider: 'fake', modelId: 'nope' })).rejects.toThrow(
      'Model is not available',
    );
  });
});

describe('extension UI requests', () => {
  it('dismisses blocking dialogs and records status updates as diagnostics', async () => {
    active = await launch('pi');
    // The fake runtime emits one confirm dialog and one fire-and-forget status.
    await active.runtime.exportHtml('/tmp/tau-gui-extension.html');
    const client = active.runtime as unknown as {
      rpc: { request: (command: string) => Promise<unknown> };
    };
    await client.rpc.request('extension_dialog_probe');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      active.diagnostics.some((line) => line.includes('Dismissed unsupported extension dialog')),
    ).toBe(true);
    expect(
      active.diagnostics.some((line) => line.includes('extension setStatus: demo connected')),
    ).toBe(true);
    expect(active.events.some((event) => event.type === 'runtime_error')).toBe(false);
  });
});

describe('capability gating', () => {
  it('refuses direct bash cancellation on Tau but allows it on Pi', async () => {
    active = await launch('tau');
    expect(active.runtime.capabilities.abortBash).toBe(false);
    await expect(active.runtime.abortShell()).rejects.toThrow('does not support');
    await active.runtime.stop();

    active = await launch('pi');
    expect(active.runtime.capabilities.abortBash).toBe(true);
  });

  it('reports disconnection and rejects pending work when the runtime is killed', async () => {
    active = await launch('tau');
    const harness = active;
    const child = (harness.runtime as unknown as { child: { pid: number } | null }).child;
    expect(child?.pid).toBeGreaterThan(0);

    // A request that will never be answered, then a hard crash.
    const pending = harness.runtime.getStats();
    process.kill(child?.pid as number, 'SIGKILL');

    await expect(pending).rejects.toThrow(/Runtime exited/);
    expect(harness.statuses.at(-1)).toBe('disconnected');
    expect(harness.details.at(-1)).toContain('Runtime exited unexpectedly');
    // Later requests fail fast instead of hanging on a dead process.
    await expect(harness.runtime.getState()).rejects.toThrow('Runtime connection is closed');
  });
});
