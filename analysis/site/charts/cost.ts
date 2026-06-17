import type { ChartEntry, ChartContext } from '../lib.ts';
import { CHART_COLORS, categoricalHeight, median, modelAxisLabel } from '../lib.ts';
import type { PreparedRunRow } from '../../scripts/contracts.ts';

interface CostByModelRow {
  model: string;
  totalCostUsd: number;
  medianCostUsd: number;
  runCount: number;
  withCostCount: number;
}

interface CostTrendRow {
  day: string;
  totalCostUsd: number;
  runCount: number;
}

function groupCostByModel(runs: PreparedRunRow[]): CostByModelRow[] {
  const map = new Map<string, { costs: number[]; runCount: number; withCost: number }>();
  for (const run of runs) {
    if (run.status === 'open') {
      continue;
    }
    const model = run.modelId?.trim() || '(unknown)';
    const entry = map.get(model) ?? { costs: [], runCount: 0, withCost: 0 };
    entry.runCount += 1;
    if (run.estimatedCostUsd !== null) {
      entry.costs.push(run.estimatedCostUsd);
      entry.withCost += 1;
    }
    map.set(model, entry);
  }
  return [...map.entries()]
    .map(([model, e]) => ({
      model,
      totalCostUsd: Math.round(e.costs.reduce((s, v) => s + v, 0) * 10000) / 10000,
      medianCostUsd: median(e.costs) ?? 0,
      runCount: e.runCount,
      withCostCount: e.withCost,
    }))
    .sort((a, b) => b.totalCostUsd - a.totalCostUsd)
    .slice(0, 12);
}

function costTrendRows(runs: PreparedRunRow[]): CostTrendRow[] {
  const map = new Map<string, { total: number; count: number }>();
  for (const run of runs) {
    if (run.status === 'open' || run.estimatedCostUsd === null) {
      continue;
    }
    const day = run.startedDay;
    const entry = map.get(day) ?? { total: 0, count: 0 };
    entry.total += run.estimatedCostUsd;
    entry.count += 1;
    map.set(day, entry);
  }
  return [...map.entries()]
    .map(([day, e]) => ({ day, totalCostUsd: Math.round(e.total * 10000) / 10000, runCount: e.count }))
    .sort((a, b) => a.day.localeCompare(b.day));
}

