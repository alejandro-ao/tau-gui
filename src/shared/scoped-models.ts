/**
 * Scoped ("favourite") model helpers.
 *
 * Neither Tau nor Pi exposes an RPC surface to list or edit scoped models, so
 * scoping is owned by this application. Keys use a canonical JSON tuple so
 * arbitrary provider/model punctuation cannot make two identities collide.
 */
import type { Model, ModelRef, RuntimeKind } from './domain.js';

/** Maximum scoped entries kept per runtime; bounds settings growth. */
export const MAX_SCOPED_MODELS = 100;
/** Maximum encoded identity length accepted both from disk and over IPC. */
export const MAX_SCOPED_MODEL_KEY_LENGTH = 200;

export type ScopedModelMap = Record<RuntimeKind, string[]>;

/** Stable collision-safe identity of a model: provider and model id. */
export function modelKey(ref: ModelRef): string {
  return JSON.stringify([ref.provider, ref.modelId]);
}

/** True only for a canonical, bounded model identity produced by `modelKey`. */
export function isScopedModelKey(value: string): boolean {
  if (value.length < 1 || value.length > MAX_SCOPED_MODEL_KEY_LENGTH) return false;
  try {
    const parsed: unknown = JSON.parse(value);
    return (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === 'string' &&
      parsed[0].length > 0 &&
      typeof parsed[1] === 'string' &&
      parsed[1].length > 0 &&
      modelKey({ provider: parsed[0], modelId: parsed[1] }) === value
    );
  } catch {
    return false;
  }
}

/**
 * Repairs a persisted key. Candidate builds used `provider:modelId`; migrate
 * those by splitting the first colon. Ambiguous legacy punctuation could not
 * be recovered perfectly, but every newly written key is collision-safe.
 */
export function repairScopedModelKey(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (isScopedModelKey(value)) return value;
  // Malformed attempted structured keys are dropped rather than reinterpreted.
  if (value.startsWith('[')) return null;
  const separator = value.indexOf(':');
  if (separator < 1 || separator === value.length - 1) return null;
  const migrated = modelKey({
    provider: value.slice(0, separator),
    modelId: value.slice(separator + 1),
  });
  return isScopedModelKey(migrated) ? migrated : null;
}

export function modelRefOf(model: Model): ModelRef {
  return { provider: model.provider, modelId: model.id };
}

export function isScopedModel(keys: readonly string[], ref: ModelRef): boolean {
  return keys.includes(modelKey(ref));
}

/** Adds or removes one key, keeping insertion order and bounding the list. */
export function toggleScopedKey(keys: readonly string[], ref: ModelRef): string[] {
  const key = modelKey(ref);
  if (!isScopedModelKey(key)) return [...keys];
  if (keys.includes(key)) return keys.filter((item) => item !== key);
  return [...keys, key].slice(-MAX_SCOPED_MODELS);
}

/** Scoped models that the runtime currently reports, in runtime list order. */
export function scopedModels(models: readonly Model[], keys: readonly string[]): Model[] {
  return models.filter((model) => isScopedModel(keys, modelRefOf(model)));
}

/**
 * Next model for scoped cycling, or `null` when scoped cycling does not apply.
 * With fewer than two currently reported favourites, callers use runtime cycle.
 */
export function nextScopedModel(
  models: readonly Model[],
  keys: readonly string[],
  active: ModelRef | null,
): ModelRef | null {
  const scoped = scopedModels(models, keys);
  if (scoped.length < 2) return null;
  const index = active
    ? scoped.findIndex((model) => modelKey(modelRefOf(model)) === modelKey(active))
    : -1;
  const next = scoped[(index + 1) % scoped.length];
  return next ? modelRefOf(next) : null;
}
