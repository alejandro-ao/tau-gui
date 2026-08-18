import { useState, type ReactNode } from 'react';
import { useStore } from '../../state/store.js';
import { CopyButton } from '../CopyButton.js';
import { formatCost, formatPercent, formatTokens } from '../format.js';
import { Modal } from './Modal.js';

/** Session details and statistics, with in-place renaming. */
export function DetailsModal(): ReactNode {
  const { state, actions } = useStore();
  const { snapshot, agent, stats, settings } = state;
  const [name, setName] = useState(agent?.sessionName ?? '');

  const rows: { label: string; value: string | null }[] = [
    { label: 'id', value: agent?.sessionId ?? null },
    { label: 'file', value: agent?.sessionFile ?? null },
    { label: 'runtime', value: snapshot.runtime },
    {
      label: 'model',
      value: agent?.model ? `${agent.model.provider}:${agent.model.id}` : null,
    },
    { label: 'thinking', value: agent?.thinkingLevel ?? null },
    { label: 'cwd', value: snapshot.cwd ?? settings.cwd },
    { label: 'branch', value: snapshot.gitBranch },
    { label: 'messages', value: agent ? String(agent.messageCount) : null },
    { label: 'pending', value: agent ? String(agent.pendingMessageCount) : null },
    {
      label: 'tokens',
      value: stats
        ? `${formatTokens(stats.tokens.input)} in / ${formatTokens(stats.tokens.output)} out / ${formatTokens(
            stats.tokens.cacheRead,
          )}r ${formatTokens(stats.tokens.cacheWrite)}w cache`
        : null,
    },
    { label: 'cost', value: stats ? formatCost(stats.cost) : null },
    {
      label: 'context',
      value: stats
        ? `${formatTokens(stats.contextUsage.tokens)}/${formatTokens(
            stats.contextUsage.contextWindow,
          )} (${formatPercent(stats.contextUsage.percent)})`
        : null,
    },
    {
      label: 'auto-compaction',
      value: agent ? (agent.autoCompactionEnabled ? 'enabled' : 'disabled') : null,
    },
  ];

  const summary = rows
    .filter((row) => row.value)
    .map((row) => `${row.label}: ${row.value ?? ''}`)
    .join('\n');

  return (
    <Modal
      name="details"
      title="session"
      subtitle="values come from the runtime's get_state and get_stats responses"
      onClose={() => actions.openModal(null)}
      footer={
        <>
          <CopyButton text={summary} label="details" />
          {agent ? (
            <button
              type="button"
              className="ghost-button"
              onClick={() => void actions.setAutoCompaction(!agent.autoCompactionEnabled)}
            >
              {agent.autoCompactionEnabled ? 'disable auto-compaction' : 'enable auto-compaction'}
            </button>
          ) : null}
        </>
      }
    >
      <form
        className="modal-field"
        onSubmit={(event) => {
          event.preventDefault();
          const trimmed = name.trim();
          if (!trimmed) return;
          void actions.nameSession(trimmed);
          actions.openModal(null);
        }}
      >
        <label htmlFor="session-name">name</label>
        <input
          id="session-name"
          type="text"
          value={name}
          spellCheck={false}
          placeholder="unnamed session"
          onChange={(event) => setName(event.target.value)}
        />
        <button type="submit" className="ghost-button">
          rename
        </button>
      </form>

      <dl className="detail-list">
        {rows.map((row) =>
          row.value ? (
            <div className="detail-row" key={row.label}>
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ) : null,
        )}
      </dl>
    </Modal>
  );
}
