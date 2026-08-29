import { z } from 'zod';

export const IMAGE_LIMITS = {
  count: 8,
  inputBytes: 10 * 1024 * 1024,
  aggregateInputBytes: 30 * 1024 * 1024,
  modelBytes: 4 * 1024 * 1024,
  aggregateModelBytes: 24 * 1024 * 1024,
  previewBytes: 256 * 1024,
  aggregatePreviewBytes: 2 * 1024 * 1024,
  maxDimension: 12_000,
  normalizedDimension: 2_000,
  previewDimension: 512,
} as const;

const attachmentId = z.string().uuid();
const imageMime = z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const base64 = z.string().max(Math.ceil((IMAGE_LIMITS.previewBytes * 4) / 3) + 16);

export const imageAttachmentPreviewSchema = z
  .object({
    id: attachmentId,
    mimeType: imageMime,
    width: z.number().int().min(1).max(IMAGE_LIMITS.normalizedDimension),
    height: z.number().int().min(1).max(IMAGE_LIMITS.normalizedDimension),
    sizeBytes: z.number().int().min(1).max(IMAGE_LIMITS.modelBytes),
    previewData: base64,
  })
  .strict();

export const imageAttachmentListSchema = z
  .array(imageAttachmentPreviewSchema)
  .max(IMAGE_LIMITS.count)
  .superRefine((items, context) => {
    const bytes = items.reduce((total, item) => total + decodedBase64Bytes(item.previewData), 0);
    if (bytes > IMAGE_LIMITS.aggregatePreviewBytes) {
      context.addIssue({
        code: 'custom',
        message: 'Image previews exceed the aggregate IPC limit',
      });
    }
  });

function decodedBase64Bytes(value: string): number {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((value.length * 3) / 4) - padding);
}

export type ImageAttachmentPreview = z.infer<typeof imageAttachmentPreviewSchema>;
export type SupportedImageMime = z.infer<typeof imageMime>;
