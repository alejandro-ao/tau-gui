import type { ReactNode } from 'react';
import { isRunning, shortenPath } from '../state/reducer.js';
import { useStore } from '../state/store.js';
import { formatCost, formatPercent, formatTokens } from './format.js';

const PICKERS = [
  { modal: 'palette', label: 'palette' },
  { modal: 'session', label: 'sessions' },
  { modal: 'tree', label: 'tree' },
  { modal: 'details', label: 'details' },
  { modal: 'settings', label: 'settings' },
  { modal: 'hotkeys', label: 'keys' },
] as const;

export function Sidebar({ id }: { id?: string }): ReactNode {
  const { state, actions } = useStore();
  const { snapshot, agent, stats, settings, commands } = state;
  const running = isRunning(state);
  const model = agent?.model ?? null;
  const context = stats?.contextUsage ?? null;
  const contextPercent = context ? Math.min(100, Math.max(0, context.percent)) : 0;
  const cacheHitRate = cacheRate(stats?.tokens.cacheRead ?? 0, stats?.tokens.input ?? 0);

  return (
    <aside id={id} className="sidebar" data-testid="sidebar" aria-label="session">
      <section className="sidebar-section">
        <h2>session</h2>
        <dl>
          <Row label="name" value={agent?.sessionName ?? null} />
          <Row label="runtime" value={snapshot.runtime} />
          <Row label="model" value={model ? `${model.provider}:${model.id}` : null} />
          <Row label="thinking" value={agent?.thinkingLevel ?? null} />
          <Row label="cwd" value={shortenPath(snapshot.cwd ?? settings.cwd)} />
          <Row label="branch" value={snapshot.gitBranch} />
          <Row label="id" value={agent?.sessionId ?? null} />
          <Row label="file" value={shortenPath(agent?.sessionFile ?? null)} />
        </dl>
      </section>

      {stats ? (
        <section className="sidebar-section">
          <h2>usage</h2>
          <div className="usage-cumulative">
            <dl>
              <Row label="turns" value={`${stats.userMessages}/${stats.assistantMessages}`} />
              <Row label="tools" value={String(stats.toolCalls)} />
              <Row label="input" value={formatTokens(stats.tokens.input)} />
              <Row label="output" value={formatTokens(stats.tokens.output)} />
              <Row
                label="cache"
                value={`${formatTokens(stats.tokens.cacheRead)}r/${formatTokens(
                  stats.tokens.cacheWrite,
                )}w`}
              />
              {/* Derived from reported token counts, not reported by the RPC. */}
              <Row
                label="cache hit"
                value={cacheHitRate === null ? null : `~${formatPercent(cacheHitRate)}`}
              />
              <Row label="cost" value={formatCost(stats.cost)} />
            </dl>
          </div>
          {context ? (
            <div className="usage-context">
              <dl>
                <Row
                  label="context"
                  value={`${formatTokens(context.tokens)}/${formatTokens(context.contextWindow)}`}
                />
              </dl>
              <div
                className="usage-bar"
                data-warn={contextPercent >= 80}
                role="progressbar"
                aria-valuenow={Math.round(contextPercent)}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="context used"
              >
                <span style={{ width: `${contextPercent}%` }} />
              </div>
            </div>
          ) : null}
          <div className="sidebar-state" data-running={running}>
            {running ? '● running' : '○ idle'}
          </div>
        </section>
      ) : null}

      {/* Resources appear only when the runtime actually reports them. */}
      {commands.length > 0 ? (
        <section className="sidebar-section">
          <h2>resources</h2>
          <dl>
            <Row label="commands" value={String(commands.length)} />
          </dl>
          <ul className="path-list">
            {commands.slice(0, 8).map((command) => (
              <li key={command.name} title={command.description}>
                /{command.name}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* Mouse parity for every keyboard-first picker. */}
      <section className="sidebar-section">
        <h2>open</h2>
        <div className="sidebar-actions">
          {PICKERS.map((picker) => (
            <button
              key={picker.modal}
              type="button"
              className="ghost-button"
              onClick={() => actions.openModal(picker.modal)}
            >
              {picker.label}
            </button>
          ))}
        </div>
      </section>

      <div className="version-mark">
        <span>τ = 2π</span>
        <span>{snapshot.runtime}</span>
      </div>
    </aside>
  );
}

function Row({ label, value }: { label: string; value: string | null }): ReactNode {
  if (!value) return null;
  return (
    <div className="sidebar-row">
      <dt>{label}</dt>
      <dd title={value}>{value}</dd>
    </div>
  );
}

/** Estimated cache hit rate: derived locally, never reported by the runtime. */
function cacheRate(cacheRead: number, input: number): number | null {
  const total = cacheRead + input;
  return total > 0 ? (cacheRead / total) * 100 : null;
}
