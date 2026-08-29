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
  SessionSummary,
  ThinkingLevel,
  TreeNavigateResult,
  TreeSnapshot,
} from './domain.js';
import { MAX_SCOPED_MODELS, isScopedModelKey, modelKey } from './scoped-models.js';

export interface RuntimeProbe {
  binary: string;
  resolved: string | null;
  version: string | null;
  error: string | null;
}

export type ImportRecoveryHealth =
  | { available: true; retained: number; capacity: 32 }
  | { available: false; error: 'Import recovery is unavailable' };

export const IPC_INVOKE_CHANNEL = 'tau:invoke';
export const IPC_EVENT_CHANNEL = 'tau:event';

const thinkingLevel = z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']);
const runtimeKind = z.enum(['tau', 'pi']);
const safePathText = z
  .string()
  .min(1)
  .max(4_096)
  .refine(
    (value) =>
      ![...value].some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint <= 0x1f || codePoint === 0x7f;
      }),
    'Path contains control characters',
  );

/**
 * Pi walks AGENTS.md files from the working directory through its ancestors and
 * may also load the global agent file. Keep the metadata channel bounded
 * without assuming Tau's former fixed set of four locations.
 */
export const MAX_CONTEXT_FILES = 64;

/** Metadata only: AGENTS.md contents never cross IPC. */
export const contextFilesSchema = z
  .array(
    z
      .object({
        label: safePathText.max(256),
        path: safePathText,
      })
      .strict(),
  )
  .max(MAX_CONTEXT_FILES);
export type ContextFile = z.infer<typeof contextFilesSchema>[number];

/**
 * Transcript a renderer request is bound to. Session-scoped commands carry it
 * so the main process routes them to the process that owns that transcript,
 * never to whichever runtime happens to be selected when the call arrives.
 */
export const MAX_SESSION_CATALOG_ENTRIES = 500;
export const sessionSummarySchema = z
  .object({
    id: z.string().regex(/^(?:pi|recent)-[a-f0-9]{32}$/),
    source: z.enum(['native', 'recent']),
    runtime: runtimeKind,
    sessionId: z.string().min(1).max(128),
    exportable: z.boolean(),
    name: z.string().max(160).nullable(),
    firstMessage: z.string().max(500).nullable(),
    cwd: safePathText.nullable(),
    createdAt: z.number().finite().nonnegative(),
    modifiedAt: z.number().finite().nonnegative(),
    messageCount: z.number().int().min(0).max(1_000_000),
    parentSessionId: z.string().max(128).nullable(),
  })
  .strict();
export const sessionCatalogSchema = z.array(sessionSummarySchema).max(MAX_SESSION_CATALOG_ENTRIES);

export const MAX_TREE_ROWS = 2_000;
export const MAX_TREE_DEPTH = 128;
export const MAX_TREE_PREVIEW = 500;
export const treeRowSchema = z
  .object({
    id: z.string().min(1).max(128),
    parentId: z.string().min(1).max(128).nullable(),
    depth: z.number().int().min(0).max(MAX_TREE_DEPTH),
    kind: z.enum([
      'message',
      'custom_message',
      'model_change',
      'thinking_level_change',
      'compaction',
      'branch_summary',
      'custom',
      'label',
      'session_info',
    ]),
    role: z
      .enum([
        'user',
        'assistant',
        'toolResult',
        'bashExecution',
        'custom',
        'branchSummary',
        'compactionSummary',
      ])
      .nullable(),
    timestamp: z.string().max(64),
    preview: z.string().max(MAX_TREE_PREVIEW),
    label: z.string().max(120).nullable(),
  })
  .strict();
export const treeSnapshotSchema = z
  .object({
    rows: z.array(treeRowSchema).max(MAX_TREE_ROWS),
    leafId: z.string().max(128).nullable(),
    truncated: z.boolean(),
  })
  .strict();
