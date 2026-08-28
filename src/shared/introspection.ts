import { z } from 'zod';

/** Hard limits for local-only agent introspection crossing IPC. */
export const INTROSPECTION_LIMITS = {
  systemPromptCharacters: 256 * 1024,
  toolEntries: 100,
  toolNameCharacters: 128,
  toolDescriptionCharacters: 4_096,
  originCharacters: 256,
  schemaDepth: 12,
  schemaNodes: 2_000,
  schemaArrayItems: 100,
  schemaObjectProperties: 100,
  schemaKeyCharacters: 128,
  schemaStringCharacters: 4_096,
  schemaBytes: 64 * 1024,
  diagnostics: 200,
  diagnosticCharacters: 512,
} as const;

const noControls = (value: string): boolean =>
  ![...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x08 || codePoint === 0x0b || codePoint === 0x0c || codePoint === 0x7f;
  });

const boundedText = (maximum: number) => z.string().max(maximum).refine(noControls);
const originSchema = boundedText(INTROSPECTION_LIMITS.originCharacters).min(1);
const diagnosticSchema = boundedText(INTROSPECTION_LIMITS.diagnosticCharacters);

export const systemPromptInspectionSchema = z
  .object({
    text: boundedText(INTROSPECTION_LIMITS.systemPromptCharacters),
    totalCharacters: z.number().int().min(0),
    truncated: z.boolean(),
    origin: originSchema,
  })
  .strict();

export type SystemPromptInspection = z.infer<typeof systemPromptInspectionSchema>;

export type BoundedJson =
  null | boolean | number | string | BoundedJson[] | { [key: string]: BoundedJson };

/**
 * Getter-free structural clone and validation used at both sides of IPC.
 * Reflection failures (including hostile/revoked Proxies), accessors, cycles,
 * and every aggregate limit fail closed. Output records have no prototype.
 */
export function parseBoundedJson(input: unknown): BoundedJson {
  let nodes = 0;
  const ancestors = new WeakSet<object>();

  const visit = (value: unknown, depth: number): BoundedJson => {
    nodes += 1;
    if (nodes > INTROSPECTION_LIMITS.schemaNodes) throw new Error('schema node limit exceeded');
    if (depth > INTROSPECTION_LIMITS.schemaDepth) throw new Error('schema depth limit exceeded');
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new Error('schema contains a non-finite number');
      return value;
    }
    if (typeof value === 'string') {
      if (value.length > INTROSPECTION_LIMITS.schemaStringCharacters || !noControls(value)) {
        throw new Error('schema string limit exceeded');
      }
      return value;
    }
    if (typeof value !== 'object') throw new Error('schema contains an unsupported value');
    if (ancestors.has(value)) throw new Error('schema contains a cycle');
    ancestors.add(value);
    try {
      let descriptors: Record<string, PropertyDescriptor>;
      try {
        descriptors = Object.getOwnPropertyDescriptors(value);
      } catch {
        throw new Error('schema reflection failed');
      }
      if (Array.isArray(value)) {
        const length = descriptors['length'];
        if (!length || !('value' in length) || !Number.isSafeInteger(length.value)) {
          throw new Error('schema array length is invalid');
        }
        if (length.value > INTROSPECTION_LIMITS.schemaArrayItems) {
          throw new Error('schema array item limit exceeded');
        }
        const output: BoundedJson[] = [];
        for (let index = 0; index < length.value; index += 1) {
          const descriptor = descriptors[String(index)];
          if (!descriptor) {
            output.push(null);
          } else if ('value' in descriptor) {
            output.push(visit(descriptor.value, depth + 1));
          } else {
            throw new Error('schema array accessor rejected');
          }
        }
        return output;
      }
      const entries = Object.entries(descriptors).filter(([, descriptor]) => descriptor.enumerable);
      if (entries.length > INTROSPECTION_LIMITS.schemaObjectProperties) {
        throw new Error('schema object property limit exceeded');
      }
      const output = Object.create(null) as Record<string, BoundedJson>;
      for (const [key, descriptor] of entries) {
        if (
          key.length > INTROSPECTION_LIMITS.schemaKeyCharacters ||
          !noControls(key) ||
          !('value' in descriptor)
        ) {
          throw new Error('schema key or descriptor rejected');
        }
        Object.defineProperty(output, key, {
          value: visit(descriptor.value, depth + 1),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      return output;
    } finally {
      ancestors.delete(value);
    }
  };

  const output = visit(input, 0);
  if (
    new TextEncoder().encode(JSON.stringify(output)).byteLength > INTROSPECTION_LIMITS.schemaBytes
  ) {
    throw new Error('schema byte limit exceeded');
  }
  return output;
}

const boundedJsonSchema: z.ZodType<BoundedJson> = z.unknown().transform((value, context) => {
  try {
    return parseBoundedJson(value);
  } catch (error) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: error instanceof Error ? error.message : 'invalid bounded schema',
    });
    return z.NEVER;
  }
});

export const toolCatalogSchema = z
  .object({
    tools: z
      .array(
        z
          .object({
            name: boundedText(INTROSPECTION_LIMITS.toolNameCharacters).min(1),
            description: boundedText(INTROSPECTION_LIMITS.toolDescriptionCharacters),
            origin: originSchema,
            active: z.boolean(),
            parameters: boundedJsonSchema,
            schemaTruncated: z.boolean(),
          })
          .strict(),
      )
      .max(INTROSPECTION_LIMITS.toolEntries),
    total: z.number().int().min(0),
    truncated: z.boolean(),
    diagnostics: z.array(diagnosticSchema).max(INTROSPECTION_LIMITS.diagnostics),
  })
  .strict();

export type ToolCatalog = z.infer<typeof toolCatalogSchema>;

const resourceCountsSchema = z
  .object({
    skills: z.number().int().min(0),
    prompts: z.number().int().min(0),
    themes: z.number().int().min(0),
    contextFiles: z.number().int().min(0),
    extensions: z.number().int().min(0),
    tools: z.number().int().min(0),
  })
  .strict();

export const resourceReloadResultSchema = z
  .object({
    before: resourceCountsSchema,
    after: resourceCountsSchema,
    diagnostics: z.array(diagnosticSchema).max(INTROSPECTION_LIMITS.diagnostics),
  })
  .strict();

export type ResourceReloadResult = z.infer<typeof resourceReloadResultSchema>;
