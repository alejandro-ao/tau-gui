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

const boundedJsonSchema: z.ZodType<BoundedJson> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    boundedText(INTROSPECTION_LIMITS.schemaStringCharacters),
    z.array(boundedJsonSchema).max(INTROSPECTION_LIMITS.schemaArrayItems),
    z.record(z.string().max(INTROSPECTION_LIMITS.schemaKeyCharacters), boundedJsonSchema),
  ]),
);

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
