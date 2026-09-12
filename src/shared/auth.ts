import { z } from 'zod';

export const AUTH_LIMITS = {
  flowRevision: Number.MAX_SAFE_INTEGER,
  providers: 128,
  providerIdCharacters: 128,
  labelCharacters: 256,
  messageCharacters: 2_048,
  responseCharacters: 16_384,
  notices: 16,
  promptOptions: 64,
} as const;

const boundedLabel = z.string().min(1).max(AUTH_LIMITS.labelCharacters);
const authTypeSchema = z.enum(['api_key', 'oauth']);

export const authProviderSchema = z
  .object({
    id: z.string().min(1).max(AUTH_LIMITS.providerIdCharacters),
    name: boundedLabel,
    methods: z
      .array(
        z
          .object({
            type: authTypeSchema,
            label: boundedLabel,
            interactive: z.boolean(),
          })
          .strict(),
      )
      .max(2),
    configured: z.boolean(),
    storedCredential: authTypeSchema.nullable(),
  })
  .strict();

export const authProviderListSchema = z.array(authProviderSchema).max(AUTH_LIMITS.providers);
export type AuthProvider = z.infer<typeof authProviderSchema>;
export type AuthType = z.infer<typeof authTypeSchema>;

export const authLogoutResultSchema = z
  .object({
    providers: authProviderListSchema,
    warning: z.string().max(AUTH_LIMITS.messageCharacters).nullable(),
  })
  .strict();
export type AuthLogoutResult = z.infer<typeof authLogoutResultSchema>;

const authPromptSchema = z
  .object({
    id: z.string().min(1).max(128),
    type: z.enum(['text', 'secret', 'select', 'manual_code']),
    message: z.string().min(1).max(AUTH_LIMITS.messageCharacters),
    placeholder: z.string().max(AUTH_LIMITS.labelCharacters).optional(),
    options: z
      .array(
        z
          .object({
            id: z.string().min(1).max(AUTH_LIMITS.labelCharacters),
            label: boundedLabel,
            description: z.string().max(AUTH_LIMITS.messageCharacters).optional(),
          })
          .strict(),
      )
      .max(AUTH_LIMITS.promptOptions)
      .optional(),
  })
  .strict();

const authInfoLinkSchema = z
  .object({
    url: z.string().url().max(AUTH_LIMITS.messageCharacters),
    label: z.string().max(AUTH_LIMITS.labelCharacters).optional(),
  })
  .strict();

const authNoticeSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('info'),
      message: z.string().max(AUTH_LIMITS.messageCharacters),
      links: z.array(authInfoLinkSchema).max(8).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('auth_url'),
      url: z.string().url().max(AUTH_LIMITS.messageCharacters),
      instructions: z.string().max(AUTH_LIMITS.messageCharacters).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('device_code'),
      userCode: z.string().max(AUTH_LIMITS.labelCharacters),
      verificationUri: z.string().url().max(AUTH_LIMITS.messageCharacters),
      expiresInSeconds: z.number().int().positive().max(86_400).optional(),
    })
    .strict(),
  z
    .object({ type: z.literal('progress'), message: z.string().max(AUTH_LIMITS.messageCharacters) })
    .strict(),
]);

export const authFlowSchema = z
  .object({
    id: z.string().min(1).max(128),
    providerId: z.string().min(1).max(AUTH_LIMITS.providerIdCharacters),
    providerName: boundedLabel,
    authType: authTypeSchema,
    revision: z.number().int().nonnegative().max(AUTH_LIMITS.flowRevision),
    status: z.enum(['running', 'prompt', 'succeeded', 'failed', 'cancelled']),
    prompt: authPromptSchema.nullable(),
    notices: z.array(authNoticeSchema).max(AUTH_LIMITS.notices),
    message: z.string().max(AUTH_LIMITS.messageCharacters).nullable(),
  })
  .strict();
export type AuthFlow = z.infer<typeof authFlowSchema>;
