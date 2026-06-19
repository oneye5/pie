import type { ChartEntry, ChartContext } from '../lib.ts';
import {
  CHART_COLORS,
  average,
  categoricalHeight,
  median,
  percentile,
  selectedRunIds,
  sortNatural,
  uniqueNonEmpty,
} from '../lib.ts';
import type { PreparedTurnThroughputRow } from '../../scripts/contracts.ts';

/** Throughput rows belonging to the filtered run set, in chronological order. */
function relevantRows(ctx: ChartContext): PreparedTurnThroughputRow[] {
  const runIds = selectedRunIds(ctx.runs);
  return ctx.turnThroughputRows
    .filter((row) => runIds.has(row.runId) && row.tokensPerSecond !== null)
    .sort((a, b) => a.endedAt.localeCompare(b.endedAt));
}

/** Distinct model labels among the throughput rows, sorted for a stable legend. */
function modelDomain(rows: PreparedTurnThroughputRow[]): string[] {
  return sortNatural(uniqueNonEmpty(rows.map((row) => row.modelId)));
}

/**
 * Single-session inference speed: one point per assistant turn, plotted as
 * tokens/sec over time and colored by model. Higher = faster raw generation
 * (tool-execution time is excluded from the denominator).
 */
function throughputOverTimeSpec(rows: PreparedTurnThroughputRow[], models: string[]) {
  return {
    width: 'container',
    height: 260,
    data: { values: rows },
    mark: { type: 'circle' as const, filled: true, opacity: 0.6, size: 45 },
    encoding: {
      x: { field: 'endedAt', type: 'temporal' as const, timeUnit: 'yearmonthdatehoursminutes', title: 'Turn ended' },
      y: { field: 'tokensPerSecond', type: 'quantitative' as const, title: 'Throughput (tokens / sec)', scale: { zero: true, nice: true } },
      color: {
        field: 'modelId',
        type: 'nominal' as const,
        title: 'Model',
        sort: models,
        scale: { range: [CHART_COLORS.accent, CHART_COLORS.coral, CHART_COLORS.accent2, CHART_COLORS.gold, CHART_COLORS.success] },
        legend: { orient: 'bottom' as const },
      },
      tooltip: [
        { field: 'modelId', type: 'nominal' as const, title: 'Model' },
        { field: 'tokensPerSecond', type: 'quantitative' as const, title: 'Throughput', format: '.1f' },
        { field: 'outputTokens', type: 'quantitative' as const, title: 'Output tokens' },
        { field: 'generationDurationMs', type: 'quantitative' as const, title: 'Gen time (ms)' },
        { field: 'concurrentBusySessions', type: 'quantitative' as const, title: 'Concurrent sessions' },
        { field: 'endedAt', type: 'temporal' as const, title: 'Ended' },
      ],
    },
  };
}

/** Median (and p90) throughput by model — a ranking of single-session speed. */
function throughputByModelSpec(rows: PreparedTurnThroughputRow[]) {
  const byModel = new Map<string, number[]>();
  for (const row of rows) {
    const model = row.modelId?.trim() || '(unknown)';
    const entry = byModel.get(model) ?? [];
    entry.push(row.tokensPerSecond!);
    byModel.set(model, entry);
  }
  const table = [...byModel.entries()]
    .map(([model, values]) => ({
      model,
      median: Math.round((median(values) ?? 0) * 10) / 10,
      p90: Math.round((percentile(values, 90) ?? 0) * 10) / 10,
      turnCount: values.length,
    }))
    .filter((entry) => entry.turnCount >= 2)
    .sort((a, b) => b.median - a.median)
    .slice(0, 14);

  return {
    table,
    spec: {
      width: 'container',
      height: categoricalHeight(table.length),
      data: { values: table },
      layer: [
        {
          mark: { type: 'bar' as const, cornerRadiusEnd: 3, opacity: 0.85 },
          encoding: {
            y: { field: 'model', type: 'nominal' as const, sort: table.map((r) => r.model), title: null, axis: { labelLimit: 260 } },
            x: { field: 'median', type: 'quantitative' as const, title: 'Throughput (tokens / sec, median)', axis: { format: '.0f' } },
            color: { value: CHART_COLORS.accent },
            tooltip: [
              { field: 'model', type: 'nominal' as const, title: 'Model' },
              { field: 'median', type: 'quantitative' as const, title: 'Median', format: '.1f' },
              { field: 'p90', type: 'quantitative' as const, title: 'p90', format: '.1f' },
              { field: 'turnCount', type: 'quantitative' as const, title: 'Turns' },
            ],
          },
        },
        {
          mark: { type: 'tick' as const, color: CHART_COLORS.text, thickness: 1.5, opacity: 0.6 },
          encoding: {
            y: { field: 'model', type: 'nominal' as const, sort: table.map((r) => r.model), title: null, axis: null },
            x: { field: 'p90', type: 'quantitative' as const },
            tooltip: [{ field: 'p90', type: 'quantitative' as const, title: 'p90', format: '.1f' }],
          },
        },
      ],
    },
  };
}

