import { useMemo, type ReactNode } from 'react';
import type { RuntimeStatus } from '../../../../shared/domain.js';
import {
  isScopedModel,
  modelKey,
  modelRefOf,
  scopedModels,
} from '../../../../shared/scoped-models.js';
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
  const availability = modelAvailability(state.snapshot.status, state.models.length > 0);

  const items = useMemo<PickerItem[]>(
    () =>
      state.models.map((model) => {
        const scoped = isScopedModel(keys, modelRefOf(model));
        return {
          id: modelKey(modelRefOf(model)),
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
      subtitle={`app-owned favourites; ${availability.subtitle}`}
      placeholder="search models…"
      items={items}
      emptyLabel={availability.emptyLabel}
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
        const model = state.models.find((candidate) => modelKey(modelRefOf(candidate)) === item.id);
        if (!model) return;
        // Toggling never calls set_model, so scoping cannot switch the model.
        void actions.toggleScopedModel(modelRefOf(model));
      }}
    />
  );
}

export function modelAvailability(
  status: RuntimeStatus,
  hasCachedModels: boolean,
): { subtitle: string; emptyLabel: string } {
  if (
    status === 'idle' ||
    status === 'running' ||
    status === 'compacting' ||
    status === 'retrying'
  ) {
    return {
      subtitle: 'no runtime supports scoped models over RPC',
      emptyLabel: 'the connected runtime reported no models',
    };
  }
  const state =
    status === 'starting'
      ? 'the runtime is starting'
      : status === 'disconnected'
        ? 'the runtime is disconnected'
        : status === 'failed'
          ? 'the runtime failed'
          : 'the runtime is stopped';
  return {
    subtitle: hasCachedModels
      ? `${state}; shown models are cached and may be stale`
      : `${state}; connect it to load models`,
    emptyLabel: `${state}, so no models are currently available to scope`,
  };
}
