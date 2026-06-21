import { compile } from 'vega-lite';
import { throughputVsConcurrencySpec } from './site/charts/throughput.ts';

const rows = [
  { runId: 'r1', endedAt: '2026-05-10T12:00:00Z', startedDay: '2026-05-10', modelId: 'm1', thinkingLevel: 'medium', experimentAssignment: null, outputTokens: 100, generationDurationMs: 1000, concurrentBusySessions: 1, status: 'completed', tokensPerSecond: 100 },
  { runId: 'r2', endedAt: '2026-05-10T12:01:00Z', startedDay: '2026-05-10', modelId: 'm1', thinkingLevel: 'medium', experimentAssignment: null, outputTokens: 200, generationDurationMs: 2000, concurrentBusySessions: 2, status: 'completed', tokensPerSecond: 100 },
] as const;

const spec = throughputVsConcurrencySpec(rows as any, ['m1']);
console.log(JSON.stringify(spec, null, 2));
try {
  compile(spec as any);
  console.log('compile ok');
} catch (e) {
  console.error('compile error:', (e as Error).message);
}
