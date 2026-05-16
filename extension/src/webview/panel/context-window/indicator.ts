import type { ContextWindowSummary } from './breakdown';

const readableTokenFormatter = new Intl.NumberFormat('en-US');

export interface ContextWindowIndicatorState {
  label: string | null;
  ariaLabel: string;
  severity: '' | 'warning' | 'critical';
}

function trimDecimal(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, '');
}

function formatCompactTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${trimDecimal(tokens / 1_000_000)}M`;
  }
  if (tokens >= 1_000) {
    return `${trimDecimal(tokens / 1_000)}k`;
  }
  return String(tokens);
}

function formatReadableTokens(tokens: number): string {
  return readableTokenFormatter.format(tokens);
}

export function buildContextWindowIndicatorState(summary: ContextWindowSummary): ContextWindowIndicatorState {
  const { totalWindow, usedTokens, usedKind } = summary;
  if (totalWindow <= 0) {
    return {
      label: null,
      ariaLabel: '',
      severity: '',
    };
  }

  const usageRatio = usedTokens !== null ? usedTokens / totalWindow : null;
  const severity: ContextWindowIndicatorState['severity'] =
    usageRatio !== null && usageRatio > 0.85
      ? 'critical'
      : usageRatio !== null && usageRatio > 0.7
        ? 'warning'
        : '';

  if (usedTokens === null) {
    return {
      label: `? / ${formatCompactTokens(totalWindow)} tokens`,
      ariaLabel: `Context window usage is unknown. Total window: ${formatReadableTokens(totalWindow)} tokens.`,
      severity,
    };
  }

  const compactUsed = usedKind === 'estimated' && usedTokens > 0
    ? `~${formatCompactTokens(usedTokens)}`
    : formatCompactTokens(usedTokens);
  const ariaPrefix = usedKind === 'estimated' ? 'Estimated context window usage' : 'Context window usage';

  return {
    label: `${compactUsed} / ${formatCompactTokens(totalWindow)} tokens`,
    ariaLabel: `${ariaPrefix}: ${formatReadableTokens(usedTokens)} of ${formatReadableTokens(totalWindow)} tokens used.`,
    severity,
  };
}
