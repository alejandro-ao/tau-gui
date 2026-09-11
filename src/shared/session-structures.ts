import { z } from 'zod';
import type { TreeSnapshot } from './domain.js';

/** Complete restored entry/tree response budget, measured as serialized UTF-8. */
export const MAX_SESSION_STRUCTURE_BYTES = 1024 * 1024;
export const MAX_SESSION_IDENTIFIER_CHARACTERS = 256;
const MAX_ENTRY_NODES = 1_000;
const MAX_TREE_DEPTH = 50;
const MAX_MESSAGE_TEXT_CHARACTERS = 64 * 1024;
const MAX_MESSAGE_BLOCKS = 100;

const boundedString = (maximum = MAX_MESSAGE_TEXT_CHARACTERS) => z.string().max(maximum);
const finiteNumber = z.number().finite();
const boundedRecord = z.record(z.string(), z.unknown());
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

const messageSchema = z.discriminatedUnion('role', [
  z
    .object({
      role: z.literal('user'),
      skill: z
        .object({ name: boundedString(128), content: boundedString() })
        .strict()
        .nullable()
        .optional(),
      text: boundedString(),
      images: z
        .array(z.object({ mimeType: boundedString(), data: boundedString() }).strict())
        .max(MAX_MESSAGE_BLOCKS),
      timestamp: finiteNumber,
    })
    .strict(),
  z
    .object({
      role: z.literal('assistant'),
      text: boundedString(),
      thinking: boundedString(),
      toolCalls: z
        .array(
          z
            .object({
              id: boundedString(MAX_SESSION_IDENTIFIER_CHARACTERS),
              name: boundedString(128),
              arguments: boundedRecord,
            })
            .strict(),
        )
        .max(MAX_MESSAGE_BLOCKS),
      provider: z.string(),
      model: z.string(),
      usage: usageSchema.nullable(),
      stopReason: z.enum(['stop', 'length', 'toolUse', 'error', 'aborted']).nullable(),
      errorMessage: boundedString().nullable(),
      timestamp: finiteNumber,
    })
    .strict(),
  z
    .object({
      role: z.literal('toolResult'),
      toolCallId: boundedString(MAX_SESSION_IDENTIFIER_CHARACTERS),
      toolName: boundedString(128),
      text: boundedString(),
      details: boundedRecord,
      isError: z.boolean(),
      timestamp: finiteNumber,
    })
    .strict(),
  z
    .object({
      role: z.literal('bashExecution'),
      command: boundedString(),
      output: boundedString(),
      exitCode: finiteNumber.nullable(),
      cancelled: z.boolean(),
      truncated: z.boolean(),
      excludeFromContext: z.boolean(),
      timestamp: finiteNumber,
    })
    .strict(),
  z
    .object({
      role: z.literal('custom'),
      customType: boundedString(),
      text: boundedString(),
      display: z.boolean(),
      details: boundedRecord,
      timestamp: finiteNumber,
    })
    .strict(),
  z
    .object({
      role: z.literal('branchSummary'),
      summary: boundedString(),
      fromId: z.string(),
      timestamp: finiteNumber,
    })
    .strict(),
  z
    .object({
      role: z.literal('compactionSummary'),
      summary: boundedString(),
      tokensBefore: finiteNumber,
      timestamp: finiteNumber,
    })
    .strict(),
]);

const entrySchema = z
  .object({
    id: boundedString(MAX_SESSION_IDENTIFIER_CHARACTERS),
    parentId: boundedString(MAX_SESSION_IDENTIFIER_CHARACTERS).nullable(),
    timestamp: boundedString(128),
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
    message: messageSchema.optional(),
    summary: boundedString(),
  })
  .strict();

const leafIdSchema = boundedString(MAX_SESSION_IDENTIFIER_CHARACTERS).nullable();
const serializedBytes = (value: unknown): number => {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
};
const enforceResponseBytes = (value: unknown, context: z.RefinementCtx): void => {
  if (serializedBytes(value) > MAX_SESSION_STRUCTURE_BYTES) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'session structure byte limit exceeded',
    });
  }
};

export const entrySnapshotSchema = z
  .object({ entries: z.array(entrySchema).max(MAX_ENTRY_NODES), leafId: leafIdSchema })
  .strict()
  .superRefine(enforceResponseBytes);

const shallowTreeNodeSchema = z.object({ entry: entrySchema, children: z.unknown() }).strict();
const treeSnapshotWrapperSchema = z.object({ tree: z.unknown(), leafId: leafIdSchema }).strict();
const isUnknownArray = (value: unknown): value is unknown[] => Array.isArray(value);

/**
 * Validate tree structure iteratively before any recursive parser or serializer
 * sees it. Root/child widths, total nodes, and depth are rejected as soon as a
 * bound is crossed, including cyclic input and hostile deep/wide adapter data.
 */
export const treeSnapshotSchema = treeSnapshotWrapperSchema.transform((value, context) => {
  if (!isUnknownArray(value.tree)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'session tree must be an array' });
    return z.NEVER;
  }
  if (value.tree.length > MAX_ENTRY_NODES) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'session tree node limit exceeded',
    });
    return z.NEVER;
  }

  const pending: Array<{ node: unknown; depth: number }> = value.tree.map((node) => ({
    node,
    depth: 0,
  }));
  let nodes = 0;
  while (pending.length > 0) {
    const next = pending.pop()!;
    if (next.depth > MAX_TREE_DEPTH) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'session tree depth limit exceeded',
      });
      return z.NEVER;
    }
    nodes += 1;
    if (nodes > MAX_ENTRY_NODES) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'session tree node limit exceeded',
      });
      return z.NEVER;
    }

    const parsed = shallowTreeNodeSchema.safeParse(next.node);
    if (!parsed.success) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'malformed session tree node' });
      return z.NEVER;
    }
    const children = parsed.data.children;
    if (!isUnknownArray(children)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'session tree children must be an array',
      });
      return z.NEVER;
    }
    if (
      children.length > MAX_ENTRY_NODES ||
      nodes + pending.length + children.length > MAX_ENTRY_NODES
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'session tree node limit exceeded',
      });
      return z.NEVER;
    }
    for (const child of children) pending.push({ node: child, depth: next.depth + 1 });
  }

  enforceResponseBytes(value, context);
  return value as TreeSnapshot;
});
