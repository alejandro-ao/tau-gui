import { describe, expect, it } from 'vitest';
import { JsonlDecoder, encodeRecord } from '../src/main/rpc/jsonl.js';

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('JsonlDecoder', () => {
  it('decodes one record per LF', () => {
    const decoder = new JsonlDecoder();
    const results = decoder.push('{"a":1}\n{"a":2}\n');
    expect(results.map((r) => (r.ok ? r.value : r.error))).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('reassembles fragmented records', () => {
    const decoder = new JsonlDecoder();
    expect(decoder.push('{"type":"agent')).toEqual([]);
    expect(decoder.push('_settled"}')).toEqual([]);
    const results = decoder.push('\n');
    expect(results[0]).toEqual({ ok: true, value: { type: 'agent_settled' } });
  });

  it('handles coalesced records in one chunk', () => {
    const decoder = new JsonlDecoder();
    const results = decoder.push('{"i":1}\n{"i":2}\n{"i":3}\n');
    expect(results).toHaveLength(3);
  });

  it('tolerates CRLF but keeps interior carriage returns', () => {
    const decoder = new JsonlDecoder();
    const results = decoder.push('{"text":"a\\r\\nb"}\r\n');
    expect(results[0]).toEqual({ ok: true, value: { text: 'a\r\nb' } });
  });

  it('does not split on U+2028 or U+2029', () => {
    const decoder = new JsonlDecoder();
    const results = decoder.push('{"id":"a\u2028b\u2029c"}\n');
    expect(results[0]).toEqual({ ok: true, value: { id: 'a\u2028b\u2029c' } });
  });

  it('rejoins UTF-8 sequences split across chunk boundaries', () => {
    const decoder = new JsonlDecoder();
    const bytes = utf8('{"text":"日本語"}\n');
    const first = bytes.slice(0, 12);
    const second = bytes.slice(12);
    const results = [...decoder.push(first), ...decoder.push(second)];
    expect(results[0]).toEqual({ ok: true, value: { text: '日本語' } });
  });

  it('skips blank records', () => {
    const decoder = new JsonlDecoder();
    expect(decoder.push('\n   \n{"a":1}\n')).toHaveLength(1);
  });

  it('reports malformed JSON without breaking the stream', () => {
    const decoder = new JsonlDecoder();
    const results = decoder.push('not json\n{"a":1}\n');
    expect(results[0]?.ok).toBe(false);
    expect(results[1]).toEqual({ ok: true, value: { a: 1 } });
  });

  it('rejects non-object records', () => {
    const decoder = new JsonlDecoder();
    const results = decoder.push('[1,2]\n');
    expect(results[0]).toMatchObject({ ok: false, error: 'RPC record must be a JSON object' });
  });

  it('enforces the maximum record size and resynchronizes', () => {
    const decoder = new JsonlDecoder({ maxRecordBytes: 32 });
    const oversized = `{"text":"${'x'.repeat(100)}"}\n`;
    const results = [...decoder.push(oversized), ...decoder.push('{"a":1}\n')];
    expect(results.some((result) => !result.ok)).toBe(true);
    expect(results.at(-1)).toEqual({ ok: true, value: { a: 1 } });
  });

  it('flushes a trailing partial record at EOF', () => {
    const decoder = new JsonlDecoder();
    decoder.push('{"a":1}');
    expect(decoder.flush()[0]).toEqual({ ok: true, value: { a: 1 } });
    expect(decoder.flush()).toEqual([]);
  });
});

describe('encodeRecord', () => {
  it('appends exactly one LF and escapes newlines', () => {
    const encoded = encodeRecord({ message: 'a\nb' });
    expect(encoded.endsWith('\n')).toBe(true);
    expect(encoded.split('\n').filter((part) => part.length > 0)).toHaveLength(1);
  });
});
