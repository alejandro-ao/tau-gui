import { describe, expect, it } from 'vitest';
import type { Model } from '../src/shared/domain.js';
import {
  MAX_SCOPED_MODELS,
  isScopedModel,
  modelKey,
  nextScopedModel,
  scopedModels,
  toggleScopedKey,
} from '../src/shared/scoped-models.js';

function model(id: string, provider = 'fake'): Model {
  return {
    id,
    name: id.toUpperCase(),
    provider,
    api: 'chat',
    reasoning: false,
    input: ['text'],
    contextWindow: 1000,
    maxTokens: 100,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

const MODELS = [model('a'), model('b'), model('c'), model('a', 'other')];

describe('scoped model keys', () => {
  it('identifies a model by provider and id, not by name', () => {
    expect(modelKey({ provider: 'fake', modelId: 'a' })).toBe('fake:a');
    expect(isScopedModel(['fake:a'], { provider: 'other', modelId: 'a' })).toBe(false);
    expect(isScopedModel(['fake:a'], { provider: 'fake', modelId: 'a' })).toBe(true);
  });

  it('toggles entries without disturbing the rest', () => {
    const added = toggleScopedKey(['fake:a'], { provider: 'fake', modelId: 'b' });
    expect(added).toEqual(['fake:a', 'fake:b']);
    expect(toggleScopedKey(added, { provider: 'fake', modelId: 'a' })).toEqual(['fake:b']);
  });

  it('bounds the stored list', () => {
    const keys = Array.from({ length: MAX_SCOPED_MODELS }, (_value, index) => `fake:m${index}`);
    const toggled = toggleScopedKey(keys, { provider: 'fake', modelId: 'extra' });
    expect(toggled).toHaveLength(MAX_SCOPED_MODELS);
    expect(toggled.at(-1)).toBe('fake:extra');
  });
});

describe('scoped model resolution', () => {
  it('keeps runtime list order and ignores models the runtime no longer reports', () => {
    expect(scopedModels(MODELS, ['fake:c', 'fake:a', 'fake:gone']).map((item) => item.id)).toEqual([
      'a',
      'c',
    ]);
  });

  it('cycles inside the scoped set from the active model', () => {
    const keys = ['fake:a', 'fake:c'];
    expect(nextScopedModel(MODELS, keys, { provider: 'fake', modelId: 'a' })).toEqual({
      provider: 'fake',
      modelId: 'c',
    });
    expect(nextScopedModel(MODELS, keys, { provider: 'fake', modelId: 'c' })).toEqual({
      provider: 'fake',
      modelId: 'a',
    });
    // An unscoped or unknown active model jumps to the first scoped entry.
    expect(nextScopedModel(MODELS, keys, { provider: 'fake', modelId: 'b' })).toEqual({
      provider: 'fake',
      modelId: 'a',
    });
    expect(nextScopedModel(MODELS, keys, null)).toEqual({ provider: 'fake', modelId: 'a' });
  });

  it('declines scoped cycling when fewer than two scoped models are available', () => {
    expect(nextScopedModel(MODELS, [], null)).toBeNull();
    expect(nextScopedModel(MODELS, ['fake:a'], null)).toBeNull();
    // Stale keys must not trap the user on a single model.
    expect(nextScopedModel(MODELS, ['fake:gone', 'fake:missing'], null)).toBeNull();
    expect(nextScopedModel([], ['fake:a', 'fake:c'], null)).toBeNull();
  });
});
