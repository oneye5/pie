import type { ChatMessage, ThinkingLevel } from '../../../shared/protocol';

const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
});

export interface AssistantReplyMeta {
  model: string | null;
  reasoning: string | null;
  compactText: string;
}

export function formatTimestamp(value: string): string | null {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return timeFormatter.format(date);
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
