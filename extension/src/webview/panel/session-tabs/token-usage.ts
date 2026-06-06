import type { AssistantUsage, ChatMessage, ContextWindowUsage, PruningDetails, ToolCall } from '../../../shared/protocol';

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
  ariaLabel: string;
  /** Multi-line tooltip with totals + last turn + cache breakdown. */
  tooltip: string;
}

export function buildSessionTokenIndicator(
  summary: SessionTokenUsageSummary,
): SessionTokenIndicatorState {
  // Always show token indicator, even when no usage reported
  const compactIn = summary.reportedTurnCount > 0 ? formatCompactTokens(summary.inputTokens) : '\u2014';
  const compactOut = summary.reportedTurnCount > 0 ? formatCompactTokens(summary.outputTokens) : '\u2014';

  // Token counts label (always present)
  const label = `\u2191 ${compactIn} \u2193 ${compactOut}`;

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

  const ariaLabel =
    `Session token usage: input ${formatReadableTokens(summary.inputTokens)}, `
    + `output ${formatReadableTokens(summary.outputTokens)}.`;

  return {
    label,
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

export type TokenPricingResolver = (modelId: string) => TokenPricing | undefined;

interface CostUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
}

export interface LiveSessionCostEstimate extends CostUsage {
  source: 'live-context';
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

function formatCostTokens(tokens: number): string {
  return `${formatReadableTokens(tokens)} token${tokens === 1 ? '' : 's'}`;
}

export function formatCostUsd(cost: number): string {
  if (!Number.isFinite(cost) || cost <= 0) return '$0.00';
  if (cost < 0.01) return '<$0.01';
  return costFormatter.format(cost);
}

function costFromUsage(usage: CostUsage, pricing: TokenPricing): number {
  return ((usage.inputTokens / 1_000_000) * pricing.input)
    + ((usage.outputTokens / 1_000_000) * pricing.output)
    + ((usage.cacheReadTokens / 1_000_000) * pricing.cacheRead)
    + ((usage.cacheWriteTokens / 1_000_000) * pricing.cacheWrite);
}

function costBreakdownFromUsage(usage: CostUsage, pricing: TokenPricing) {
  const input = (usage.inputTokens / 1_000_000) * pricing.input;
  const output = (usage.outputTokens / 1_000_000) * pricing.output;
  const cacheRead = (usage.cacheReadTokens / 1_000_000) * pricing.cacheRead;
  const cacheWrite = (usage.cacheWriteTokens / 1_000_000) * pricing.cacheWrite;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total: input + output + cacheRead + cacheWrite,
  };
}

function estimateTextTokens(text: string): number {
  const trimmed = text.trim();
  return trimmed ? Math.ceil(trimmed.length / 4) : 0;
}

export function buildLiveSessionCostEstimate(
  transcript: ChatMessage[],
  contextUsage: ContextWindowUsage | null,
  busy: boolean,
): LiveSessionCostEstimate | null {
  if (!busy) return null;

  const inputTokens = typeof contextUsage?.tokens === 'number' && Number.isFinite(contextUsage.tokens)
    ? Math.max(0, Math.trunc(contextUsage.tokens))
    : 0;

  let outputTokens = 0;
  for (const message of transcript) {
    if (message.role !== 'assistant' || message.usage || message.status !== 'streaming') continue;
    outputTokens += estimateTextTokens(message.markdown);
    outputTokens += estimateTextTokens(message.thinking ?? '');
  }

  const totalTokens = inputTokens + outputTokens;
  if (totalTokens <= 0) return null;

  return {
    source: 'live-context',
    inputTokens,
    outputTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens,
  };
}

import { isRecord } from '../../../shared/type-guards';


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

function buildPruningPrepassSummary(
  details: PruningCostDetails | undefined,
  pricing: TokenPricing | undefined,
  pricingForModel?: TokenPricingResolver,
): { cost: number; lines: string[] } {
  if (!details?.prepassModel) return { cost: 0, lines: [] };
  const prepassPricing = pricingForModel?.(details.prepassModel) ?? pricing;
  const inputTokens = numberValue(details.prepassInputTokens);
  const outputTokens = numberValue(details.prepassOutputTokens);
  const cacheReadTokens = numberValue(details.prepassCacheReadTokens);
  const cacheWriteTokens = numberValue(details.prepassCacheWriteTokens);
  const hasUsage = inputTokens > 0 || outputTokens > 0 || cacheReadTokens > 0 || cacheWriteTokens > 0;
  if (!hasUsage) {
    return { cost: 0, lines: ['Pruning prepass:', `  Model: ${details.prepassModel}`] };
  }

  const cost = prepassPricing
    ? ((inputTokens / 1_000_000) * prepassPricing.input)
      + ((outputTokens / 1_000_000) * prepassPricing.output)
      + ((cacheReadTokens / 1_000_000) * prepassPricing.cacheRead)
      + ((cacheWriteTokens / 1_000_000) * prepassPricing.cacheWrite)
    : 0;

  return {
    cost,
    lines: [
      'Pruning prepass:',
      `  Model: ${details.prepassModel}`,
      `  Tokens: \u2191 ${formatReadableTokens(inputTokens)} \u2193 ${formatReadableTokens(outputTokens)}`,
      ...(prepassPricing ? [`  Cost: ${formatCostDetail(cost)}`] : []),
    ],
  };
}

interface CompletedCostSummary extends CostUsage {
  inputCost: number;
  outputCost: number;
  cacheReadCost: number;
  cacheWriteCost: number;
  totalCost: number;
  pricedTurnCount: number;
  modelIds: Set<string>;
}

function emptyCompletedCostSummary(): CompletedCostSummary {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    inputCost: 0,
    outputCost: 0,
    cacheReadCost: 0,
    cacheWriteCost: 0,
    totalCost: 0,
    pricedTurnCount: 0,
    modelIds: new Set<string>(),
  };
}

