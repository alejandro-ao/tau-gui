import { useMemo, type ReactNode } from 'react';
import { isScopedModel, modelRefOf, scopedModels } from '../../../../shared/scoped-models.js';
import { useStore } from '../../state/store.js';
import { Picker, type PickerItem } from './Picker.js';

/**
 * Scoped ("favourite") model manager.
 *
 * Accepting a row toggles scope only: the active model is never changed here,
 * and the dialog stays open so several models can be scoped in one pass. The
 * selection is persisted by the main process through validated settings IPC.
 */
export function ScopedModelsModal(): ReactNode {
  const { state, actions } = useStore();
  const runtime = state.settings.agentRuntime;
  const keys = state.settings.scopedModels[runtime];
  const active = state.agent?.model ?? null;
  const running = state.snapshot.status !== 'stopped' && state.snapshot.status !== 'failed';

  const items = useMemo<PickerItem[]>(
    () =>
      state.models.map((model) => {
        const scoped = isScopedModel(keys, modelRefOf(model));
        return {
          id: `${model.provider}:${model.id}`,
          label: model.name,
          hint: model.provider,
          badge: scoped ? 'scoped' : null,
          detail: `${model.id} — ${scoped ? 'in scope · enter or click removes it' : 'not scoped · enter or click adds it'}`,
          current: active !== null && active.id === model.id && active.provider === model.provider,
          keywords: `${model.provider} ${model.id} ${scoped ? 'scoped favourite' : 'unscoped'}`,
        };
      }),
    [state.models, keys, active],
  );

  const scopedCount = scopedModels(state.models, keys).length;

  return (
    <Picker
      name="scoped"
      title={`scoped models · ${runtime}`}
      subtitle="app-owned favourites; no runtime supports scoped models over RPC"
      placeholder="search models…"
      items={items}
      emptyLabel={
        running
          ? 'the runtime reported no models'
          : 'the runtime is not running, so it reports no models to scope'
      }
      footer={
        <span>
          {scopedCount === 0
            ? 'nothing scoped · Ctrl+P cycles every model'
            : scopedCount === 1
              ? '1 scoped · Ctrl+P cycles every model until two are scoped'
              : `${scopedCount} scoped · Ctrl+P cycles scoped models only`}
        </span>
      }
      onClose={() => actions.openModal(null)}
      onAccept={(item) => {
        const model = state.models.find(
          (candidate) => `${candidate.provider}:${candidate.id}` === item.id,
        );
        if (!model) return;
        // Toggling never calls set_model, so scoping cannot switch the model.
        void actions.toggleScopedModel(modelRefOf(model));
      }}
    />
  );
}
