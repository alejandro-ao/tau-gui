/**
 * Preload IPC contract.
 *
 * Every renderer → main call is a single validated `{ action, payload }` record
 * on one channel. Every main → renderer push is a validated domain event.
 */
import { z } from 'zod';
import { resourceCatalogSchema } from './resources.js';
import type {
  AgentEvent,
  AgentMessage,
  AgentState,
  AppSettings,
  BashResult,
  CommandInfo,
  CompactionResult,
  EntrySnapshot,
  Model,
  ModelCycleResult,
  ResourceCatalog,
  RuntimeCapabilities,
  RuntimeStatus,
  SessionStats,
  ThinkingLevel,
  TreeSnapshot,
} from './domain.js';
import { MAX_SCOPED_MODELS, isScopedModelKey, modelKey } from './scoped-models.js';

export interface RuntimeProbe {
  binary: string;
  resolved: string | null;
  version: string | null;
  error: string | null;
}

export const IPC_INVOKE_CHANNEL = 'tau:invoke';
export const IPC_EVENT_CHANNEL = 'tau:event';

const thinkingLevel = z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']);
const runtimeKind = z.enum(['tau', 'pi']);

/**
 * Transcript a renderer request is bound to. Session-scoped commands carry it
 * so the main process routes them to the process that owns that transcript,
 * never to whichever runtime happens to be selected when the call arrives.
 */
export const sessionTargetSchema = z.object({
  runtime: runtimeKind,
  sessionId: z.string().min(1),
});
export type SessionTarget = z.infer<typeof sessionTargetSchema>;
const projectTrust = z.enum(['default', 'approve-once', 'decline-once']);

const runtimeSettings = z.object({
  binary: z.string().min(1),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  extraArgs: z.array(z.string()),
});

// Full-map settings patches remain valid for import/repair, but interactive
// mutations use settings.toggleScopedModel so the main process updates atomically.
const scopedModelKeys = z.array(z.string().refine(isScopedModelKey)).max(MAX_SCOPED_MODELS);
const scopedModelRef = z
  .object({ runtime: runtimeKind, provider: z.string().min(1), modelId: z.string().min(1) })
  .refine(({ provider, modelId }) => isScopedModelKey(modelKey({ provider, modelId })), {
    message: 'encoded scoped model identity is too long',
  });

export const settingsPatchSchema = z
  .object({
    agentRuntime: runtimeKind,
    theme: z.enum(['tau-dark', 'tau-light', 'high-contrast', 'pure-black']),
    sidebarPosition: z.enum(['right', 'left', 'off']),
    turnNotification: z.enum(['desktop', 'off']),
    showThinking: z.boolean(),
    cwd: z.string().nullable(),
    projectTrust,
    runtime: z.object({ tau: runtimeSettings, pi: runtimeSettings }),
    scopedModels: z.object({ tau: scopedModelKeys, pi: scopedModelKeys }),
  })
  .partial();