export const costCharts: ChartEntry[] = [
  {
    id: 'chart-cost-by-model',
    render: async (ctx: ChartContext) => {
      const rows = groupCostByModel(ctx.runs);
      const total = rows.reduce((s, r) => s + r.totalCostUsd, 0);
      ctx.setNote('cost-by-model-note', `Top ${rows.length} models by spend; ${rows.length === 0 ? 'no' : 'summarized'} cost data. Estimated via token usage × model pricing.`, ctx.renderToken);
      const spec = rows.length === 0 ? null : {
        width: 'container',
        height: categoricalHeight(rows.length),
        data: { values: rows },
        layer: [
          {
            mark: { type: 'bar' as const, cornerRadiusEnd: 3, opacity: 0.85 },
            encoding: {
              y: { field: 'model', type: 'nominal' as const, sort: rows.map((r) => r.model), title: null, axis: { labelLimit: 260 } },
              x: { field: 'totalCostUsd', type: 'quantitative' as const, title: 'Total estimated cost (USD)', axis: { format: '$.2f' } },
              color: { value: CHART_COLORS.gold },
              tooltip: [
                { field: 'model', type: 'nominal' as const, title: 'Model' },
                { field: 'totalCostUsd', type: 'quantitative' as const, title: 'Total cost', format: '$.2f' },
                { field: 'medianCostUsd', type: 'quantitative' as const, title: 'Median cost', format: '$.4f' },
                { field: 'withCostCount', type: 'quantitative' as const, title: 'Runs with pricing' },
                { field: 'runCount', type: 'quantitative' as const, title: 'Total runs' },
              ],
            },
          },
        ],
      };
      await ctx.renderSpec('chart-cost-by-model', spec, 'No completed runs with cost data match the current filters.', ctx.renderToken);
      if (rows.length > 0) {
        ctx.setNote('cost-by-model-note', `Top ${rows.length} models by spend; shown total $${Math.round(total * 100) / 100}. Estimated via token usage × model pricing.`, ctx.renderToken);
      }
    },
  },
  {
    id: 'chart-cost-trend',
    render: async (ctx: ChartContext) => {
      const rows = costTrendRows(ctx.runs);
      ctx.setNote('cost-trend-note', `Daily estimated spend across ${rows.length} active days.`, ctx.renderToken);
      const spec = rows.length === 0 ? null : {
        width: 'container',
        height: 200,
        data: { values: rows },
        layer: [
          {
            mark: { type: 'area' as const, opacity: 0.2 },
            encoding: {
              x: { field: 'day', type: 'temporal' as const, title: 'Day', timeUnit: 'yearmonthdate' },
              y: { field: 'totalCostUsd', type: 'quantitative' as const, title: 'Estimated cost (USD)' },
              color: { value: CHART_COLORS.gold },
            },
          },
          {
            mark: { type: 'line' as const, strokeWidth: 2 },
            encoding: {
              x: { field: 'day', type: 'temporal' as const, timeUnit: 'yearmonthdate' },
              y: { field: 'totalCostUsd', type: 'quantitative' as const },
              color: { value: CHART_COLORS.gold },
            },
          },
          {
            mark: { type: 'point' as const, filled: true, size: 40, opacity: 0.6 },
            encoding: {
              x: { field: 'day', type: 'temporal' as const, timeUnit: 'yearmonthdate' },
              y: { field: 'totalCostUsd', type: 'quantitative' as const },
              color: { value: CHART_COLORS.gold },
              tooltip: [
                { field: 'day', type: 'temporal' as const, title: 'Day', timeUnit: 'yearmonthdate' },
                { field: 'totalCostUsd', type: 'quantitative' as const, title: 'Cost', format: '$.2f' },
                { field: 'runCount', type: 'quantitative' as const, title: 'Runs' },
              ],
            },
          },
        ],
      };
      await ctx.renderSpec('chart-cost-trend', spec, 'No runs with cost data match the current filters.', ctx.renderToken);
    },
  },
  {
    id: 'chart-cost-vs-satisfaction',
    render: async (ctx: ChartContext) => {
      const points = ctx.runs
        .filter((r) => r.status !== 'open' && r.satisfaction !== null && r.estimatedCostUsd !== null && r.estimatedCostUsd > 0)
        .map((r) => ({ cost: r.estimatedCostUsd!, satisfaction: r.satisfaction!, model: r.modelId?.trim() || '(unknown)' }));
      ctx.setNote('cost-vs-satisfaction-note', `${points.length} scored runs with cost data; log-scaled cost axis.`, ctx.renderToken);
      const spec = points.length === 0 ? null : {
        width: 'container',
        height: 280,
        data: { values: points },
        mark: { type: 'circle' as const, filled: true, opacity: 0.55, size: 90 },
        encoding: {
          x: { field: 'cost', type: 'quantitative' as const, title: 'Estimated cost (USD, log)', scale: { type: 'log' }, axis: { format: '$.2f' } },
          y: { field: 'satisfaction', type: 'quantitative' as const, title: 'Satisfaction', scale: { domain: [1, 5] } },
          color: { field: 'model', type: 'nominal' as const, title: 'Model', scale: { range: [CHART_COLORS.accent, CHART_COLORS.coral, CHART_COLORS.success, CHART_COLORS.gold, CHART_COLORS.accent2] } },
          tooltip: [
            { field: 'model', type: 'nominal' as const, title: 'Model' },
            { field: 'cost', type: 'quantitative' as const, title: 'Cost', format: '$.4f' },
            { field: 'satisfaction', type: 'quantitative' as const, title: 'Satisfaction' },
          ],
        },
      };
      await ctx.renderSpec('chart-cost-vs-satisfaction', spec, 'No scored runs with cost data match the current filters.', ctx.renderToken);
    },
  },
  {
    id: 'chart-cost-by-outcome',
    render: async (ctx: ChartContext) => {
      const groups = new Map<string, number[]>();
      for (const run of ctx.runs) {
        if (run.status === 'open' || run.estimatedCostUsd === null || run.resolution === null) {
          continue;
        }
        const entry = groups.get(run.resolution) ?? [];
        entry.push(run.estimatedCostUsd);
        groups.set(run.resolution, entry);
      }
      const rows = [...groups.entries()].map(([resolution, costs]) => ({
        resolution,
        medianCostUsd: median(costs) ?? 0,
        meanCostUsd: costs.reduce((s, v) => s + v, 0) / costs.length,
        runCount: costs.length,
      }));
      ctx.setNote('cost-by-outcome-note', `Median cost per outcome across ${rows.reduce((s, r) => s + r.runCount, 0)} scored runs with cost data.`, ctx.renderToken);
      const spec = rows.length === 0 ? null : {
        width: 'container',
        height: 220,
        data: { values: rows },
        mark: { type: 'bar' as const, cornerRadiusEnd: 4, opacity: 0.85 },
        encoding: {
          x: { field: 'resolution', type: 'nominal' as const, title: 'Resolution', sort: ['resolved', 'partially_resolved', 'unresolved'] },
          y: { field: 'medianCostUsd', type: 'quantitative' as const, title: 'Median cost (USD)', axis: { format: '$.3f' } },
          color: {
            field: 'resolution', type: 'nominal' as const, title: 'Resolution',
            scale: { domain: ['resolved', 'partially_resolved', 'unresolved'], range: [CHART_COLORS.success, CHART_COLORS.gold, CHART_COLORS.coral] },
          },
          tooltip: [
            { field: 'resolution', type: 'nominal' as const, title: 'Resolution' },
            { field: 'medianCostUsd', type: 'quantitative' as const, title: 'Median cost', format: '$.4f' },
            { field: 'meanCostUsd', type: 'quantitative' as const, title: 'Mean cost', format: '$.4f' },
            { field: 'runCount', type: 'quantitative' as const, title: 'Runs' },
          ],
        },
      };
      await ctx.renderSpec('chart-cost-by-outcome', spec, 'No scored runs with cost data match the current filters.', ctx.renderToken);
    },
  },
];
