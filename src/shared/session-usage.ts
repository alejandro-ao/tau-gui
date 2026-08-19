import type { AgentMessage, AssistantMessage } from './domain.js';

export interface RequestUsage {
  number: number;
  timestamp: number;
  provider: string;
  model: string;
  fresh: number;
  cached: number;
  cacheWrite: number;
  prompt: number;
  output: number;
  reasoning: number;
  hitRate: number;
  cost: number | null;
  stopReason: string | null;
}

export interface SessionUsage {
  requests: RequestUsage[];
  toolCalls: { name: string; count: number }[];
  compactions: number;
  totalFresh: number;
  totalCached: number;
  totalCacheWrite: number;
  totalPrompt: number;
  totalOutput: number;
  totalReasoning: number;
  cacheHitRate: number | null;
  reportedCost: number | null;
}

/** Derives export-style usage metrics solely from normalized RPC messages. */
export function deriveSessionUsage(messages: readonly AgentMessage[]): SessionUsage {
  const assistants = messages.filter(
    (message): message is AssistantMessage =>
      message.role === 'assistant' && message.usage !== null,
  );
  const toolCounts = new Map<string, number>();
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const call of message.toolCalls) {
      toolCounts.set(call.name, (toolCounts.get(call.name) ?? 0) + 1);
    }
  }

  const requests = assistants.map((message, index): RequestUsage => {
    const usage = message.usage;
    if (!usage) throw new Error('usage was narrowed above');
    const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
    return {
      number: index + 1,
      timestamp: message.timestamp,
      provider: message.provider,
      model: message.model,
      fresh: usage.input,
      cached: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      prompt,
      output: usage.output,
      reasoning: usage.reasoning ?? 0,
      hitRate: prompt > 0 ? usage.cacheRead / prompt : 0,
      cost: usage.cost,
      stopReason: message.stopReason,
    };
  });

  const totalFresh = sum(requests, 'fresh');
  const totalCached = sum(requests, 'cached');
  const totalCacheWrite = sum(requests, 'cacheWrite');
  const totalPrompt = totalFresh + totalCached + totalCacheWrite;
  const costs = requests.flatMap((request) =>
    request.cost !== null && request.cost > 0 ? [request.cost] : [],
  );

  return {
    requests,
    toolCalls: [...toolCounts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name)),
    compactions: messages.filter((message) => message.role === 'compactionSummary').length,
    totalFresh,
    totalCached,
    totalCacheWrite,
    totalPrompt,
    totalOutput: sum(requests, 'output'),
    totalReasoning: sum(requests, 'reasoning'),
    cacheHitRate:
      totalPrompt > 0 && (totalCached > 0 || totalCacheWrite > 0)
        ? totalCached / totalPrompt
        : null,
    reportedCost: costs.length > 0 ? costs.reduce((total, cost) => total + cost, 0) : null,
  };
}

function sum(
  requests: readonly RequestUsage[],
  key: 'fresh' | 'cached' | 'cacheWrite' | 'output' | 'reasoning',
): number {
  return requests.reduce((total, request) => total + request[key], 0);
}
