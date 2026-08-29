import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { resizeImage } from '@earendil-works/pi-coding-agent';
import {
  IMAGE_LIMITS,
  imageAttachmentListSchema,
  type ImageAttachmentPreview,
  type SupportedImageMime,
} from '../../shared/images.js';

interface StoredImage {
  id: string;
  sessionKey: string;
  mimeType: SupportedImageMime;
  data: string;
  bytes: number;
  createdAt: number;
}

export interface PromptImage {
  type: 'image';
  data: string;
  mimeType: string;
}

/** Main-owned bounded image cache. Paths and model image bytes never enter renderer state. */
export class ImageAttachmentService {
  private readonly images = new Map<string, StoredImage>();

  async prepare(paths: string[], sessionKey: string): Promise<ImageAttachmentPreview[]> {
    this.expire();
    if (paths.length < 1 || paths.length > IMAGE_LIMITS.count) {
      throw new Error(`Select between 1 and ${IMAGE_LIMITS.count} images`);
    }
    if (new Set(paths).size !== paths.length)
      throw new Error('Duplicate image paths are not allowed');
    const existing = [...this.images.values()].filter((image) => image.sessionKey === sessionKey);
    if (existing.length + paths.length > IMAGE_LIMITS.count) {
      throw new Error(`A prompt can contain at most ${IMAGE_LIMITS.count} images`);
    }

    let aggregateInput = 0;
    let aggregateModel = existing.reduce((total, image) => total + image.bytes, 0);
    const prepared: Array<{ stored: StoredImage; preview: ImageAttachmentPreview }> = [];
    try {
      for (const path of paths) {
        const bytes = await readImage(path);
        aggregateInput += bytes.byteLength;
        if (aggregateInput > IMAGE_LIMITS.aggregateInputBytes) {
          throw new Error('Selected images exceed the aggregate input limit');
        }
        const mimeType = detectMime(bytes);
        const dimensions = imageDimensions(bytes, mimeType);
        if (
          dimensions.width < 1 ||
          dimensions.height < 1 ||
          dimensions.width > IMAGE_LIMITS.maxDimension ||
          dimensions.height > IMAGE_LIMITS.maxDimension
        ) {
          throw new Error(
            `Image dimensions must not exceed ${IMAGE_LIMITS.maxDimension}×${IMAGE_LIMITS.maxDimension}`,
          );
        }
        const normalized = await resizeImage(bytes, mimeType, {
          maxWidth: IMAGE_LIMITS.normalizedDimension,
          maxHeight: IMAGE_LIMITS.normalizedDimension,
          maxBytes: IMAGE_LIMITS.modelBytes,
        });
        if (!normalized) throw new Error('Image could not be normalized safely');
        const normalizedBytes = decodedBytes(normalized.data);
        aggregateModel += normalizedBytes;
        if (aggregateModel > IMAGE_LIMITS.aggregateModelBytes) {
          throw new Error('Selected images exceed the aggregate prompt limit');
        }
        const normalizedMime = supportedMime(normalized.mimeType);
        const preview = await resizeImage(Buffer.from(normalized.data, 'base64'), normalizedMime, {
          maxWidth: IMAGE_LIMITS.previewDimension,
          maxHeight: IMAGE_LIMITS.previewDimension,
          maxBytes: IMAGE_LIMITS.previewBytes,
        });
        if (!preview) throw new Error('Image preview could not be generated safely');
        const id = randomUUID();
        prepared.push({
          stored: {
            id,
            sessionKey,
            mimeType: normalizedMime,
            data: normalized.data,
            bytes: normalizedBytes,
            createdAt: Date.now(),
          },
          preview: {
            id,
            mimeType: supportedMime(preview.mimeType),
            width: normalized.width,
            height: normalized.height,
            sizeBytes: normalizedBytes,
            previewData: preview.data,
          },
        });
      }
      const previews = imageAttachmentListSchema.parse(prepared.map((item) => item.preview));
      for (const item of prepared) this.images.set(item.stored.id, item.stored);
      return previews;
    } catch (error) {
      for (const item of prepared) this.images.delete(item.stored.id);
      throw error;
    }
  }

