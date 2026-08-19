import { describe, expect, it } from 'vitest';
import type { Model } from '../src/shared/domain.js';
import {
  MAX_SCOPED_MODELS,
  isScopedModel,
  isScopedModelKey,
  modelKey,
  nextScopedModel,
  repairScopedModelKey,
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

const key = (provider: string, modelId: string): string => modelKey({ provider, modelId });
const MODELS = [model('a'), model('b'), model('c'), model('a', 'other')];

describe('scoped model keys', () => {
  it('identifies provider/model pairs with collision-safe canonical keys', () => {
    expect(modelKey({ provider: 'fake', modelId: 'a' })).toBe('["fake","a"]');
    expect(key('a:b', 'c')).not.toBe(key('a', 'b:c'));
    expect(isScopedModel([key('fake', 'a')], { provider: 'other', modelId: 'a' })).toBe(false);
    expect(isScopedModel([key('fake', 'a')], { provider: 'fake', modelId: 'a' })).toBe(true);
  });

  it('validates canonical keys and migrates the candidate colon format', () => {
    expect(isScopedModelKey(key('a:b', 'c'))).toBe(true);
    expect(isScopedModelKey('["a", "b"]')).toBe(false);
    expect(repairScopedModelKey('fake:model:version')).toBe(key('fake', 'model:version'));
    expect(repairScopedModelKey('missing-separator')).toBeNull();
  });

  it('toggles entries without disturbing the rest', () => {
    const added = toggleScopedKey([key('fake', 'a')], { provider: 'fake', modelId: 'b' });
    expect(added).toEqual([key('fake', 'a'), key('fake', 'b')]);
    expect(toggleScopedKey(added, { provider: 'fake', modelId: 'a' })).toEqual([key('fake', 'b')]);
  });

  it('bounds the stored list', () => {
    const keys = Array.from({ length: MAX_SCOPED_MODELS }, (_value, index) =>
      key('fake', `m${index}`),
    );
    const toggled = toggleScopedKey(keys, { provider: 'fake', modelId: 'extra' });
    expect(toggled).toHaveLength(MAX_SCOPED_MODELS);
    expect(toggled.at(-1)).toBe(key('fake', 'extra'));
  });
});

describe('scoped model resolution', () => {
  it('keeps runtime list order and ignores models the runtime no longer reports', () => {
    expect(
      scopedModels(MODELS, [key('fake', 'c'), key('fake', 'a'), key('fake', 'gone')]).map(
        (item) => item.id,
      ),
    ).toEqual(['a', 'c']);
  });

  it('cycles inside the scoped set from the active model', () => {
    const keys = [key('fake', 'a'), key('fake', 'c')];
    expect(nextScopedModel(MODELS, keys, { provider: 'fake', modelId: 'a' })).toEqual({
      provider: 'fake',
      modelId: 'c',
    });
    expect(nextScopedModel(MODELS, keys, { provider: 'fake', modelId: 'c' })).toEqual({
      provider: 'fake',
      modelId: 'a',
    });
    expect(nextScopedModel(MODELS, keys, { provider: 'fake', modelId: 'b' })).toEqual({
      provider: 'fake',
      modelId: 'a',
    });
    expect(nextScopedModel(MODELS, keys, null)).toEqual({ provider: 'fake', modelId: 'a' });
  });

  it('declines scoped cycling when fewer than two scoped models are available', () => {
    expect(nextScopedModel(MODELS, [], null)).toBeNull();
    expect(nextScopedModel(MODELS, [key('fake', 'a')], null)).toBeNull();
    expect(nextScopedModel(MODELS, [key('fake', 'gone'), key('fake', 'missing')], null)).toBeNull();
    expect(nextScopedModel([], [key('fake', 'a'), key('fake', 'c')], null)).toBeNull();
  });
});
