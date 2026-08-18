/**
 * Strict LF-only JSONL framing.
 *
 * Rules (matching Tau/Pi RPC framing):
 * - records are separated by `\n` only;
 * - a single trailing `\r` is stripped (CRLF tolerated);
 * - U+2028/U+2029 are ordinary characters and never split records;
 * - blank records are skipped;
 * - records larger than the limit are reported as errors and dropped;
 * - UTF-8 multi-byte sequences may be split across chunks.
 */

export const MAX_RECORD_BYTES = 16 * 1024 * 1024;

export type DecodeResult =
  { ok: true; value: Record<string, unknown> } | { ok: false; error: string; line: string };

export interface JsonlDecoderOptions {
  maxRecordBytes?: number;
}

export class JsonlDecoder {
  private readonly decoder = new TextDecoder('utf-8');
  private buffer = '';
  private readonly maxRecordBytes: number;
  private overflowing = false;

  constructor(options: JsonlDecoderOptions = {}) {
    this.maxRecordBytes = options.maxRecordBytes ?? MAX_RECORD_BYTES;
  }

  /** Feed a raw chunk and return every complete record it produced. */
  push(chunk: Uint8Array | string): DecodeResult[] {
    const text = typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true });
    if (text.length === 0) return [];
    this.buffer += text;

    const results: DecodeResult[] = [];
    let start = 0;
    for (;;) {
      const index = this.buffer.indexOf('\n', start);
      if (index < 0) break;
      const raw = this.buffer.slice(start, index);
      start = index + 1;
      const result = this.decodeLine(raw);
      if (result) results.push(result);
    }
    if (start > 0) this.buffer = this.buffer.slice(start);

    // Guard unbounded growth from a runtime that never emits a newline.
    if (!this.overflowing && byteLength(this.buffer) > this.maxRecordBytes) {
      this.overflowing = true;
      this.buffer = '';
      results.push({
        ok: false,
        error: `RPC record exceeds ${this.maxRecordBytes} bytes`,
        line: '',
      });
    }
    return results;
  }

  /** Flush a trailing partial record at stream end. */
  flush(): DecodeResult[] {
    const remainder = this.buffer;
    this.buffer = '';
    this.overflowing = false;
    if (remainder.length === 0) return [];
    const result = this.decodeLine(remainder);
    return result ? [result] : [];
  }

  private decodeLine(input: string): DecodeResult | null {
    if (this.overflowing) {
      // Skip the remainder of an oversized record, resume at the next newline.
      this.overflowing = false;
      return null;
    }
    const line = input.endsWith('\r') ? input.slice(0, -1) : input;
    if (line.trim().length === 0) return null;
    if (byteLength(line) > this.maxRecordBytes) {
      return { ok: false, error: `RPC record exceeds ${this.maxRecordBytes} bytes`, line: '' };
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      return {
        ok: false,
        error: `Failed to parse RPC record: ${(error as Error).message}`,
        line,
      };
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return { ok: false, error: 'RPC record must be a JSON object', line };
    }
    return { ok: true, value: value as Record<string, unknown> };
  }
}

/** Encode one record for stdin. Never emits interior newlines. */
export function encodeRecord(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function byteLength(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.codePointAt(index) as number;
    if (code > 0xffff) index += 1;
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code < 0x10000) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}
