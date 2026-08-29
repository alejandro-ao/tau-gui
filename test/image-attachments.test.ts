import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ImageAttachmentService } from '../src/main/services/image-attachments.js';
import { IMAGE_LIMITS, imageAttachmentListSchema } from '../src/shared/images.js';

const roots: string[] = [];
const VALID_PNG = readFileSync(new URL('./fixtures/images/valid.png', import.meta.url));

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('ImageAttachmentService', () => {
  it('normalizes, previews, scopes, removes, and consumes native images', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tau-gui-images-'));
    roots.push(root);
    const path = join(root, 'pixel.png');
    writeFileSync(path, VALID_PNG);
    const service = new ImageAttachmentService();

    const previews = await service.prepare([path], 'pi:session-a');
    expect(imageAttachmentListSchema.safeParse(previews).success).toBe(true);
    expect(previews[0]).toMatchObject({ width: 16, height: 16 });
    expect(previews[0]?.previewData).not.toBe('');
    expect(() => service.take([previews[0]!.id], 'pi:session-b')).toThrow('expired');
    const images = service.take([previews[0]!.id], 'pi:session-a');
    expect(images).toHaveLength(1);
    expect(images[0]?.type).toBe('image');
    expect(images[0]?.mimeType).toMatch(/^image\//);
    expect(images[0]!.data.length).toBeGreaterThan(0);
    expect(() => service.take([previews[0]!.id], 'pi:session-a')).toThrow('expired');

    const removable = await service.prepare([path], 'pi:session-a');
    service.remove(removable[0]!.id, 'pi:session-a');
    expect(() => service.take([removable[0]!.id], 'pi:session-a')).toThrow('expired');
  });

  it('rejects unsupported bytes, symlinks, oversized files, duplicates, and excessive counts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tau-gui-images-hostile-'));
    roots.push(root);
    const valid = join(root, 'pixel.png');
    const invalid = join(root, 'fake.png');
    const link = join(root, 'link.png');
    const oversized = join(root, 'oversized.png');
    writeFileSync(valid, VALID_PNG);
    writeFileSync(invalid, 'not an image');
    symlinkSync(valid, link);
    writeFileSync(oversized, VALID_PNG);
    truncateSync(oversized, IMAGE_LIMITS.inputBytes + 1);
    const service = new ImageAttachmentService();

    await expect(service.prepare([invalid], 'pi:a')).rejects.toThrow(/supported|smaller/);
    await expect(service.prepare([link], 'pi:a')).rejects.toThrow(/symlink|regular/i);
    await expect(service.prepare([oversized], 'pi:a')).rejects.toThrow('smaller');
    await expect(service.prepare([valid, valid], 'pi:a')).rejects.toThrow('Duplicate');
    await expect(
      service.prepare(
        Array.from({ length: IMAGE_LIMITS.count + 1 }, () => valid),
        'pi:a',
      ),
    ).rejects.toThrow('between');
  });
});
