import type { AssistantUsage, ChatMessage } from '../../../shared/protocol';

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
  const compactIn = formatCompactTokens(summary.inputTokens);
  const compactOut = formatCompactTokens(summary.outputTokens);

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