export const MAX_TREE_EDITOR_TEXT = 100_000;
export const treeNavigateResultSchema = z
  .object({
    editorText: z.string().max(MAX_TREE_EDITOR_TEXT).nullable(),
    editorTextTruncated: z.boolean(),
    cancelled: z.boolean(),
    aborted: z.boolean(),
  })
  .strict();

export const sessionTargetSchema = z
  .object({
    runtime: runtimeKind,
    sessionId: z.string().min(1).max(128),
  })
  .strict();
export type SessionTarget = z.infer<typeof sessionTargetSchema>;
const projectTrust = z.enum(['default', 'approve-once', 'decline-once']);

const finiteNumber = z.number().finite();
const boundedText = (maximum: number) => z.string().max(maximum);
export const MAX_SESSION_NAME = 500;
export const sessionNameSchema = z
  .string()
  .max(MAX_SESSION_NAME)
  .transform((value) =>
    [...value.normalize('NFC')]
      .map((character) => (/\p{Cc}|\p{Cf}|\p{Cs}/u.test(character) ? ' ' : character))
      .join('')
      .trim(),
  )
  .pipe(z.string().min(1).max(MAX_SESSION_NAME));
const boundedJsonSchema = z.unknown().superRefine((value, context) => {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  let characters = 0;
  while (pending.length > 0) {
    const item = pending.pop()!;
    nodes += 1;
    if (nodes > 2_000 || item.depth > 8) {
      context.addIssue({ code: 'custom', message: 'Nested event data exceeds its bound' });
      return;
    }
    if (typeof item.value === 'string') {
      characters += item.value.length;
      if (characters > 200_000) {
        context.addIssue({ code: 'custom', message: 'Nested event text exceeds its bound' });
        return;
      }
    } else if (
      item.value === null ||
      typeof item.value === 'boolean' ||
      (typeof item.value === 'number' && Number.isFinite(item.value))
    ) {
      continue;
    } else if (Array.isArray(item.value)) {
      if (item.value.length > 500) {
        context.addIssue({ code: 'custom', message: 'Nested event array exceeds its bound' });
        return;
      }
      for (const child of item.value) pending.push({ value: child, depth: item.depth + 1 });
    } else if (typeof item.value === 'object' && item.value !== null) {
      const entries = Object.entries(item.value);
      if (entries.length > 200) {
        context.addIssue({ code: 'custom', message: 'Nested event object exceeds its bound' });
        return;
      }
      for (const [key, child] of entries) {
        characters += key.length;
        pending.push({ value: child, depth: item.depth + 1 });
      }
    } else {
      context.addIssue({ code: 'custom', message: 'Nested event data is not JSON' });
      return;
    }
  }
});

const boundedRecordSchema = z.record(z.string(), z.unknown()).superRefine((value, context) => {
  const parsed = boundedJsonSchema.safeParse(value);
  if (!parsed.success) {
    context.addIssue({ code: 'custom', message: 'Nested event object exceeds its bound' });
  }
});

const usageSchema = z
  .object({
    input: finiteNumber,
    output: finiteNumber,
    cacheRead: finiteNumber,
    cacheWrite: finiteNumber,
    reasoning: finiteNumber.nullable(),
    totalTokens: finiteNumber,
    cost: finiteNumber.nullable(),
  })
  .strict();
const modelSchema = z
  .object({
    id: boundedText(500),
    name: boundedText(500),
    provider: boundedText(200),
    api: boundedText(200),
    reasoning: z.boolean(),
    input: z.array(boundedText(100)).max(20),
    contextWindow: finiteNumber,
    maxTokens: finiteNumber,
    cost: z
      .object({
        input: finiteNumber,
        output: finiteNumber,
        cacheRead: finiteNumber,
        cacheWrite: finiteNumber,
      })
      .strict(),
  })
  .strict();
const toolCallSchema = z
  .object({ id: boundedText(500), name: boundedText(500), arguments: boundedRecordSchema })
  .strict();