/**
 * Multi-session resilience: throughput vs concurrent busy sessions. Downward
 * slope as concurrency rises signals provider rate-limiting under load; models
 * that hold throughput are better for parallel multi-session work.
 */
function throughputVsConcurrencySpec(rows: PreparedTurnThroughputRow[], models: string[]) {
  const hasMultipleConcurrencyLevels = new Set(rows.map((r) => r.concurrentBusySessions)).size > 1;
  return {
    width: 'container',
    height: 260,
    data: { values: rows },
    layer: [
      {
        mark: { type: 'circle' as const, filled: true, opacity: 0.5, size: 50 },
        encoding: {
          x: { field: 'concurrentBusySessions', type: 'quantitative' as const, title: 'Concurrent busy sessions', scale: { zero: true, nice: true } },
          y: { field: 'tokensPerSecond', type: 'quantitative' as const, title: 'Throughput (tokens / sec)', scale: { zero: true, nice: true } },
          color: {
            field: 'modelId',
            type: 'nominal' as const,
            title: 'Model',
            sort: models,
            scale: { range: [CHART_COLORS.accent, CHART_COLORS.coral, CHART_COLORS.accent2, CHART_COLORS.gold, CHART_COLORS.success] },
            legend: { orient: 'bottom' as const },
          },
          tooltip: [
            { field: 'modelId', type: 'nominal' as const, title: 'Model' },
            { field: 'concurrentBusySessions', type: 'quantitative' as const, title: 'Concurrent sessions' },
            { field: 'tokensPerSecond', type: 'quantitative' as const, title: 'Throughput', format: '.1f' },
          ],
        },
      },
      // Per-model loess trend through the cloud, only meaningful when concurrency varies.
      ...(hasMultipleConcurrencyLevels ? [{
        transform: [
          { loess: 'tokensPerSecond', on: 'concurrentBusySessions', groupby: ['modelId'] },
        ],
        mark: { type: 'line' as const, strokeWidth: 2, opacity: 0.6, point: false },
        encoding: {
          x: { field: 'concurrentBusySessions', type: 'quantitative' as const },
          y: { field: 'tokensPerSecond', type: 'quantitative' as const },
          color: {
            field: 'modelId',
            type: 'nominal' as const,
            sort: models,
            scale: { range: [CHART_COLORS.accent, CHART_COLORS.coral, CHART_COLORS.accent2, CHART_COLORS.gold, CHART_COLORS.success] },
          },
        },
      }] : []),
    ],
  };
}

export const throughputCharts: ChartEntry[] = [
  {
    id: 'chart-throughput-over-time',
    render: async (ctx: ChartContext) => {
      const rows = relevantRows(ctx);
      const models = modelDomain(rows);
      ctx.setNote(
        'throughput-over-time-note',
        `${rows.length} assistant turns; each point = output tokens ÷ generation time (tool execution excluded).`,
        ctx.renderToken,
      );
      const spec = rows.length === 0 ? null : throughputOverTimeSpec(rows, models);
      await ctx.renderSpec('chart-throughput-over-time', spec, 'No assistant turns with throughput data match the current filters.', ctx.renderToken);
    },
  },
  {
    id: 'chart-throughput-by-model',
    render: async (ctx: ChartContext) => {
      const rows = relevantRows(ctx);
      const { table, spec } = throughputByModelSpec(rows);
      ctx.setNote(
        'throughput-by-model-note',
        `Median throughput by model (≥2 turns); tick = p90. ${table.length} models shown.`,
        ctx.renderToken,
      );
      const finalSpec = table.length === 0 ? null : spec;
      await ctx.renderSpec('chart-throughput-by-model', finalSpec, 'No models with ≥2 throughput samples match the current filters.', ctx.renderToken);
    },
  },
  {
    id: 'chart-throughput-vs-concurrency',
    render: async (ctx: ChartContext) => {
      const rows = relevantRows(ctx);
      const models = modelDomain(rows);
      const meanConc = average(rows.map((r) => r.concurrentBusySessions));
      ctx.setNote(
        'throughput-vs-concurrency-note',
        `Throughput vs concurrent busy sessions (mean concurrency ${meanConc ?? 0}). Downward slope = rate-limiting under multi-session load.`,
        ctx.renderToken,
      );
      const spec = rows.length === 0 ? null : throughputVsConcurrencySpec(rows, models);
      await ctx.renderSpec('chart-throughput-vs-concurrency', spec, 'No throughput samples match the current filters.', ctx.renderToken);
    },
  },
];
