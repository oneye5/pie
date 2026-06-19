import { useMemo } from 'preact/hooks';

import type { ChatMessage } from '../../../shared/protocol';

/**
 * Turn-latency indicator: the gap between the previous tool call finishing and
 * the model's first reply token, decomposed into our overhead vs the provider.
 *
 * Shows the most recent completed turn's measured breakdown (overhead /
 * provider / total), read from the finished assistant message's latency fields
 * (attached by the backend and stamped at the SDK's `turn_start` boundary).
 *
 *   overhead     = previous tool end → `turn_start`   (serial inter-turn work)
 *   provider     = `turn_start` → first reply token  (request prep + network + TTFT)
 *   turn latency = overhead + provider
 *
 * Measured entirely in the webview — STATE_CONTRACT.md § Webview-Local State
 * permits "derived UI telemetry" as ephemeral UI state, so the reducer stays
 * pure and no protocol changes are needed. The persisted per-turn breakdown
 * lives on `TurnThroughputSample` in the host analytics.
 */
export interface TurnLatencyIndicatorState {
  /** Compact label e.g. "↑ 1.2s"; empty string hides the chip. */
  label: string;
  ariaLabel: string;
  tooltip: string;
  /** 'last' (a completed turn's breakdown is shown) | 'idle' (no data yet). */
  state: 'last' | 'idle';
}

const IDLE_STATE: TurnLatencyIndicatorState = {
  label: '',
  ariaLabel: 'Turn latency: no data yet.',
  tooltip:
    'Turn latency — the time from the previous tool call finishing to the model replying — will appear here after the first tool call.',
  state: 'idle',
};

/** Format a millisecond duration as a short seconds label. */
function formatSeconds(ms: number): string {
  if (ms < 100) return '<0.1s';
  if (ms < 1000) return `${Math.round(ms / 100) / 10}s`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Find the most recent finished (non-streaming) assistant message that carries
 * a measured `turnLatencyMs`. Continuation segments overwrite the canonical
 * message's latency with the latest segment's value (see the `MessageFinished`
 * reducer), so this reflects the most recent reply gap.
 */
function findLastFinishedAssistantWithLatency(transcript: ChatMessage[]): ChatMessage | null {
  for (let i = transcript.length - 1; i >= 0; i -= 1) {
    const message = transcript[i];
    if (message.role !== 'assistant') continue;
    if (message.status === 'streaming') continue;
    if (message.turnLatencyMs !== undefined) return message;
  }
  return null;
}

export function buildTurnLatencyState(transcript: ChatMessage[]): TurnLatencyIndicatorState {
  const last = findLastFinishedAssistantWithLatency(transcript);
  if (!last || last.turnLatencyMs === undefined) {
    return IDLE_STATE;
  }
  const total = formatSeconds(last.turnLatencyMs);
  const overhead = last.overheadMs !== undefined ? formatSeconds(last.overheadMs) : '—';
  const provider = last.providerLatencyMs !== undefined ? formatSeconds(last.providerLatencyMs) : '—';
  return {
    label: `↑ ${total}`,
    ariaLabel: `Last turn latency: ${total}. Our overhead ${overhead}, provider ${provider}.`,
    tooltip: [
      `Last turn latency: ${total}`,
      `  our overhead: ${overhead} — inter-turn work before the provider request`,
      `  provider: ${provider} — request prep + network + time-to-first-token`,
      'Measured from the previous tool call finishing to the first reply token.',
    ].join('\n'),
    state: 'last',
  };
}

export function useTurnLatencyIndicator({ transcript }: { transcript: ChatMessage[] }): TurnLatencyIndicatorState {
  return useMemo(() => buildTurnLatencyState(transcript), [transcript]);
}