export const agentMessageSchema = z.discriminatedUnion('role', [
  z
    .object({
      role: z.literal('user'),
      text: boundedText(500_000),
      images: z
        .array(z.object({ mimeType: boundedText(100), data: boundedText(750_000) }).strict())
        .max(20),
      timestamp: finiteNumber,
    })
    .strict(),
  z
    .object({
      role: z.literal('assistant'),
      text: boundedText(500_000),
      thinking: boundedText(500_000),
      toolCalls: z.array(toolCallSchema).max(500),
      provider: boundedText(200),
      model: boundedText(500),
      usage: usageSchema.nullable(),
      stopReason: z.enum(['stop', 'length', 'toolUse', 'error', 'aborted']).nullable(),
      errorMessage: boundedText(10_000).nullable(),
      timestamp: finiteNumber,
    })
    .strict(),
  z
    .object({
      role: z.literal('toolResult'),
      toolCallId: boundedText(500),
      toolName: boundedText(500),
      text: boundedText(500_000),
      details: boundedRecordSchema,
      isError: z.boolean(),
      timestamp: finiteNumber,
    })
    .strict(),
  z
    .object({
      role: z.literal('bashExecution'),
      command: boundedText(100_000),
      output: boundedText(500_000),
      exitCode: z.number().int().nullable(),
      cancelled: z.boolean(),
      truncated: z.boolean(),
      excludeFromContext: z.boolean(),
      timestamp: finiteNumber,
    })
    .strict(),
  z
    .object({
      role: z.literal('custom'),
      customType: boundedText(500),
      text: boundedText(500_000),
      display: z.boolean(),
      details: boundedRecordSchema,
      timestamp: finiteNumber,
    })
    .strict(),
  z
    .object({
      role: z.literal('branchSummary'),
      summary: boundedText(500_000),
      fromId: boundedText(500),
      timestamp: finiteNumber,
    })
    .strict(),
  z
    .object({
      role: z.literal('compactionSummary'),
      summary: boundedText(500_000),
      tokensBefore: finiteNumber,
      timestamp: finiteNumber,
    })
    .strict(),
]);

const eventId = z.string().min(1).max(500);
const eventArgs = boundedRecordSchema;
export const agentEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('agent_start') }).strict(),
  z.object({ type: z.literal('turn_start') }).strict(),
  z.object({ type: z.literal('message_start'), message: agentMessageSchema }).strict(),
  z
    .object({
      type: z.literal('message_delta'),
      kind: z.enum(['text', 'thinking']),
      delta: boundedText(500_000),
      message: agentMessageSchema.and(z.object({ role: z.literal('assistant') })),
    })
    .strict(),
  z.object({ type: z.literal('message_end'), message: agentMessageSchema }).strict(),
  z
    .object({
      type: z.literal('tool_start'),
      toolCallId: eventId,
      toolName: boundedText(500),
      args: eventArgs,
    })
    .strict(),
  z
    .object({
      type: z.literal('tool_update'),
      toolCallId: eventId,
      toolName: boundedText(500),
      args: eventArgs,
      partialText: boundedText(500_000),
    })
    .strict(),
  z
    .object({
      type: z.literal('tool_end'),
      toolCallId: eventId,
      toolName: boundedText(500),
      text: boundedText(500_000),
      details: boundedRecordSchema,
      isError: z.boolean(),
    })
    .strict(),
  z.object({ type: z.literal('turn_end') }).strict(),
  z.object({ type: z.literal('agent_end'), willRetry: z.boolean() }).strict(),
  z.object({ type: z.literal('agent_settled') }).strict(),
  z
    .object({
      type: z.literal('queue_update'),
      steering: z.array(boundedText(100_000)).max(500),
      followUp: z.array(boundedText(100_000)).max(500),
    })
    .strict(),
  z
    .object({
      type: z.literal('compaction_start'),
      reason: z.enum(['manual', 'threshold', 'overflow']),
    })
    .strict(),
  z
    .object({
      type: z.literal('compaction_end'),
      reason: z.enum(['manual', 'threshold', 'overflow']),
      aborted: z.boolean(),
      willRetry: z.boolean(),
      errorMessage: boundedText(10_000).nullable(),
    })
    .strict(),
  z
    .object({
      type: z.literal('retry_start'),
      attempt: z.number().int().nonnegative(),
      maxAttempts: z.number().int().nonnegative(),
      delayMs: z.number().int().nonnegative(),
      message: boundedText(10_000),
    })
    .strict(),
  z
    .object({
      type: z.literal('retry_end'),
      success: z.boolean(),
      attempt: z.number().int().nonnegative(),
      finalError: boundedText(10_000).nullable(),
    })
    .strict(),
  z.object({ type: z.literal('runtime_error'), message: boundedText(10_000) }).strict(),
]);