export const requestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('settings.get') }),
  z.object({ action: z.literal('settings.update'), payload: settingsPatchSchema }),
  z.object({ action: z.literal('settings.toggleScopedModel'), payload: scopedModelRef }),
  z.object({ action: z.literal('settings.forgetSession'), payload: z.object({ id: z.string() }) }),

  z.object({
    action: z.literal('runtime.start'),
    payload: z.object({
      cwd: z.string().nullable().optional(),
      sessionRef: z.string().nullable().optional(),
    }),
  }),
  z.object({ action: z.literal('runtime.stop') }),
  z.object({ action: z.literal('runtime.restart') }),
  // The probe never accepts a renderer-supplied binary: only the runtime kind
  // may be selected, and the executable always comes from persisted settings.
  z.object({
    action: z.literal('runtime.probe'),
    payload: z.object({ kind: runtimeKind.optional() }).optional(),
  }),
  z.object({ action: z.literal('runtime.snapshot') }),

  z.object({ action: z.literal('agent.prompt'), payload: z.object({ text: z.string().min(1) }) }),
  z.object({ action: z.literal('agent.steer'), payload: z.object({ text: z.string().min(1) }) }),
  z.object({ action: z.literal('agent.followUp'), payload: z.object({ text: z.string().min(1) }) }),
  z.object({ action: z.literal('queue.snapshot') }).strict(),
  z.object({ action: z.literal('queue.pop') }).strict(),
  z.object({
    action: z.literal('queue.resolve'),
    payload: z.object({
      id: z.string().min(1),
      outcome: z.enum(['accept', 'restore']),
    }),
  }),
  z.object({ action: z.literal('agent.abort') }),
  z.object({ action: z.literal('agent.state') }),
  z.object({ action: z.literal('agent.messages') }),
  z.object({
    action: z.literal('agent.entries'),
    payload: z.object({ cursor: z.string().optional() }).optional(),
  }),
  z.object({ action: z.literal('agent.tree') }),
  z.object({ action: z.literal('agent.stats') }),

  z.object({ action: z.literal('models.list') }),
  z.object({
    action: z.literal('models.set'),
    payload: z.object({ provider: z.string().min(1), modelId: z.string().min(1) }),
  }),
  z.object({ action: z.literal('models.cycle') }),

  z.object({ action: z.literal('thinking.list') }),
  z.object({ action: z.literal('thinking.set'), payload: z.object({ level: thinkingLevel }) }),
  z.object({ action: z.literal('thinking.cycle') }),

  z.object({ action: z.literal('session.new') }),
  z.object({ action: z.literal('session.switch'), payload: z.object({ ref: z.string().min(1) }) }),
  z.object({ action: z.literal('session.name'), payload: z.object({ name: z.string().min(1) }) }),
  z.object({
    action: z.literal('session.fork'),
    payload: z.object({ entryId: z.string().min(1) }),
  }),
  z.object({
    action: z.literal('session.compact'),
    payload: z.object({ instructions: z.string().optional() }).optional(),
  }),
  z.object({
    action: z.literal('session.exportHtml'),
    payload: z.object({ destination: z.string().min(1) }).optional(),
  }),
  z.object({
    action: z.literal('session.autoCompaction'),
    payload: z.object({ enabled: z.boolean() }),
  }),

  z.object({
    action: z.literal('shell.run'),
    payload: z.object({ command: z.string().min(1), excludeFromContext: z.boolean() }),
  }),
  z.object({ action: z.literal('shell.abort') }),

  z.object({ action: z.literal('commands.list') }),
  z.object({ action: z.literal('resources.list') }).strict(),

  z.object({
    action: z.literal('fs.complete'),
    payload: z.object({ query: z.string(), limit: z.number().int().min(1).max(200).optional() }),
  }),
  z.object({ action: z.literal('fs.pickDirectory') }),
  z.object({
    action: z.literal('fs.relativize'),
    payload: z.object({ paths: z.array(z.string()) }),
  }),

  z.object({ action: z.literal('ui.openExternal'), payload: z.object({ url: z.string() }) }),
  z.object({ action: z.literal('ui.copyText'), payload: z.object({ text: z.string() }) }),
  z.object({ action: z.literal('ui.setTitle'), payload: z.object({ title: z.string() }) }),
  z.object({
    action: z.literal('ui.notify'),
    payload: z.object({ title: z.string(), body: z.string() }),
  }),
  z.object({ action: z.literal('diagnostics.list') }),
]);

export { resourceCatalogSchema };

export type IpcRequest = z.infer<typeof requestSchema>;
export type IpcAction = IpcRequest['action'];

/**
 * Wire envelope: the action union plus the optional transcript identity the
 * renderer believes it is acting on.
 */
export const envelopeSchema = z.intersection(
  requestSchema,
  z.object({ session: sessionTargetSchema.optional() }),
);
export type IpcEnvelope = IpcRequest & { session?: SessionTarget };

