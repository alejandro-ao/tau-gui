import { z } from 'zod';

export const EXTENSION_LIMITS = {
  resources: 100,
  text: 4_096,
  editorText: 100_000,
  options: 100,
  statuses: 50,
  sidebarSections: 20,
  sidebarLines: 100,
  customDataBytes: 64 * 1024,
  messageBytes: 256 * 1024,
  dialogTimeoutMs: 5 * 60_000,
} as const;

const id = z.string().uuid();
const text = z.string().max(EXTENSION_LIMITS.text);

export const extensionPolicySchema = z
  .object({
    userEnabled: z.boolean(),
    projectEnabled: z.boolean(),
    executionAvailable: z.literal(false),
    blocker: z.string().min(1).max(1_000),
  })
  .strict();
export type ExtensionPolicy = z.infer<typeof extensionPolicySchema>;

export const extensionResourceSchema = z
  .object({
    id,
    name: z.string().min(1).max(200),
    scope: z.enum(['user', 'project']),
    enabledRequested: z.boolean(),
    trusted: z.boolean(),
    execution: z.literal('blocked'),
    reason: z.string().min(1).max(1_000),
  })
  .strict();
export const extensionResourceListSchema = z
  .array(extensionResourceSchema)
  .max(EXTENSION_LIMITS.resources);
export type ExtensionResource = z.infer<typeof extensionResourceSchema>;

const dialogBase = {
  requestId: id,
  extensionId: id,
  title: z.string().max(500),
  timeoutMs: z.number().int().min(1).max(EXTENSION_LIMITS.dialogTimeoutMs),
};
export const extensionDialogSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...dialogBase,
      kind: z.literal('select'),
      options: z
        .array(
          z
            .object({
              id: z.string().max(200),
              label: z.string().max(500),
              description: text.nullable(),
            })
            .strict(),
        )
        .max(EXTENSION_LIMITS.options),
    })
    .strict(),
  z.object({ ...dialogBase, kind: z.literal('confirm'), message: text }).strict(),
  z
    .object({
      ...dialogBase,
      kind: z.enum(['input', 'editor']),
      message: text,
      placeholder: text.nullable(),
      initialValue: z.string().max(EXTENSION_LIMITS.editorText),
    })
    .strict(),
]);
export type ExtensionDialog = z.infer<typeof extensionDialogSchema>;

export const portableToolRenderSchema = z
  .object({
    toolCallId: z.string().min(1).max(200),
    toolName: z.string().min(1).max(200),
    title: z.string().max(500),
    text: z.string().max(50_000),
    tone: z.enum(['neutral', 'success', 'warning', 'error']),
    expandedText: z.string().max(100_000).nullable(),
  })
  .strict();
export type PortableToolRender = z.infer<typeof portableToolRenderSchema>;

export const extensionUiEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('dialog'), dialog: extensionDialogSchema }).strict(),
  z
    .object({
      type: z.literal('dialog_closed'),
      requestId: id,
      reason: z.enum(['answered', 'cancelled', 'timeout', 'crash']),
    })
    .strict(),
  z
    .object({
      type: z.literal('notification'),
      extensionId: id,
      level: z.enum(['info', 'warning', 'error']),
      message: text,
    })
    .strict(),
  z
    .object({
      type: z.literal('status'),
      extensionId: id,
      key: z.string().max(200),
      text: text.nullable(),
    })
    .strict(),
  z
    .object({
      type: z.literal('sidebar'),
      extensionId: id,
      key: z.string().max(200),
      title: z.string().max(500),
      lines: z.array(text).max(EXTENSION_LIMITS.sidebarLines),
    })
    .strict(),
  z
    .object({
      type: z.literal('custom_message'),
      extensionId: id,
      customType: z.string().max(200),
      text,
      data: z.string().max(EXTENSION_LIMITS.customDataBytes),
    })
    .strict(),
  z
    .object({ type: z.literal('tool_render'), extensionId: id, render: portableToolRenderSchema })
    .strict(),
  z
    .object({
      type: z.literal('host'),
      status: z.enum(['stopped', 'starting', 'ready', 'crashed', 'blocked']),
      detail: z.string().max(1_000),
    })
    .strict(),
]);
export type ExtensionUiEvent = z.infer<typeof extensionUiEventSchema>;

export const extensionHostStatusSchema = z
  .object({
    status: z.enum(['stopped', 'starting', 'ready', 'crashed', 'blocked']),
    crashes: z.number().int().min(0).max(3),
    detail: z.string().max(1_000),
  })
  .strict();
export type ExtensionHostStatus = z.infer<typeof extensionHostStatusSchema>;
