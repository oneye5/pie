import type { SystemPromptEntry } from '../../shared/protocol';

const compactTokenFormatter = new Intl.NumberFormat(undefined, {
  notation: 'compact',
  maximumFractionDigits: 1,
});

export function estimateTextTokens(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) {
    return 0;
  }

  // Mirror the PI SDK's chars/4 heuristic used for context token estimates.
  return Math.ceil(trimmed.length / 4);
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