export interface RuntimeSnapshot {
  runtime: 'tau' | 'pi';
  status: RuntimeStatus;
  detail: string | null;
  /** Version reported by the runtime binary at launch, when known. */
  runtimeVersion: string | null;
  capabilities: RuntimeCapabilities;
  cwd: string | null;
  gitBranch: string | null;
  state: AgentState | null;
}

export interface FileCompletion {
  path: string;
  isDirectory: boolean;
}

export interface PromptQueueItem {
  /** Stable application identity; duplicate text is intentionally allowed. */
  id: string;
  kind: 'steering' | 'follow-up';
  text: string;
}

export interface PromptQueueSnapshot extends SessionTarget {
  steering: PromptQueueItem[];
  followUp: PromptQueueItem[];
}

/** Per-session run state used by the sessions rail, including background runtimes. */
export interface SessionActivity {
  sessionId: string;
  runtime: RuntimeSnapshot['runtime'];
  status: RuntimeStatus;
  /** `true` marks an unseen answer, `false` clears it, and `null` leaves it unchanged. */
  responseReady: boolean | null;
}

/** Maps every action to its resolved value. */
export interface IpcResultMap {
  'settings.get': AppSettings;
  'settings.update': AppSettings;
  'settings.toggleScopedModel': AppSettings;
  'settings.forgetSession': AppSettings;
  'runtime.start': RuntimeSnapshot;
  'runtime.stop': RuntimeSnapshot;
  'runtime.restart': RuntimeSnapshot;
  'runtime.probe': RuntimeProbe;
  'runtime.snapshot': RuntimeSnapshot;
  'agent.prompt': null;
  'agent.steer': null;
  'agent.followUp': null;
  'queue.snapshot': PromptQueueSnapshot;
  'queue.pop': PromptQueueItem | null;
  'queue.resolve': boolean;
  'agent.abort': null;
  'agent.state': AgentState;
  'agent.messages': AgentMessage[];
  'agent.entries': EntrySnapshot;
  'agent.tree': TreeSnapshot;
  'agent.stats': SessionStats;
  'models.list': Model[];
  'models.set': Model | null;
  'models.cycle': ModelCycleResult | null;
  'thinking.list': ThinkingLevel[];
  'thinking.set': null;
  'thinking.cycle': ThinkingLevel | null;
  'session.new': null;
  'session.switch': null;
  'session.name': null;
  'session.fork': string;
  'session.compact': CompactionResult;
  'session.exportHtml': string | null;
  'session.autoCompaction': null;
  'shell.run': BashResult;
  'shell.abort': null;
  'commands.list': CommandInfo[];
  'resources.list': ResourceCatalog;
  'fs.complete': FileCompletion[];
  'fs.pickDirectory': string | null;
  'fs.relativize': string[];
  'ui.openExternal': null;
  'ui.copyText': null;
  'ui.setTitle': null;
  'ui.notify': null;
  'diagnostics.list': string[];
}

export type IpcResult<A extends IpcAction> = IpcResultMap[A];

export type IpcResponse<A extends IpcAction = IpcAction> =
  { ok: true; value: IpcResult<A> } | { ok: false; error: string };

export type BridgeEvent =
  | {
      type: 'agent';
      /** Immutable routing identity for the transcript that produced this event. */
      sessionId: string;
      runtime: RuntimeSnapshot['runtime'];
      event: AgentEvent;
    }
  | { type: 'status'; snapshot: RuntimeSnapshot }
  | { type: 'queue'; snapshot: PromptQueueSnapshot }
  | { type: 'diagnostic'; message: string }
  | { type: 'settings'; settings: AppSettings }
  | { type: 'sessionActivity'; activity: SessionActivity }
  | { type: 'focus'; focused: boolean };

/** Payload extraction helper for typed bridge signatures. */
export type PayloadOf<A extends IpcAction> =
  Extract<IpcRequest, { action: A }> extends {
    payload: infer P;
  }
    ? P
    : undefined;
