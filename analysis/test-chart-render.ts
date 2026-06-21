import { throughputCharts } from './site/charts/throughput.ts';
import type { ChartContext } from './site/lib.ts';
import type { PreparedTurnThroughputRow } from './scripts/contracts.ts';

const rows: PreparedTurnThroughputRow[] = [
  { runId: 'r1', endedAt: '2026-05-10T12:00:00Z', startedDay: '2026-05-10', modelId: 'm1', thinkingLevel: 'medium', experimentAssignment: null, outputTokens: 100, generationDurationMs: 1000, concurrentBusySessions: 1, status: 'completed', tokensPerSecond: 100 },
  { runId: 'r2', endedAt: '2026-05-10T12:01:00Z', startedDay: '2026-05-10', modelId: 'm1', thinkingLevel: 'medium', experimentAssignment: null, outputTokens: 200, generationDurationMs: 2000, concurrentBusySessions: 2, status: 'completed', tokensPerSecond: 100 },
  { runId: 'r3', endedAt: '2026-05-10T12:02:00Z', startedDay: '2026-05-10', modelId: 'm1', thinkingLevel: 'medium', experimentAssignment: null, outputTokens: 150, generationDurationMs: 2000, concurrentBusySessions: 3, status: 'completed', tokensPerSecond: 75 },
];

const ctx: Partial<ChartContext> = {
  runs: [{ runId: 'r1' }, { runId: 'r2' }, { runId: 'r3' }] as any,
  turnThroughputRows: rows,
  renderToken: 1,
  setNote: (id, text) => { console.log('note', id, text); },
  async renderSpec(id, spec) {
    console.log('renderSpec', id);
    if (spec && 'layer' in spec) {
      const lineLayer = (spec as any).layer[1];
      console.log('transform:', JSON.stringify(lineLayer?.transform));
    }
  },
};

await throughputCharts[2]!.render(ctx as ChartContext);
