import { useMemo, type ReactNode } from 'react';
import { deriveSessionUsage, type RequestUsage } from '../../../shared/session-usage.js';
import { useStore } from '../state/store.js';

const number = new Intl.NumberFormat('en-US');

export function SessionUsage(): ReactNode {
  const { state } = useStore();
  const usage = useMemo(() => deriveSessionUsage(state.messages), [state.messages]);

  if (state.sessionTransitioning) {
    return (
      <p className="usage-empty" role="status">
        Loading session usage…
      </p>
    );
  }
  if (usage.requests.length === 0) {
    return (
      <section className="session-usage usage-empty" aria-label="Session usage">
        <h1>Session usage</h1>
        <p>No assistant responses with token usage are available for this session yet.</p>
        <p>Metrics appear after the runtime reports usage for a completed model request.</p>
      </section>
    );
  }

  const aggregateCost = state.stats?.cost;
  const cost =
    aggregateCost !== null && aggregateCost !== undefined && aggregateCost > 0
      ? aggregateCost
      : usage.reportedCost;
  const totals = state.stats?.tokens;
  const totalFresh = totals?.input ?? usage.totalFresh;
  const totalCached = totals?.cacheRead ?? usage.totalCached;
  const totalCacheWrite = totals?.cacheWrite ?? usage.totalCacheWrite;
  const totalPrompt = totalFresh + totalCached + totalCacheWrite;
  const cacheHitRate =
    totalPrompt > 0 && (totalCached > 0 || totalCacheWrite > 0) ? totalCached / totalPrompt : null;
  const rates: number[] = [];
  let cached = 0;
  let prompt = 0;
  for (const request of usage.requests) {
    cached += request.cached;
    prompt += request.prompt;
    rates.push(prompt > 0 ? cached / prompt : 0);
  }

  return (
    <section className="session-usage" aria-label="Session usage">
      <div className="usage-heading">
        <div>
          <h1>Session usage</h1>
          <p>Provider-reported measurements for the current normalized RPC transcript.</p>
        </div>
      </div>

      <div className="usage-cards">
        <Metric
          label="Model requests"
          value={number.format(state.stats?.assistantMessages ?? usage.requests.length)}
        />
        <Metric label="Cache hit rate" value={formatPercent(cacheHitRate)} />
        <Metric label="Cached input" value={number.format(totalCached)} />
        <Metric label="Cache writes" value={number.format(totalCacheWrite)} />
        <Metric label="Fresh input" value={number.format(totalFresh)} />
        <Metric label="Total prompt input" value={number.format(totalPrompt)} />
        <Metric label="Output tokens" value={number.format(totals?.output ?? usage.totalOutput)} />
        <Metric label="Visible reasoning" value={number.format(usage.totalReasoning)} />
        <Metric label="Estimated cost" value={formatCost(cost)} />
        <Metric label="Compactions" value={number.format(usage.compactions)} />
      </div>

      <p className="usage-note">
        Cards prefer cumulative runtime stats, including requests replaced by compaction; plots and
        the request table cover usage exposed in the normalized active transcript. Cost is the
        runtime total when available. Model, thinking, branch, and compaction chart markers are not
        exposed by the message RPC, so none are inferred.
      </p>

      <div className="usage-charts">
        <UsageChart
          title="Prompt input by request"
          requests={usage.requests}
          series={[
            { name: 'cached', key: 'cached' },
            { name: 'cache writes', key: 'cacheWrite' },
            { name: 'fresh', key: 'fresh' },
          ]}
        />
        {usage.cacheHitRate === null ? null : (
          <UsageChart
            title="Cache hit rate"
            requests={usage.requests}
            series={[
              { name: 'request', values: usage.requests.map((request) => request.hitRate * 100) },
              { name: 'cumulative', values: rates.map((rate) => rate * 100) },
            ]}
            percent
          />
        )}
        <UsageChart
          title="Output and reasoning tokens"
          requests={usage.requests}
          series={[
            { name: 'output', key: 'output' },
            { name: 'reasoning', key: 'reasoning' },
          ]}
        />
      </div>

      <div className="usage-details">
        <section className="usage-panel">
          <h2>Requests</h2>
          <div className="usage-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Time</th>
                  <th>Provider</th>
                  <th>Model</th>
                  <th>Fresh</th>
                  <th>Cached</th>
                  <th>Written</th>
                  <th>Prompt</th>
                  <th>Hit rate</th>
                  <th>Output</th>
                  <th>Reasoning</th>
                  <th>Cost</th>
                  <th>Stop</th>
                </tr>
              </thead>
              <tbody>
                {usage.requests.map((request) => (
                  <tr key={request.number}>
                    <td>{request.number}</td>
                    <td>{formatTime(request.timestamp)}</td>
                    <td>{request.provider || 'unavailable'}</td>
                    <td>{request.model || 'unavailable'}</td>
                    <td>{number.format(request.fresh)}</td>
                    <td>{number.format(request.cached)}</td>
                    <td>{number.format(request.cacheWrite)}</td>
                    <td>{number.format(request.prompt)}</td>
                    <td>{usage.cacheHitRate === null ? 'N/A' : formatPercent(request.hitRate)}</td>
                    <td>{number.format(request.output)}</td>
                    <td>{number.format(request.reasoning)}</td>
                    <td>{formatCost(request.cost)}</td>
                    <td>{request.stopReason ?? 'unavailable'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <section className="usage-panel usage-tools">
          <h2>Tool calls</h2>
          {usage.toolCalls.length === 0 ? (
            <p className="usage-muted">No tool calls.</p>
          ) : (
            usage.toolCalls.map((tool) => (
              <div className="usage-tool" key={tool.name}>
                <span>{tool.name}</span>
                <strong>{tool.count}</strong>
              </div>
            ))
          )}
        </section>
      </div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }): ReactNode {
  return (
    <div className="usage-card">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

type NumericKey = 'cached' | 'cacheWrite' | 'fresh' | 'output' | 'reasoning';
type Series =
  | { name: string; key: NumericKey; values?: never }
  | { name: string; values: number[]; key?: never };

function UsageChart({
  title,
  requests,
  series,
  percent = false,
}: {
  title: string;
  requests: RequestUsage[];
  series: Series[];
  percent?: boolean;
}): ReactNode {
  const width = 720;
  const height = 240;
  const left = 50;
  const right = 16;
  const top = 34;
  const bottom = 38;
  const values = series.map((item) => item.values ?? requests.map((request) => request[item.key]));
  const maximum = percent ? 100 : Math.max(1, ...values.flat());
  const x = (index: number): number =>
    left + (index / Math.max(1, requests.length - 1)) * (width - left - right);
  const y = (value: number): number => top + (1 - value / maximum) * (height - top - bottom);

  return (
    <figure className="usage-figure">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={title}>
        <text className="usage-chart-title" x={left} y={20}>
          {title}
        </text>
        {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
          const lineY = y(maximum * ratio);
          return (
            <g key={ratio}>
              <line className="usage-grid" x1={left} x2={width - right} y1={lineY} y2={lineY} />
              <text className="usage-tick" x={left - 7} y={lineY + 4} textAnchor="end">
                {percent ? `${Math.round(ratio * 100)}%` : compact(maximum * ratio)}
              </text>
            </g>
          );
        })}
        {series.map((item, index) => (
          <g className={`usage-series usage-series-${index + 1}`} key={item.name}>
            <polyline
              points={values[index]?.map((value, point) => `${x(point)},${y(value)}`).join(' ')}
            />
          </g>
        ))}
        {requests.map((request, index) => (
          <text
            className="usage-tick"
            key={request.number}
            x={x(index)}
            y={height - 12}
            textAnchor="middle"
          >
            {request.number}
          </text>
        ))}
      </svg>
      <figcaption>
        {series.map((item, index) => (
          <span className={`usage-legend usage-legend-${index + 1}`} key={item.name}>
            {item.name}
          </span>
        ))}
      </figcaption>
    </figure>
  );
}

function compact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(Math.round(value));
}

function formatPercent(value: number | null): string {
  return value === null ? 'N/A' : `${(value * 100).toFixed(1)}%`;
}

function formatCost(value: number | null): string {
  if (value === null) return '$N/A';
  return value > 0 && value < 0.01 ? `$${value.toFixed(3)}` : `$${value.toFixed(2)}`;
}

function formatTime(timestamp: number): string {
  if (!timestamp) return 'unavailable';
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}
