import type { ChatMessage, ThinkingLevel } from '../../../shared/protocol';

const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
});

const tokenFormatter = new Intl.NumberFormat(undefined);

export interface AssistantReplyMeta {
  model: string | null;
  reasoning: string | null;
  compactText: string;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

export function roleLabel(role: ChatMessage['role']): string {
  if (role === 'user') return 'You';
  if (role === 'assistant') return 'PI';
  return 'System';
}

/**
 * Compact, human-readable summary of an assistant turn's token usage and
 * duration, intended for a hover tooltip (`title`) rather than visible text.
 * Returns null when there is nothing meaningful to show.
 */
export function formatAssistantMetaTooltip(message: ChatMessage): string | null {
  if (message.role !== 'assistant') return null;

  const lines: string[] = [];

  if (message.usage) {
    const { inputTokens, outputTokens, totalTokens, cacheReadTokens, cacheWriteTokens } = message.usage;
    const fmt = (n: number) => tokenFormatter.format(n);
    lines.push(`Tokens — in ${fmt(inputTokens)} · out ${fmt(outputTokens)} · total ${fmt(totalTokens)}`);
    if (cacheReadTokens > 0 || cacheWriteTokens > 0) {
      lines.push(`Cache — read ${fmt(cacheReadTokens)} · write ${fmt(cacheWriteTokens)}`);
    }
  }

  if (message.durationMs !== undefined) {
    lines.push(`Duration — ${formatDuration(message.durationMs)}`);
  }

  return lines.length > 0 ? lines.join('\n') : null;
}

export function formatThinkingLevelLabel(level: ThinkingLevel | undefined): string | null {
  switch (level) {
    case 'off':
      return 'off';
    case 'minimal':
      return 'minimal';
    case 'low':
      return 'low';
    case 'medium':
      return 'medium';
    case 'high':
      return 'high';
    case 'xhigh':
      return 'max';
    default:
      return null;
  }
}

export function assistantReplyMeta(message: ChatMessage): AssistantReplyMeta | null {
  if (message.role !== 'assistant') {
    return null;
  }

  const model = message.modelId?.trim() || null;
  const reasoning = formatThinkingLevelLabel(message.thinkingLevel);
  const compactText = [model, reasoning]
    .filter((value): value is string => Boolean(value))
    .join(' ');

  if (!compactText) {
    return null;
  }

  return {
    model,
    reasoning,
    compactText,
  };
}
