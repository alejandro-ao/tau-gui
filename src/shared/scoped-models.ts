/**
 * Scoped ("favourite") model helpers.
 *
 * Neither Tau nor Pi exposes an RPC surface to list or edit scoped models, so
 * scoping is owned by this application: the selection lives in GUI settings,
 * keyed by runtime kind and by `provider:modelId`, and is only ever applied
 * through the ordinary `set_model` command. Nothing here invents protocol.
 */
import type { Model, ModelRef, RuntimeKind } from './domain.js';

/** Maximum scoped entries kept per runtime; bounds settings growth. */
export const MAX_SCOPED_MODELS = 100;

export type ScopedModelMap = Record<RuntimeKind, string[]>;

/** Stable identity of a model: provider and model id, never the display name. */
export function modelKey(ref: ModelRef): string {
  return `${ref.provider}:${ref.modelId}`;
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
  if (keys.includes(key)) return keys.filter((item) => item !== key);
  return [...keys, key].slice(-MAX_SCOPED_MODELS);
}

/** Scoped models that the runtime currently reports, in runtime list order. */
export function scopedModels(models: readonly Model[], keys: readonly string[]): Model[] {
  return models.filter((model) => isScopedModel(keys, modelRefOf(model)));
}

/**
 * Next model for scoped cycling, or `null` when scoped cycling does not apply.
 *
 * Scoped cycling needs at least two runtime-reported scoped models; with fewer,
 * callers fall back to the runtime's own `cycle_model`, so a stale or empty
 * scope never traps the user on one model.
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