const runtimeSettings = z
  .object({
    binary: z.string().min(1).max(4_096),
    provider: boundedText(500).nullable(),
    model: boundedText(500).nullable(),
    extraArgs: z.array(boundedText(4_096)).max(100),
  })
  .strict();

// Full-map settings patches remain valid for import/repair, but interactive
// mutations use settings.toggleScopedModel so the main process updates atomically.
const scopedModelKeys = z.array(z.string().refine(isScopedModelKey)).max(MAX_SCOPED_MODELS);
const scopedModelRef = z
  .object({ runtime: runtimeKind, provider: z.string().min(1), modelId: z.string().min(1) })
  .refine(({ provider, modelId }) => isScopedModelKey(modelKey({ provider, modelId })), {
    message: 'encoded scoped model identity is too long',
  });

export const rendererSettingsSchema = z
  .object({
    agentRuntime: runtimeKind,
    theme: z.enum(['tau-dark', 'tau-light', 'high-contrast', 'pure-black']),
    sidebarPosition: z.enum(['right', 'left', 'off']),
    turnNotification: z.enum(['desktop', 'off']),
    showThinking: z.boolean(),
    cwd: safePathText.nullable(),
    workingDirectories: z.array(safePathText).max(100),
    customSkillDirectories: z.array(safePathText).max(100),
    customPromptDirectories: z.array(safePathText).max(100),
    projectTrust,
    runtime: z.object({ tau: runtimeSettings, pi: runtimeSettings }).strict(),
    scopedModels: z.object({ tau: scopedModelKeys, pi: scopedModelKeys }).strict(),
    recentSessions: z
      .array(
        z
          .object({
            id: z.string().min(1).max(128),
            name: boundedText(500).nullable(),
            firstMessage: boundedText(500).nullable().optional(),
            messageCount: z.number().int().nonnegative().max(1_000_000).optional(),
            path: z.null(),
            cwd: safePathText.nullable(),
            runtime: runtimeKind,
            lastSeen: finiteNumber.nonnegative(),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();

const runtimeCapabilitiesSchema = z
  .object({
    textPrompt: z.boolean(),
    imagePrompt: z.boolean(),
    steering: z.boolean(),
    followUps: z.boolean(),
    directBash: z.boolean(),
    abortBash: z.boolean(),
    retryControls: z.boolean(),
    sessionTree: z.boolean(),
    sessionClone: z.boolean(),
    sessionImport: z.boolean(),
    sessionList: z.boolean(),
    extensionDialogs: z.boolean(),
    providerLogin: z.boolean(),
    resourceReload: z.boolean(),
    systemPromptInspection: z.boolean(),
    toolCatalog: z.boolean(),
  })
  .strict();
export const rendererAgentStateSchema = z
  .object({
    model: modelSchema.nullable(),
    thinkingLevel,
    isStreaming: z.boolean(),
    isCompacting: z.boolean(),
    persisted: z.boolean(),
    sessionId: z.string().min(1).max(128),
    sessionName: boundedText(500).nullable(),
    autoCompactionEnabled: z.boolean(),
    messageCount: z.number().int().nonnegative().max(1_000_000),
    pendingMessageCount: z.number().int().nonnegative().max(100_000),
  })
  .strict();
export const runtimeSnapshotSchema: z.ZodType<RuntimeSnapshot> = z
  .object({
    runtime: runtimeKind,
    status: z.enum([
      'stopped',
      'starting',
      'idle',
      'running',
      'compacting',
      'retrying',
      'failed',
      'disconnected',
    ]),
    detail: boundedText(1_000).nullable(),
    runtimeVersion: boundedText(200).nullable(),
    capabilities: runtimeCapabilitiesSchema,
    cwd: safePathText.nullable(),
    gitBranch: boundedText(500).nullable(),
    state: rendererAgentStateSchema.nullable(),
    recoveryTarget: sessionTargetSchema.nullable().optional(),
  })
  .strict();

export const settingsPatchSchema = z
  .object({
    agentRuntime: runtimeKind,
    theme: z.enum(['tau-dark', 'tau-light', 'high-contrast', 'pure-black']),
    sidebarPosition: z.enum(['right', 'left', 'off']),
    turnNotification: z.enum(['desktop', 'off']),
    showThinking: z.boolean(),
    cwd: z.string().nullable(),
    workingDirectories: z.array(safePathText).max(100),
    projectTrust,
    runtime: z.object({ tau: runtimeSettings, pi: runtimeSettings }),
    scopedModels: z.object({ tau: scopedModelKeys, pi: scopedModelKeys }),
  })
  .strict()
  .partial();

const requestUnion = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('settings.get') }),
  z.strictObject({ action: z.literal('settings.update'), payload: settingsPatchSchema }),
  z.strictObject({ action: z.literal('settings.toggleScopedModel'), payload: scopedModelRef }),
  z.strictObject({
    action: z.literal('settings.addResourceDirectory'),
    payload: z.strictObject({ kind: z.enum(['skills', 'prompts']) }).strict(),
  }),
  z.strictObject({
    action: z.literal('settings.removeResourceDirectory'),
    payload: z.strictObject({ kind: z.enum(['skills', 'prompts']), path: safePathText }).strict(),
  }),
  z.strictObject({
    action: z.literal('settings.rememberWorkingDirectory'),
    payload: z.strictObject({ cwd: z.string().min(1) }).strict(),
  }),
  z.strictObject({
    action: z.literal('settings.forgetSession'),
    payload: z.strictObject({ id: z.string() }),
  }),

  z.strictObject({
    action: z.literal('runtime.start'),
    payload: z.strictObject({ cwd: z.string().nullable().optional() }).strict(),
  }),
  z.strictObject({
    action: z.literal('runtime.openSession'),
    payload: z.strictObject({ cwd: z.string().min(1) }).strict(),
  }),
  z.strictObject({ action: z.literal('runtime.stop') }),
  z.strictObject({ action: z.literal('runtime.restart') }),
  // The probe never accepts a renderer-supplied binary: only the runtime kind
  // may be selected, and the executable always comes from persisted settings.
  z.strictObject({
    action: z.literal('runtime.probe'),
    payload: z.strictObject({ kind: runtimeKind.optional() }).optional(),
  }),
  z.strictObject({ action: z.literal('runtime.snapshot') }),

  z.strictObject({
    action: z.literal('agent.prompt'),
    payload: z.strictObject({ text: z.string().min(1) }),
  }),
  z.strictObject({
    action: z.literal('agent.steer'),
    payload: z.strictObject({ text: z.string().min(1) }),
  }),
  z.strictObject({
    action: z.literal('agent.followUp'),
    payload: z.strictObject({ text: z.string().min(1) }),
  }),
  z.strictObject({ action: z.literal('queue.snapshot') }).strict(),
  z.strictObject({ action: z.literal('queue.pop') }).strict(),
  z.strictObject({
    action: z.literal('queue.resolve'),
    payload: z.strictObject({
      id: z.string().min(1),
      outcome: z.enum(['accept', 'restore']),
    }),
  }),
  z.strictObject({ action: z.literal('agent.abort') }),
  z.strictObject({ action: z.literal('agent.state') }),
  z.strictObject({ action: z.literal('agent.messages') }),
  z.strictObject({
    action: z.literal('agent.entries'),
    payload: z.strictObject({ cursor: z.string().optional() }).optional(),
  }),
  z.strictObject({ action: z.literal('agent.tree') }),
  z.strictObject({ action: z.literal('agent.stats') }),

  z.strictObject({ action: z.literal('models.list') }),
  z.strictObject({
    action: z.literal('models.set'),
    payload: z.strictObject({ provider: z.string().min(1), modelId: z.string().min(1) }),
  }),
  z.strictObject({ action: z.literal('models.cycle') }),

  z.strictObject({ action: z.literal('thinking.list') }),
  z.strictObject({
    action: z.literal('thinking.set'),
    payload: z.strictObject({ level: thinkingLevel }),
  }),
  z.strictObject({ action: z.literal('thinking.cycle') }),

  z.strictObject({ action: z.literal('session.new') }),
  z.strictObject({
    action: z.literal('session.switch'),
    payload: z
      .strictObject({ ref: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/) })
      .strict(),
  }),
  z
    .object({
      action: z.literal('session.name'),
      payload: z.strictObject({ name: sessionNameSchema }).strict(),
    })
    .strict(),
  z.strictObject({
    action: z.literal('session.fork'),
    payload: z
      .object({
        entryId: z.string().min(1).max(128),
        summary: z.enum(['none', 'default', 'custom']),
        customInstructions: z.string().trim().min(1).max(2_000).optional(),
        label: z.string().trim().min(1).max(120).optional(),
      })
      .strict()
      .superRefine((value, context) => {
        if (value.summary === 'custom' && !value.customInstructions) {
          context.addIssue({ code: 'custom', message: 'Custom summary instructions are required' });
        }
        if (value.summary !== 'custom' && value.customInstructions !== undefined) {
          context.addIssue({
            code: 'custom',
            message: 'Custom instructions require custom summary mode',
          });
        }
      }),
  }),
  z.strictObject({
    action: z.literal('session.label'),
    payload: z
      .object({
        entryId: z.string().min(1).max(128),
        label: z.string().trim().min(1).max(120).nullable(),
      })
      .strict(),
  }),
  z.strictObject({ action: z.literal('session.clone') }).strict(),
  z.strictObject({ action: z.literal('session.importJsonl') }).strict(),
  z.strictObject({ action: z.literal('session.importHealth') }).strict(),
  z.strictObject({ action: z.literal('session.revealImportRecovery') }).strict(),
  z.strictObject({
    action: z.literal('session.list'),
    payload: z.strictObject({ scope: z.enum(['cwd', 'all']) }).strict(),
  }),
  z.strictObject({
    action: z.literal('session.compact'),
    payload: z.strictObject({ instructions: z.string().optional() }).optional(),
  }),
  z.strictObject({ action: z.literal('session.exportHtml') }).strict(),
  z.strictObject({
    action: z.literal('session.exportJsonl'),
    payload: z
      .object({ sessionId: z.string().min(1).max(128).optional() })
      .strict()
      .optional(),
  }),
  z.strictObject({
    action: z.literal('session.autoCompaction'),
    payload: z.strictObject({ enabled: z.boolean() }),
  }),

  z.strictObject({
    action: z.literal('shell.run'),
    payload: z.strictObject({ command: z.string().min(1), excludeFromContext: z.boolean() }),
  }),
  z.strictObject({ action: z.literal('shell.abort') }),

  z.strictObject({ action: z.literal('commands.list') }),
  z.strictObject({ action: z.literal('resources.list') }).strict(),
  z.strictObject({ action: z.literal('context.list') }).strict(),

  z.strictObject({
    action: z.literal('fs.complete'),
    payload: z.strictObject({
      query: z.string(),
      limit: z.number().int().min(1).max(200).optional(),
    }),
  }),
  z.strictObject({ action: z.literal('fs.pickDirectory') }),
  z.strictObject({
    action: z.literal('fs.relativize'),
    payload: z.strictObject({ paths: z.array(z.string()) }),
  }),

  z.strictObject({
    action: z.literal('ui.openExternal'),
    payload: z.strictObject({ url: z.string() }),
  }),
  z.strictObject({
    action: z.literal('ui.copyText'),
    payload: z.strictObject({ text: z.string() }),
  }),
  z.strictObject({
    action: z.literal('ui.setTitle'),
    payload: z.strictObject({ title: z.string() }),
  }),
  z.strictObject({
    action: z.literal('ui.notify'),
    payload: z.strictObject({ title: z.string(), body: z.string() }),
  }),
  z.strictObject({ action: z.literal('diagnostics.list') }),
]);

