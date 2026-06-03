import type { AssistantUsage, ChatMessage, PruningDetails, ToolCall } from '../../../shared/protocol';

/**
 * Aggregate token usage for a session derived from per-assistant-message usage
 * reported by the backend. Pure summation \u2014 mirrors what we display in the UI
 * and what analytics records.
 */
export interface SessionTokenUsageSummary {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  /** Number of assistant turns that contributed usage data. */
  reportedTurnCount: number;
  /** Usage from the most recent assistant turn that reported it. */
  lastTurn: AssistantUsage | null;
}

export const EMPTY_SESSION_TOKEN_USAGE: SessionTokenUsageSummary = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 0,
  reportedTurnCount: 0,
  lastTurn: null,
};

export function buildSessionTokenUsage(transcript: ChatMessage[]): SessionTokenUsageSummary {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let totalTokens = 0;
  let reportedTurnCount = 0;
  let lastTurn: AssistantUsage | null = null;

  for (const message of transcript) {
    if (message.role !== 'assistant' || !message.usage) continue;
    const usage = message.usage;
    inputTokens += usage.inputTokens;
    outputTokens += usage.outputTokens;
    cacheReadTokens += usage.cacheReadTokens;
    cacheWriteTokens += usage.cacheWriteTokens;
    totalTokens += usage.totalTokens;
    reportedTurnCount += 1;
    lastTurn = usage;
  }

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
    reportedTurnCount,
    lastTurn,
  };
}

const tokenFormatter = new Intl.NumberFormat('en-US');

function trimDecimal(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, '');
}

