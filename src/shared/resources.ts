import { z } from 'zod';

/** Hard bounds for filesystem discovery and metadata crossing IPC. */
export const RESOURCE_LIMITS = {
  fileBytes: 256 * 1024,
  directoryEntries: 1_000,
  catalogEntries: 200,
  nameCharacters: 128,
  descriptionCharacters: 512,
  originCharacters: 256,
  diagnosticCharacters: 512,
  diagnostics: 200,
  pathCharacters: 4_096,
} as const;

const resourceNameSchema = z
  .string()
  .min(1)
  .max(RESOURCE_LIMITS.nameCharacters)
  .refine((value) => !hasControlCharacter(value), 'Resource name contains control characters');

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}
const descriptionSchema = z
  .string()
  .max(RESOURCE_LIMITS.descriptionCharacters)
  .refine((value) => !hasControlCharacter(value), 'Description contains control characters')
  .nullable();
const originSchema = z
  .string()
  .min(1)
  .max(RESOURCE_LIMITS.originCharacters)
  .refine((value) => !hasControlCharacter(value), 'Origin contains control characters');

export const resourceCatalogSchema = z
  .object({
    skills: z
      .array(
        z
          .object({
            name: resourceNameSchema,
            description: descriptionSchema,
            origin: originSchema,
            disableModelInvocation: z.boolean(),
            estimatedTokens: z.number().int().min(0).max(RESOURCE_LIMITS.fileBytes),
          })
          .strict(),
      )
      .max(RESOURCE_LIMITS.catalogEntries),
    prompts: z
      .array(
        z
          .object({
            name: resourceNameSchema,
            description: descriptionSchema,
            origin: originSchema,
          })
          .strict(),
      )
      .max(RESOURCE_LIMITS.catalogEntries),
    diagnostics: z
      .array(
        z
          .string()
          .max(RESOURCE_LIMITS.diagnosticCharacters)
          .refine((value) => !hasControlCharacter(value), 'Diagnostic contains control characters'),
      )
      .max(RESOURCE_LIMITS.diagnostics),
  })
  .strict();