function addCompletedUsageCost(
  summary: CompletedCostSummary,
  usage: AssistantUsage,
  pricing: TokenPricing | undefined,
  modelId: string | undefined,
): void {
  summary.inputTokens += usage.inputTokens;
  summary.outputTokens += usage.outputTokens;
  summary.cacheReadTokens += usage.cacheReadTokens;
  summary.cacheWriteTokens += usage.cacheWriteTokens;
  summary.totalTokens += usage.totalTokens;
  if (modelId) summary.modelIds.add(modelId);
  if (!pricing) return;

  const costs = costBreakdownFromUsage(usage, pricing);
  summary.inputCost += costs.input;
  summary.outputCost += costs.output;
  summary.cacheReadCost += costs.cacheRead;
  summary.cacheWriteCost += costs.cacheWrite;
  summary.totalCost += costs.total;
  summary.pricedTurnCount += 1;
}

function buildCompletedCostSummary(
  usageSummary: SessionTokenUsageSummary,
  transcript: ChatMessage[],
  fallbackPricing: TokenPricing | undefined,
  pricingForModel: TokenPricingResolver | undefined,
): CompletedCostSummary {
  const completed = emptyCompletedCostSummary();
  let sawTranscriptUsage = false;

  for (const message of transcript) {
    if (message.role !== 'assistant' || !message.usage) continue;
    sawTranscriptUsage = true;
    const messagePricing = message.modelId ? pricingForModel?.(message.modelId) ?? fallbackPricing : fallbackPricing;
    addCompletedUsageCost(completed, message.usage, messagePricing, message.modelId);
  }

  if (sawTranscriptUsage || usageSummary.reportedTurnCount === 0) {
    return completed;
  }

  addCompletedUsageCost(completed, usageSummary, fallbackPricing, undefined);
  completed.pricedTurnCount = fallbackPricing ? usageSummary.reportedTurnCount : 0;
  return completed;
}

export function buildSessionCostIndicator(
  summary: SessionTokenUsageSummary,
  pricing: TokenPricing | undefined,
  modelName: string | undefined,
  transcript: ChatMessage[],
  pruningDetails: PruningCostDetails | undefined,
  pricingForModel?: TokenPricingResolver,
  liveEstimate?: LiveSessionCostEstimate | null,
): SessionCostIndicatorState | null {
  if (summary.reportedTurnCount === 0 && !liveEstimate) return null;

  const labelModel = modelName ?? 'Selected model';
  const subagentCost = extractSubagentDirectCost(transcript);
  const prepass = buildPruningPrepassSummary(pruningDetails, pricing, pricingForModel);
  const completed = buildCompletedCostSummary(summary, transcript, pricing, pricingForModel);
  const liveCost = pricing && liveEstimate ? costFromUsage(liveEstimate, pricing) : 0;

  if (!pricing) {
    return {
      label: '$0.00',
      ariaLabel: `Session cost unavailable: ${formatReadableTokens(summary.totalTokens)} tokens reported without pricing.`,
      tooltip: [
        `${labelModel}`,
        `${formatReadableTokens(summary.totalTokens)} tokens (no pricing)`,
        ...(liveEstimate ? ['', 'Live turn estimate:', `  Input:  ${formatCostTokens(liveEstimate.inputTokens)}`, `  Output: ${formatCostTokens(liveEstimate.outputTokens)}`] : []),
        ...(subagentCost > 0 ? ['', 'Sub-agents:', `  Direct cost: ${formatCostDetail(subagentCost)}`] : []),
        ...(prepass.lines.length > 0 ? ['', ...prepass.lines] : []),
      ].join('\n'),
    };
  }

  const mainCost = completed.totalCost;
  const totalCost = mainCost + liveCost + subagentCost + prepass.cost;
  const tooltipLines = [
    `${labelModel}`,
    `Completed subtotal: ${formatCostDetail(mainCost)}`,
    `  Input:  ${formatCostDetail(completed.inputCost)} (${formatCostTokens(completed.inputTokens)})`,
    `  Output: ${formatCostDetail(completed.outputCost)} (${formatCostTokens(completed.outputTokens)})`,
  ];

  if (completed.modelIds.size > 1) {
    tooltipLines.push(`  Models: ${Array.from(completed.modelIds).join(', ')}`);
  } else if (completed.modelIds.size === 1) {
    tooltipLines.push(`  Model id: ${Array.from(completed.modelIds)[0]}`);
  }

  if (completed.cacheReadTokens > 0 || completed.cacheWriteTokens > 0) {
    tooltipLines.push(
      `  Cache read:  ${formatCostDetail(completed.cacheReadCost)} (${formatCostTokens(completed.cacheReadTokens)})`,
      `  Cache write: ${formatCostDetail(completed.cacheWriteCost)} (${formatCostTokens(completed.cacheWriteTokens)})`,
    );
  }

  if (liveEstimate) {
    const liveCosts = costBreakdownFromUsage(liveEstimate, pricing);
    tooltipLines.push(
      '',
      `Live turn estimate: ${formatCostDetail(liveCost)}`,
      `  Input:  ${formatCostDetail(liveCosts.input)} (${formatCostTokens(liveEstimate.inputTokens)})`,
      `  Output: ${formatCostDetail(liveCosts.output)} (${formatCostTokens(liveEstimate.outputTokens)})`,
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
