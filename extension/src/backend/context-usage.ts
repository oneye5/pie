import type { ContextWindowUsage } from '../shared/protocol';
import type { SessionEntryLike } from './transcript';
import { usageFromMessage } from './transcript/content';

function normalizeContextWindow(contextWindow: number | undefined): number | undefined {
  if (typeof contextWindow !== 'number' || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return undefined;
  }
  return Math.trunc(contextWindow);
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(100, Math.max(0, value));
}

export function deriveFallbackContextUsageFromBranch(
  entries: SessionEntryLike[] | undefined,
  contextWindow: number | undefined,
): ContextWindowUsage | undefined {
  const normalizedContextWindow = normalizeContextWindow(contextWindow);
  if (!normalizedContextWindow || !entries || entries.length === 0) {
    return undefined;
  }

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type !== 'message' || entry.message?.role !== 'assistant') {
      continue;
    }

    const usage = usageFromMessage(entry.message);
    if (!usage) {
      continue;
    }

    const promptFootprint = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
    const tokens = promptFootprint > 0 ? promptFootprint : usage.totalTokens;
    const percent = clampPercent((tokens / normalizedContextWindow) * 100);

    return {
      tokens,
      contextWindow: normalizedContextWindow,
      percent,
    };
  }

  return undefined;
}
