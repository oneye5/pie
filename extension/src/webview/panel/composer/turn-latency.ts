// Turn-latency stats now live in `shared/turn-latency.ts` so the host-side
// token-rate measurement can reuse them. This file re-exports the shared API
// verbatim so existing webview importers (`hooks.ts`, the token-rate test) keep
// their `from './turn-latency'` / `'../src/webview/panel/composer/turn-latency'`
// imports unchanged.
export {
  collectMeasuredTurns,
  computeTurnLatencyStats,
  formatAvgTimeToFirstToken,
  formatTurnLatencyTooltipLines,
  NO_LATENCY_STATS,
} from '../../../shared/turn-latency';
export type { TurnLatencyStats } from '../../../shared/turn-latency';
