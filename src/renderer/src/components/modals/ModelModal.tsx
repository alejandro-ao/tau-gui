import { useMemo, type ReactNode } from 'react';
import type { Model } from '../../../../shared/domain.js';
import { useStore } from '../../state/store.js';
import { formatTokens } from '../format.js';
import { Picker, type PickerItem } from './Picker.js';

/** Model picker showing the full RPC metadata for each model. */
export function ModelModal(): ReactNode {
  const { state, actions } = useStore();
  const active = state.agent?.model ?? null;

  const items = useMemo<PickerItem[]>(
    () =>
      state.models.map((model) => ({
        id: `${model.provider}:${model.id}`,
        label: model.name,
        hint: model.provider,
        detail: describe(model),
        current: active !== null && active.id === model.id && active.provider === model.provider,
        keywords: `${model.provider} ${model.id} ${model.api}`,
      })),
    [state.models, active],
  );

  return (
    <Picker
      name="model"
      title="models"
      subtitle="selection calls the runtime's set_model"
      placeholder="search models…"
      items={items}
      emptyLabel="the runtime reported no models"
      onClose={() => actions.openModal(null)}
      onAccept={(item) => {
        const model = state.models.find(
          (candidate) => `${candidate.provider}:${candidate.id}` === item.id,
        );
        if (!model) return;
        actions.openModal(null);
        void actions.setModel({ provider: model.provider, modelId: model.id });
      }}
    />
  );
}

function describe(model: Model): string {
  const modality = model.input.length > 0 ? model.input.join('/') : 'text';
  const reasoning = model.reasoning ? 'reasoning' : 'no reasoning';
  const pricing = `in $${model.cost.input}/Mtok · out $${model.cost.output}/Mtok · cache $${model.cost.cacheRead}r/$${model.cost.cacheWrite}w`;
  return [
    model.id,
    `${modality} · ${reasoning}`,
    `context ${formatTokens(model.contextWindow)} · max output ${formatTokens(model.maxTokens)}`,
    pricing,
  ].join(' — ');
}
