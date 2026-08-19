import type { ReactNode } from 'react';
import { useStore } from '../state/store.js';
import { Disclosure } from './Disclosure.js';
import { formatCost, formatPercent, formatTokens } from './format.js';

/**
 * Session sidebar modeled on Tau's TUI: title, activity, usage, context files,
 * collapsible resource sections, and the version mark at the bottom.
 * Sections whose data is unavailable are omitted entirely.
 */
export function Sidebar({ id }: { id?: string }): ReactNode {
  const { state } = useStore();
  const { snapshot, agent, stats, resources, contextFiles } = state;
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

      {contextFiles.length > 0 ? (
        <section className="sidebar-section">
          <h2>context</h2>
          <ul className="context-files">
            {contextFiles.map((file) => (
              <li key={file.path} title={file.path} aria-label={`${file.label}: ${file.path}`}>
                {file.label}
              </li>
            ))}
          </ul>
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
