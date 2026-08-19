import type { ReactNode } from 'react';
import { isRunning } from '../state/reducer.js';
import { useStore } from '../state/store.js';
import { Disclosure } from './Disclosure.js';
import { formatCost, formatPercent, formatTokens } from './format.js';

const PICKERS = [
  { modal: 'palette', label: 'palette' },
  { modal: 'session', label: 'sessions' },
  { modal: 'tree', label: 'tree' },
  { modal: 'details', label: 'details' },
  { modal: 'settings', label: 'settings' },
  { modal: 'hotkeys', label: 'keys' },
] as const;

/**
 * Session sidebar modeled on Tau's TUI: title, activity, usage, compaction,
 * context, collapsible resource sections, and the version mark at the bottom.
 * Sections whose data the runtime does not report are omitted entirely.
 */
export function Sidebar({ id }: { id?: string }): ReactNode {
  const { state, actions } = useStore();
  const { snapshot, agent, stats, commands, resources } = state;
  const running = isRunning(state);
  const context = stats?.contextUsage ?? null;
  const contextPercent = context ? Math.min(100, Math.max(0, context.percent)) : 0;
  const cacheHitRate = cacheRate(stats?.tokens.cacheRead ?? 0, stats?.tokens.input ?? 0);

  return (
    <aside id={id} className="sidebar" data-testid="sidebar" aria-label="session">
      <section className="sidebar-section sidebar-title">
        <h1>{agent?.sessionName ?? 'untitled session'}</h1>
      </section>

      <section className="sidebar-section">
        <h2>activity</h2>
        {stats ? (
          <p className="sidebar-line">
            {stats.userMessages} turns, {stats.toolCalls} tool calls
          </p>
        ) : null}
        <p className="sidebar-state" data-running={running}>
          {running ? '● running' : '○ idle'}
        </p>
      </section>

      {stats ? (
        <section className="sidebar-section">
          <h2>usage</h2>
          <p className="sidebar-line">
            {formatTokens(stats.tokens.input)} in, {formatTokens(stats.tokens.output)} out ·{' '}
            {formatCost(stats.cost)}
          </p>
          {/* Derived from reported token counts, not reported by the RPC. */}
          {cacheHitRate === null ? null : (
            <p className="sidebar-line dim">cache: ~{formatPercent(cacheHitRate)} session</p>
          )}
        </section>
      ) : null}

      {agent ? (
        <section className="sidebar-section">
          <h2>compaction</h2>
          <p className="sidebar-line dim">
            {/* The auto-compaction threshold is not exposed over RPC. */}
            {agent.autoCompactionEnabled ? 'auto' : 'off'}
          </p>
        </section>
      ) : null}

      {context ? (
        <section className="sidebar-section">
          <h2>context</h2>
          <div className="usage-context">
            <p className="sidebar-line">
              {formatTokens(context.tokens)}/{formatTokens(context.contextWindow)} ·{' '}
              {formatPercent(contextPercent)}
            </p>
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
        </section>
      ) : null}

      {resources.skills.length > 0 ? (
        <Disclosure
          title="skills"
          count={resources.skills.length}
          items={resources.skills.map((skill) => ({
            label: skill.name,
            title: `${skill.description ?? 'No description'} · ${skill.origin}`,
            dimmed: skill.disableModelInvocation,
          }))}
        />
      ) : null}

      {resources.prompts.length > 0 ? (
        <Disclosure
          title="prompts"
          count={resources.prompts.length}
          items={resources.prompts.map((prompt) => ({
            label: `/${prompt.name}`,
            title: `${prompt.description ?? 'No description'} · ${prompt.origin}`,
          }))}
        />
      ) : null}

      {commands.length > 0 ? (
        <Disclosure
          title="commands"
          count={commands.length}
          items={commands.map((command) => ({
            label: `/${command.name}`,
            title: command.description,
          }))}
        />
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
        <span>{versionLabel(snapshot.runtime, snapshot.runtimeVersion)}</span>
      </div>
    </aside>
  );
}

/** `tau --version` prints "tau 0.3.12"; avoid doubling the runtime name. */
export function versionLabel(runtime: string, version: string | null): string {
  if (!version) return runtime;
  const bare = version.startsWith(`${runtime} `) ? version.slice(runtime.length + 1) : version;
  return `${runtime} ${bare}`;
}

/** Estimated cache hit rate: derived locally, never reported by the runtime. */
function cacheRate(cacheRead: number, input: number): number | null {
  const total = cacheRead + input;
  return total > 0 ? (cacheRead / total) * 100 : null;
}