export function formatCompactTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${trimDecimal(tokens / 1_000_000)}M`;
  if (tokens >= 1_000) return `${trimDecimal(tokens / 1_000)}k`;
  return String(tokens);
}

export function formatReadableTokens(tokens: number): string {
  return tokenFormatter.format(tokens);
}

export interface SessionTokenIndicatorState {
  /** Compact token counts \u2014 e.g. "\u2191 12.3k \u2193 4.5k". */
  label: string;
  /** Always-visible rate label \u2014 e.g. "12.3 t/s" or "\u2014 t/s". */
  rateLabel: string;
  ariaLabel: string;
  /** Multi-line tooltip with totals + last turn + cache breakdown. */
  tooltip: string;
}

export interface TokenRateState {
  /** Tokens per second (output), smoothed over the window. */
  tokensPerSecond: number | null;
  /** Window size in seconds for the rolling average. */
  windowSeconds: number;
}

export function buildSessionTokenIndicator(
  summary: SessionTokenUsageSummary,
  rate: TokenRateState | null,
): SessionTokenIndicatorState {
  // Always show token indicator, even when no usage reported
  const compactIn = summary.reportedTurnCount > 0 ? formatCompactTokens(summary.inputTokens) : '\u2014';
  const compactOut = summary.reportedTurnCount > 0 ? formatCompactTokens(summary.outputTokens) : '\u2014';

  // Token counts label (always present)
  const label = `\u2191 ${compactIn} \u2193 ${compactOut}`;

  // Rate label (always visible \u2014 shows dash when idle)
  let rateLabel: string;
  if (rate?.tokensPerSecond !== null && rate?.tokensPerSecond !== undefined) {
    const rateStr = rate.tokensPerSecond >= 100
      ? Math.round(rate.tokensPerSecond).toString()
      : rate.tokensPerSecond.toFixed(1);
    rateLabel = `${rateStr} t/s`;
  } else {
    rateLabel = '\u2014 t/s';
  }

  const tooltipLines: string[] = [
    `Session tokens (${summary.reportedTurnCount} assistant turn${summary.reportedTurnCount === 1 ? '' : 's'})`,
    `  Input:  ${formatReadableTokens(summary.inputTokens)}`,
    `  Output: ${formatReadableTokens(summary.outputTokens)}`,
  ];
  if (summary.cacheReadTokens > 0 || summary.cacheWriteTokens > 0) {
    tooltipLines.push(
      `  Cache read:  ${formatReadableTokens(summary.cacheReadTokens)}`,
      `  Cache write: ${formatReadableTokens(summary.cacheWriteTokens)}`,
    );
  }
  tooltipLines.push(`  Total: ${formatReadableTokens(summary.totalTokens)}`);
  if (summary.lastTurn) {
    tooltipLines.push(
      '',
      'Last turn:',
      `  \u2191 ${formatReadableTokens(summary.lastTurn.inputTokens)}  \u2193 ${formatReadableTokens(summary.lastTurn.outputTokens)}`,
    );
  }

  let ariaLabel =
    `Session token usage: input ${formatReadableTokens(summary.inputTokens)}, `
    + `output ${formatReadableTokens(summary.outputTokens)}.`;
  if (rate?.tokensPerSecond !== null && rate?.tokensPerSecond !== undefined) {
    ariaLabel = `Rate: ${rate.tokensPerSecond.toFixed(1)} tokens/s. ${ariaLabel}`;
  }

  return {
    label,
    rateLabel,
    ariaLabel,
    tooltip: tooltipLines.join('\n'),
  };
}

export interface TokenPricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface SessionCostIndicatorState {
  label: string;
  ariaLabel: string;
  tooltip: string;
}

type PruningCostDetails = PruningDetails & {
  prepassInputTokens?: number;
  prepassOutputTokens?: number;
  prepassCacheReadTokens?: number;
  prepassCacheWriteTokens?: number;
};

const costFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function formatCostDetail(cost: number): string {
  return `$${Math.max(0, cost).toFixed(4)}`;
}

export function formatCostUsd(cost: number): string {
  if (!Number.isFinite(cost) || cost <= 0) return '$0.00';
  if (cost < 0.01) return '<$0.01';
  return costFormatter.format(cost);
}

function costFromUsage(usage: SessionTokenUsageSummary, pricing: TokenPricing): number {
  return ((usage.inputTokens / 1_000_000) * pricing.input)
    + ((usage.outputTokens / 1_000_000) * pricing.output)
    + ((usage.cacheReadTokens / 1_000_000) * pricing.cacheRead)
    + ((usage.cacheWriteTokens / 1_000_000) * pricing.cacheWrite);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function toolCallsFromMessage(message: ChatMessage): ToolCall[] {
  if (message.toolCalls?.length) return message.toolCalls;
  return message.parts
    ?.filter((part) => part.kind === 'toolCall')
    .map((part) => part.toolCall) ?? [];
}

function extractSubagentDirectCost(transcript: ChatMessage[]): number {
  let cost = 0;
  for (const message of transcript) {
    if (message.role !== 'assistant') continue;
    for (const toolCall of toolCallsFromMessage(message)) {
      if (toolCall.name.trim().toLowerCase() !== 'subagent' || toolCall.status === 'failed') continue;
      if (!isRecord(toolCall.result) || !isRecord(toolCall.result.details) || !Array.isArray(toolCall.result.details.results)) continue;
      for (const result of toolCall.result.details.results) {
        if (!isRecord(result) || !isRecord(result.usage)) continue;
        cost += numberValue(result.usage.cost);
      }
    }
  }
  return cost;
}

function buildPruningPrepassSummary(details: PruningCostDetails | undefined, pricing: TokenPricing | undefined): { cost: number; lines: string[] } {
  if (!details?.prepassModel) return { cost: 0, lines: [] };
  const inputTokens = numberValue(details.prepassInputTokens);
  const outputTokens = numberValue(details.prepassOutputTokens);
  const cacheReadTokens = numberValue(details.prepassCacheReadTokens);
  const cacheWriteTokens = numberValue(details.prepassCacheWriteTokens);
  const hasUsage = inputTokens > 0 || outputTokens > 0 || cacheReadTokens > 0 || cacheWriteTokens > 0;
  if (!hasUsage) {
    return { cost: 0, lines: ['Pruning prepass:', `  Model: ${details.prepassModel}`] };
  }

  const cost = pricing
    ? ((inputTokens / 1_000_000) * pricing.input)
      + ((outputTokens / 1_000_000) * pricing.output)
      + ((cacheReadTokens / 1_000_000) * pricing.cacheRead)
      + ((cacheWriteTokens / 1_000_000) * pricing.cacheWrite)
    : 0;

  return {
    cost,
    lines: [
      'Pruning prepass:',
      `  Model: ${details.prepassModel}`,
      `  Tokens: \u2191 ${formatReadableTokens(inputTokens)} \u2193 ${formatReadableTokens(outputTokens)}`,
      ...(pricing ? [`  Cost: ${formatCostDetail(cost)}`] : []),
    ],
  };
}

export function buildSessionCostIndicator(
  summary: SessionTokenUsageSummary,
  pricing: TokenPricing | undefined,
  modelName: string | undefined,
  transcript: ChatMessage[],
  pruningDetails: PruningCostDetails | undefined,
): SessionCostIndicatorState | null {
  if (summary.reportedTurnCount === 0) return null;

  const labelModel = modelName ?? 'Selected model';
  const subagentCost = extractSubagentDirectCost(transcript);
  const prepass = buildPruningPrepassSummary(pruningDetails, pricing);

  if (!pricing) {
    return {
      label: '$0.00',
      ariaLabel: `Session cost unavailable: ${formatReadableTokens(summary.totalTokens)} tokens reported without pricing.`,
      tooltip: [
        `${labelModel}`,
        `${formatReadableTokens(summary.totalTokens)} tokens (no pricing)`,
        ...(subagentCost > 0 ? ['', 'Sub-agents:', `  Direct cost: ${formatCostDetail(subagentCost)}`] : []),
        ...(prepass.lines.length > 0 ? ['', ...prepass.lines] : []),
      ].join('\n'),
    };
  }

  const mainCost = costFromUsage(summary, pricing);
  const totalCost = mainCost + subagentCost + prepass.cost;
  const tooltipLines = [
    `${labelModel}`,
    `Subtotal: ${formatCostDetail(mainCost)}`,
    `  Input:  ${formatCostDetail((summary.inputTokens / 1_000_000) * pricing.input)}`,
    `  Output: ${formatCostDetail((summary.outputTokens / 1_000_000) * pricing.output)}`,
  ];

  if (summary.cacheReadTokens > 0 || summary.cacheWriteTokens > 0) {
    tooltipLines.push(
      `  Cache read:  ${formatCostDetail((summary.cacheReadTokens / 1_000_000) * pricing.cacheRead)}`,
      `  Cache write: ${formatCostDetail((summary.cacheWriteTokens / 1_000_000) * pricing.cacheWrite)}`,
    );
  }

  if (subagentCost > 0) {
    tooltipLines.push('', 'Sub-agents:', `  Direct cost: ${formatCostDetail(subagentCost)}`);
  }

  if (prepass.lines.length > 0) {
    tooltipLines.push('', ...prepass.lines);
  }

  tooltipLines.push(`Total: ${formatCostDetail(totalCost)}`);

  return {
    label: formatCostUsd(totalCost),
    ariaLabel: `Estimated session cost ${formatCostUsd(totalCost)}.`,
    tooltip: tooltipLines.join('\n'),
  };
}
