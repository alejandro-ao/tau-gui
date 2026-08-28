import {
  INTROSPECTION_LIMITS,
  parseBoundedJson,
  type BoundedJson,
} from '../../shared/introspection.js';

/** Maximum UTF-16 characters in one normalized tool/shell output string. */
export const MAX_TOOL_OUTPUT_CHARACTERS = 64 * 1024;
const OUTPUT_TRUNCATION_MARKER = '\n[tool output truncated by desktop security limit]';

export function boundedToolText(value: string): string {
  if (value.length <= MAX_TOOL_OUTPUT_CHARACTERS) return value;
  return `${value.slice(0, MAX_TOOL_OUTPUT_CHARACTERS - OUTPUT_TRUNCATION_MARKER.length)}${OUTPUT_TRUNCATION_MARKER}`;
}

/** Convert unknown SDK data to bounded JSON without reading accessors or calling toJSON. */
export function boundJson(value: unknown): { value: BoundedJson; truncated: boolean } {
  let nodes = 0;
  let truncated = false;
  const ancestors = new WeakSet<object>();
  const sentinel = (): BoundedJson => {
    truncated = true;
    return '[truncated]';
  };

  const visit = (input: unknown, depth: number): BoundedJson => {
    nodes += 1;
    if (depth > INTROSPECTION_LIMITS.schemaDepth || nodes > INTROSPECTION_LIMITS.schemaNodes) {
      return sentinel();
    }
    if (input === null || typeof input === 'boolean') return input;
    if (typeof input === 'number') return Number.isFinite(input) ? input : sentinel();
    if (typeof input === 'string') {
      const output = stripControls(input).slice(0, INTROSPECTION_LIMITS.schemaStringCharacters);
      if (output.length < input.length) truncated = true;
      return output;
    }
    if (typeof input !== 'object') return sentinel();
    if (ancestors.has(input)) return sentinel();
    ancestors.add(input);
    try {
      let descriptors: Record<string, PropertyDescriptor>;
      try {
        descriptors = Object.getOwnPropertyDescriptors(input);
      } catch {
        return sentinel();
      }

      let array = false;
      try {
        array = Array.isArray(input);
      } catch {
        return sentinel();
      }
      if (array) {
        const lengthDescriptor = descriptors['length'];
        if (
          !lengthDescriptor ||
          !('value' in lengthDescriptor) ||
          !Number.isSafeInteger(lengthDescriptor.value) ||
          lengthDescriptor.value < 0
        ) {
          return sentinel();
        }
        const length = Math.min(lengthDescriptor.value, INTROSPECTION_LIMITS.schemaArrayItems);
        if (length < lengthDescriptor.value) truncated = true;
        const output: BoundedJson[] = [];
        for (let index = 0; index < length; index += 1) {
          const descriptor = descriptors[String(index)];
          if (!descriptor) output.push(null);
          else if ('value' in descriptor) output.push(visit(descriptor.value, depth + 1));
          else output.push(sentinel());
        }
        return output;
      }

      const entries = Object.entries(descriptors).filter(([, descriptor]) => descriptor.enumerable);
      if (entries.length > INTROSPECTION_LIMITS.schemaObjectProperties) truncated = true;
      const output = Object.create(null) as Record<string, BoundedJson>;
      for (const [rawKey, descriptor] of entries.slice(
        0,
        INTROSPECTION_LIMITS.schemaObjectProperties,
      )) {
        const key = stripControls(rawKey).slice(0, INTROSPECTION_LIMITS.schemaKeyCharacters);
        if (!key || !('value' in descriptor)) {
          sentinel();
          continue;
        }
        if (key.length < rawKey.length || Object.hasOwn(output, key)) {
          sentinel();
          continue;
        }
        Object.defineProperty(output, key, {
          value: visit(descriptor.value, depth + 1),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      return output;
    } catch {
      return sentinel();
    } finally {
      ancestors.delete(input);
    }
  };

  const output = visit(value, 0);
  try {
    return { value: parseBoundedJson(output), truncated };
  } catch {
    return {
      value: Object.assign(Object.create(null) as Record<string, BoundedJson>, {
        truncated: 'schema exceeded bounded JSON limits',
      }),
      truncated: true,
    };
  }
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
