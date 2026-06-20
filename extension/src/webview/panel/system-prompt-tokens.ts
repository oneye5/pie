import type { SystemPromptEntry } from '../../shared/protocol';
import { countTextTokens } from '../../shared/tokenize';

const compactTokenFormatter = new Intl.NumberFormat(undefined, {
  notation: 'compact',
  maximumFractionDigits: 1,
});

export function estimateTextTokens(text: string): number {
  if (typeof text !== 'string') {
    return 0;
  }
  const trimmed = text.trim();
  if (!trimmed) {
    return 0;
  }

  // Real BPE count (cl100k_base); approximate for the active model but far
  // closer than the chars/4 heuristic. Exact attribution comes from provider
  // usage (see backend/context-usage.ts), so these rows stay "estimated".
  return countTextTokens(trimmed);
}

export function estimateSystemPromptTokens(prompts: readonly SystemPromptEntry[]): number {
  return prompts.reduce((total, prompt) => {
    if (prompt.availability !== 'available') {
      return total;
    }

    return total + estimateTextTokens(prompt.text);
  }, 0);
}

export function formatSystemPromptTokenLabel(tokenCount: number): string {
  const formatted = tokenCount >= 1000
    ? compactTokenFormatter.format(tokenCount)
    : tokenCount.toLocaleString();

  return `~${formatted} ${tokenCount === 1 ? 'token' : 'tokens'}`;
}

export function getSystemPromptTokenEstimateTitle(
  prompts: readonly SystemPromptEntry[],
): string {
  const hasUnavailablePrompt = prompts.some((prompt) => prompt.availability !== 'available');

  return hasUnavailablePrompt
    ? 'Estimated from available system prompt text only; hidden or unavailable prompt text is not included.'
    : 'Estimated from available system prompt text.';
}