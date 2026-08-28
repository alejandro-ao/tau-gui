import { INTROSPECTION_LIMITS, type BoundedJson } from '../../shared/introspection.js';

/** Maximum plain-text tool output allowed through the desktop domain boundary. */
export const MAX_TOOL_OUTPUT_CHARACTERS = 64 * 1024;

export function boundedToolText(value: string): string {
  if (value.length <= MAX_TOOL_OUTPUT_CHARACTERS) return value;
  return `${value.slice(0, MAX_TOOL_OUTPUT_CHARACTERS)}\n[tool output truncated by desktop security limit]`;
}

/** Convert unknown SDK data to bounded JSON without invoking getters or toJSON. */
export function boundJson(value: unknown): { value: BoundedJson; truncated: boolean } {
  let nodes = 0;
  let bytes = 0;
  let truncated = false;
  const visit = (input: unknown, depth: number): BoundedJson => {
    nodes += 1;
    if (depth > INTROSPECTION_LIMITS.schemaDepth || nodes > INTROSPECTION_LIMITS.schemaNodes) {
      truncated = true;
      return '[truncated]';
    }
    if (input === null || typeof input === 'boolean') return input;
    if (typeof input === 'number') return Number.isFinite(input) ? input : String(input);
    if (typeof input === 'string') {
      const output = stripControls(input).slice(0, INTROSPECTION_LIMITS.schemaStringCharacters);
      bytes += Buffer.byteLength(output);
      if (output.length < input.length || bytes > INTROSPECTION_LIMITS.schemaBytes)
        truncated = true;
      return bytes > INTROSPECTION_LIMITS.schemaBytes ? '[truncated]' : output;
    }
    if (Array.isArray(input)) {
      if (input.length > INTROSPECTION_LIMITS.schemaArrayItems) truncated = true;
      return input
        .slice(0, INTROSPECTION_LIMITS.schemaArrayItems)
        .map((item) => visit(item, depth + 1));
    }
    if (typeof input === 'object') {
      const output: Record<string, BoundedJson> = {};
      const descriptors = Object.getOwnPropertyDescriptors(input);
      const entries = Object.entries(descriptors).filter(([, descriptor]) => 'value' in descriptor);
      if (entries.length > INTROSPECTION_LIMITS.schemaObjectProperties) truncated = true;
      for (const [rawKey, descriptor] of entries.slice(
        0,
        INTROSPECTION_LIMITS.schemaObjectProperties,
      )) {
        const key = stripControls(rawKey).slice(0, INTROSPECTION_LIMITS.schemaKeyCharacters);
        if (!key) continue;
        if (key.length < rawKey.length) truncated = true;
        Object.defineProperty(output, key, {
          value: visit(descriptor.value, depth + 1),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      return output;
    }
    truncated = true;
    return `[unsupported ${typeof input}]`;
  };
  const output = visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(output)) > INTROSPECTION_LIMITS.schemaBytes) {
    return { value: { truncated: 'schema exceeded 64 KiB' }, truncated: true };
  }
  return { value: output, truncated };
}

export function boundedRecord(value: unknown): Record<string, unknown> {
  const bounded = boundJson(value).value;
  return typeof bounded === 'object' && bounded !== null && !Array.isArray(bounded) ? bounded : {};
}

function stripControls(value: string): string {
  return [...value]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f ? ' ' : character;
    })
    .join('')
    .trim();
}
