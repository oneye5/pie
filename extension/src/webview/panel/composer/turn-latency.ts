import type { ChatMessage } from '../../../shared/protocol';

/**
 * Turn-latency stats, surfaced as an **average** inside the generation-speed
 * (tokens/sec) chip's tooltip — the latency breakdown is no longer a separate
 * chip.
 *
 * Turn latency is the wall-clock gap from the previous tool call finishing (or
 * the prompt being sent, for the first turn) to the model's first reply token,
 * decomposed into our overhead vs the provider's. Each finished assistant
 * message carries the per-turn measurement (`turnLatencyMs` / `overheadMs` /
 * `providerLatencyMs`); here we average those across every measured turn in the
 * transcript so the speed chip's tooltip reports a stable typical latency
 * rather than the noisy single last turn.
 *
 * The average is session-wide (every measured turn in the transcript), not
 * per-run: latency is a historical statistic, and pooling all measured turns
 * yields a steadier number than the per-run sample (which may be just one or
 * two turns). The live generation rate on the same chip is per-run; the two
 * coexist in one tooltip.
 *
 * Measured entirely in the webview — STATE_CONTRACT.md § Webview-Local State
 * permits "derived UI telemetry" as ephemeral UI state, so the reducer stays
 * pure and no protocol changes are needed. The persisted per-turn breakdown
 * lives on `TurnThroughputSample` in the host analytics.
 */
export interface TurnLatencyStats {
  /** Number of finished assistant turns with a measured `turnLatencyMs`. */
  count: number;
  /** Mean `turnLatencyMs` across measured turns (ms). */
  avgTurnLatencyMs: number;
  /** Mean `overheadMs` across turns that measured it (ms); null if none did. */
  avgOverheadMs: number | null;
  /** Mean `providerLatencyMs` across turns that measured it (ms); null if none did. */
  avgProviderLatencyMs: number | null;
}

export const NO_LATENCY_STATS: TurnLatencyStats = {
  count: 0,
  avgTurnLatencyMs: 0,
  avgOverheadMs: null,
  avgProviderLatencyMs: null,
};

/** Format a millisecond duration as a short seconds label. */
function formatSeconds(ms: number): string {
  if (ms < 100) return '<0.1s';
  if (ms < 1000) return `${Math.round(ms / 100) / 10}s`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Collect measured (finished, non-streaming) assistant turns that carry a
 * `turnLatencyMs`. Streaming turns and turns recorded before tracking existed
 * (undefined latency) are excluded — a streaming turn's latency is not final
 * yet, and a turn without `turnLatencyMs` has nothing to average.
 */
export function collectMeasuredTurns(transcript: ChatMessage[]): ChatMessage[] {
  const measured: ChatMessage[] = [];
  for (const message of transcript) {
    if (message.role !== 'assistant') continue;
    if (message.status === 'streaming') continue;
    if (message.turnLatencyMs === undefined) continue;
    measured.push(message);
  }
  return measured;
}

/**
 * Average the per-turn latency breakdown across every measured turn in the
 * transcript. The total averages over all measured turns; the overhead and
 * provider components average only over turns that measured them (a turn can
 * have a total without a `turn_start`-anchored split), so the component means
 * need not sum to the total mean when some turns lack a component.
 */
export function computeTurnLatencyStats(transcript: ChatMessage[]): TurnLatencyStats {
  const turns = collectMeasuredTurns(transcript);
  if (turns.length === 0) return NO_LATENCY_STATS;
  let totalLatency = 0;
  let totalOverhead = 0;
  let totalProvider = 0;
  let overheadCount = 0;
  let providerCount = 0;
  for (const turn of turns) {
    totalLatency += turn.turnLatencyMs ?? 0;
    if (turn.overheadMs !== undefined) {
      totalOverhead += turn.overheadMs;
      overheadCount += 1;
    }
    if (turn.providerLatencyMs !== undefined) {
      totalProvider += turn.providerLatencyMs;
      providerCount += 1;
    }
  }
  return {
    count: turns.length,
    avgTurnLatencyMs: totalLatency / turns.length,
    avgOverheadMs: overheadCount > 0 ? totalOverhead / overheadCount : null,
    avgProviderLatencyMs: providerCount > 0 ? totalProvider / providerCount : null,
  };
}

/**
 * Format the average turn latency as tooltip lines for the speed chip. Returns
 * an empty array when no turns have been measured yet, so the speed tooltip
 * stays concise until latency data exists.
 */
export function formatTurnLatencyTooltipLines(stats: TurnLatencyStats): string[] {
  if (stats.count === 0) return [];
  const avg = formatSeconds(stats.avgTurnLatencyMs);
  const overhead = stats.avgOverheadMs !== null ? formatSeconds(stats.avgOverheadMs) : '—';
  const provider = stats.avgProviderLatencyMs !== null ? formatSeconds(stats.avgProviderLatencyMs) : '—';
  const turns = stats.count === 1 ? '1 turn' : `${stats.count} turns`;
  return [
    `Avg turn latency: ${avg} over ${turns}`,
    `  overhead: ${overhead} — inter-turn work before the provider request`,
    `  provider: ${provider} — request prep + network + time-to-first-token`,
  ];
}