function strictTopLevel(allowed: ReadonlySet<string>): z.ZodType<unknown> {
  return z.unknown().superRefine((value, context) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return;
    for (const key of Object.keys(value)) {
      if (!allowed.has(key)) {
        context.addIssue({ code: 'custom', message: `Unknown top-level field: ${key}` });
      }
    }
    if (allowed.has('session') && 'session' in value && value.session !== undefined) {
      const parsed = sessionTargetSchema.safeParse(value.session);
      if (!parsed.success) {
        context.addIssue({ code: 'custom', message: 'Invalid session target' });
      }
    }
  });
}

/** Reject unknown wire metadata while retaining payload compatibility per action. */
export const requestSchema = strictTopLevel(new Set(['action', 'payload'])).pipe(requestUnion);

export { resourceCatalogSchema };

export type IpcRequest = z.infer<typeof requestSchema>;
export type IpcAction = IpcRequest['action'];

/**
 * Wire envelope: the action union plus the optional transcript identity the
 * renderer believes it is acting on.
 */
export const envelopeSchema = strictTopLevel(new Set(['action', 'payload', 'session'])).pipe(
  z.intersection(
    requestUnion,
    z
      .object({
        action: z.string(),
        payload: z.unknown().optional(),
        session: sessionTargetSchema.optional(),
      })
      .strict(),
  ),
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
  /** Queue address retained while a failed restart leaves no live runtime state. */
  recoveryTarget?: SessionTarget | null;
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
  'settings.addResourceDirectory': AppSettings | null;
  'settings.removeResourceDirectory': AppSettings;
  'settings.rememberWorkingDirectory': AppSettings;
  'settings.forgetSession': AppSettings;
  'runtime.start': RuntimeSnapshot;
  'runtime.openSession': RuntimeSnapshot;
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
  'session.fork': TreeNavigateResult;
  'session.label': null;
  'session.clone': null;
  'session.importJsonl': null;
  'session.importHealth': ImportRecoveryHealth;
  'session.revealImportRecovery': null;
  'session.list': SessionSummary[];
  'session.compact': CompactionResult;
  'session.exportHtml': string | null;
  'session.exportJsonl': string | null;
  'session.autoCompaction': null;
  'shell.run': BashResult;
  'shell.abort': null;
  'commands.list': CommandInfo[];
  'resources.list': ResourceCatalog;
  'context.list': ContextFile[];
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

const nullableExportPathSchema = safePathText.nullable();
const nullResultSchema = z.null();
const importHealthSchema = z.discriminatedUnion('available', [
  z
    .object({
      available: z.literal(true),
      retained: z.number().int().nonnegative().max(32),
      capacity: z.literal(32),
    })
    .strict(),
  z
    .object({
      available: z.literal(false),
      error: z.literal('Import recovery is unavailable'),
    })
    .strict(),
]);

/** Strict second-boundary schemas for the Pi-native session slice. */
export function parseSessionIpcResult(action: IpcAction, value: unknown): unknown {
  switch (action) {
    case 'settings.get':
    case 'settings.update':
    case 'settings.toggleScopedModel':
    case 'settings.removeResourceDirectory':
    case 'settings.rememberWorkingDirectory':
    case 'settings.forgetSession':
      return rendererSettingsSchema.parse(value);
    case 'settings.addResourceDirectory':
      return rendererSettingsSchema.nullable().parse(value);
    case 'runtime.start':
    case 'runtime.openSession':
    case 'runtime.stop':
    case 'runtime.restart':
    case 'runtime.snapshot':
      return runtimeSnapshotSchema.parse(value);
    case 'agent.state':
      return rendererAgentStateSchema.parse(value);
    case 'queue.snapshot':
      return promptQueueSnapshotSchema.parse(value);
    case 'agent.tree':
      return treeSnapshotSchema.parse(value);
    case 'session.list':
      return sessionCatalogSchema.parse(value);
    case 'session.importHealth':
      return importHealthSchema.parse(value);
    case 'session.fork':
      return treeNavigateResultSchema.parse(value);
    case 'session.new':
    case 'session.switch':
    case 'session.name':
    case 'session.clone':
    case 'session.importJsonl':
    case 'session.revealImportRecovery':
    case 'session.label':
      return nullResultSchema.parse(value);
    case 'session.exportHtml':
    case 'session.exportJsonl':
      return nullableExportPathSchema.parse(value);
    default:
      return value;
  }
}

export type IpcResponse<A extends IpcAction = IpcAction> =
  { ok: true; value: IpcResult<A> } | { ok: false; error: string };

const promptQueueItemSchema = z
  .object({
    id: z.string().min(1).max(128),
    kind: z.enum(['steering', 'follow-up']),
    text: boundedText(100_000),
  })
  .strict();
export const promptQueueSnapshotSchema = z
  .object({
    runtime: runtimeKind,
    sessionId: z.string().min(1).max(128),
    steering: z.array(promptQueueItemSchema).max(500),
    followUp: z.array(promptQueueItemSchema).max(500),
  })
  .strict();
const sessionActivitySchema = z
  .object({
    sessionId: z.string().min(1).max(128),
    runtime: runtimeKind,
    status: z.enum([
      'stopped',
      'starting',
      'idle',
      'running',
      'compacting',
      'retrying',
      'failed',
      'disconnected',
    ]),
    responseReady: z.boolean().nullable(),
  })
  .strict();
export const bridgeEventSchema = z
  .discriminatedUnion('type', [
    z
      .object({
        type: z.literal('agent'),
        sessionId: z.string().min(1).max(128),
        runtime: runtimeKind,
        event: agentEventSchema,
      })
      .strict(),
    z.object({ type: z.literal('status'), snapshot: runtimeSnapshotSchema }).strict(),
    z.object({ type: z.literal('queue'), snapshot: promptQueueSnapshotSchema }).strict(),
    z.object({ type: z.literal('diagnostic'), message: boundedText(2_000) }).strict(),
    z.object({ type: z.literal('settings'), settings: rendererSettingsSchema }).strict(),
    z.object({ type: z.literal('sessionActivity'), activity: sessionActivitySchema }).strict(),
    z.object({ type: z.literal('focus'), focused: z.boolean() }).strict(),
  ])
  .superRefine((value, context) => {
    try {
      if (JSON.stringify(value).length > 1_000_000) {
        context.addIssue({ code: 'custom', message: 'Bridge event exceeds its byte bound' });
      }
    } catch {
      context.addIssue({ code: 'custom', message: 'Bridge event is not serializable' });
    }
  });

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