  remove(id: string, sessionKey: string): void {
    const image = this.images.get(id);
    if (image?.sessionKey === sessionKey) this.images.delete(id);
  }

  take(ids: string[], sessionKey: string): PromptImage[] {
    this.expire();
    if (ids.length > IMAGE_LIMITS.count || new Set(ids).size !== ids.length) {
      throw new Error('Invalid image attachment selection');
    }
    const selected = ids.map((id) => {
      const image = this.images.get(id);
      if (!image || image.sessionKey !== sessionKey) throw new Error('Image attachment expired');
      return image;
    });
    const bytes = selected.reduce((total, image) => total + image.bytes, 0);
    if (bytes > IMAGE_LIMITS.aggregateModelBytes) throw new Error('Image prompt exceeds its limit');
    for (const image of selected) this.images.delete(image.id);
    return selected.map((image) => ({ type: 'image', data: image.data, mimeType: image.mimeType }));
  }

  clearSession(sessionKey: string): void {
    for (const [id, image] of this.images) {
      if (image.sessionKey === sessionKey) this.images.delete(id);
    }
  }

  private expire(): void {
    const cutoff = Date.now() - 30 * 60_000;
    for (const [id, image] of this.images) {
      if (image.createdAt < cutoff) this.images.delete(id);
    }
  }
}

async function readImage(path: string): Promise<Uint8Array> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('Image must be a regular file');
    if (stat.size < 12 || stat.size > IMAGE_LIMITS.inputBytes) {
      throw new Error(`Image must be smaller than ${IMAGE_LIMITS.inputBytes} bytes`);
    }
    const bytes = new Uint8Array(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead === 0) throw new Error('Image changed while reading');
      offset += read.bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ino !== stat.ino) {
      throw new Error('Image changed while reading');
    }
    return bytes;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP')
      throw new Error('Image symlinks are not allowed');
    throw error;
  } finally {
    await handle?.close();
  }
}

function detectMime(bytes: Uint8Array): SupportedImageMime {
  if (bytes.slice(0, 8).every((value, index) => value === [137, 80, 78, 71, 13, 10, 26, 10][index]))
    return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  const ascii = (start: number, length: number) =>
    String.fromCharCode(...bytes.slice(start, start + length));
  if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') return 'image/gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'image/webp';
  throw new Error('Only PNG, JPEG, GIF, and WebP images are supported');
}

function imageDimensions(
  bytes: Uint8Array,
  mime: SupportedImageMime,
): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (mime === 'image/png') return { width: view.getUint32(16), height: view.getUint32(20) };
  if (mime === 'image/gif')
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  if (mime === 'image/jpeg') {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = bytes[offset + 1] ?? 0;
      if (
        [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
          marker,
        )
      ) {
        return { width: view.getUint16(offset + 7), height: view.getUint16(offset + 5) };
      }
      const length = view.getUint16(offset + 2);
      if (length < 2) break;
      offset += 2 + length;
    }
    throw new Error('JPEG dimensions could not be validated');
  }
  const chunk = String.fromCharCode(...bytes.slice(12, 16));
  if (chunk === 'VP8X' && bytes.length >= 30) {
    const width = 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16));
    const height = 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16));
    return { width, height };
  }
  if (chunk === 'VP8 ' && bytes.length >= 30) {
    return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
  }
  if (chunk === 'VP8L' && bytes.length >= 25) {
    const bits = view.getUint32(21, true);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  throw new Error('WebP dimensions could not be validated');
}

function supportedMime(value: string): SupportedImageMime {
  if (value === 'image/jpg') return 'image/jpeg';
  if (
    value === 'image/png' ||
    value === 'image/jpeg' ||
    value === 'image/gif' ||
    value === 'image/webp'
  )
    return value;
  throw new Error('Image normalization returned an unsupported format');
}

function decodedBytes(value: string): number {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((value.length * 3) / 4) - padding);
}
