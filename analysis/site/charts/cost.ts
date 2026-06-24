import type { ChartEntry, ChartContext } from '../lib.ts';
import { CHART_COLORS, categoricalHeight, median } from '../lib.ts';
import type { PreparedRunRow } from '../../scripts/contracts.ts';

export interface CostByModelRow {
  model: string;
  /** Sum of priced run costs for the model (equals the sum of per-session subtotals). */
  totalCostUsd: number;
  /** Median cost across priced runs. */
  medianCostUsdPerRun: number;
  /** Mean cost per session — each session's run costs are summed first, then averaged across sessions. */
  avgCostUsdPerSession: number;
  /** Median cost per session (same per-session rollup as `avgCostUsdPerSession`). */
  medianCostUsdPerSession: number;
  runCount: number;
  withCostCount: number;
  /** Distinct sessions with ≥1 priced run for this model. */
  sessionCount: number;
}

interface CostTrendRow {
  day: string;
  totalCostUsd: number;
  runCount: number;
}

/**
 * Per-model cost rollup. A *session* (one `sessionPathHash`) may contain
 * multiple runs, so "average spend per model per session" requires summing run
 * costs within each session first, then averaging across sessions — distinct
 * from the per-run mean/median. Models with no priced runs still appear (total
 * `$0` is meaningful for free/local models) but report `sessionCount: 0`.
 */
export function groupCostByModel(runs: PreparedRunRow[]): CostByModelRow[] {
  const perModel = new Map<string, {
    perRunCosts: number[];
    runCount: number;
    /** sessionPathHash → summed run cost for that session (priced runs only). */
    sessionSubtotals: Map<string, number>;
  }>();
  for (const run of runs) {
    if (run.status === 'open') {
      continue;
    }
    const model = run.modelId?.trim() || '(unknown)';
    const entry = perModel.get(model) ?? { perRunCosts: [], runCount: 0, sessionSubtotals: new Map<string, number>() };
    entry.runCount += 1;
    if (run.estimatedCostUsd !== null) {
      entry.perRunCosts.push(run.estimatedCostUsd);
      const prev = entry.sessionSubtotals.get(run.sessionPathHash) ?? 0;
      entry.sessionSubtotals.set(run.sessionPathHash, prev + run.estimatedCostUsd);
    }
    perModel.set(model, entry);
  }
  return [...perModel.entries()]
    .map(([model, e]) => {
      const subtotals = [...e.sessionSubtotals.values()];
      const total = subtotals.reduce((sum, v) => sum + v, 0);
      return {
        model,
        totalCostUsd: Math.round(total * 10000) / 10000,
        medianCostUsdPerRun: median(e.perRunCosts) ?? 0,
        avgCostUsdPerSession: subtotals.length === 0 ? 0 : Math.round((total / subtotals.length) * 10000) / 10000,
        medianCostUsdPerSession: median(subtotals) ?? 0,
        runCount: e.runCount,
        withCostCount: e.perRunCosts.length,
        sessionCount: subtotals.length,
      };
    })
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
                { field: 'avgCostUsdPerSession', type: 'quantitative' as const, title: 'Avg cost / session', format: '$.4f' },
                { field: 'medianCostUsdPerRun', type: 'quantitative' as const, title: 'Median cost / run', format: '$.4f' },
                { field: 'sessionCount', type: 'quantitative' as const, title: 'Priced sessions' },
                { field: 'withCostCount', type: 'quantitative' as const, title: 'Runs with pricing' },
                { field: 'runCount', type: 'quantitative' as const, title: 'Total runs' },
              ],
            },
          },
        ],
      };
      await ctx.renderSpec('chart-cost-by-model', spec, 'No completed runs with cost data match the current filters.', ctx.renderToken);
      if (rows.length > 0) {
        ctx.setNote('cost-by-model-note', `Top ${rows.length} models by spend; shown total $${Math.round(total * 100) / 100}. Avg spend per session in tooltip. Estimated via token usage × model pricing.`, ctx.renderToken);
      }
    },
  },
  {
    id: 'chart-cost-per-session-by-model',
    render: async (ctx: ChartContext) => {
      // Per-session average is only meaningful for models with ≥1 priced session;
      // a $0 bar would otherwise conflate "free model" with "no pricing".
      const rows = groupCostByModel(ctx.runs)
        .filter((r) => r.sessionCount > 0)
        .sort((a, b) => b.avgCostUsdPerSession - a.avgCostUsdPerSession);
      const sessionTotal = rows.reduce((s, r) => s + r.sessionCount, 0);
      ctx.setNote('cost-per-session-by-model-note', `Top ${rows.length} models by average spend per session; ${sessionTotal} priced sessions. A session rolls up all of its runs.`, ctx.renderToken);
      const spec = rows.length === 0 ? null : {
        width: 'container',
        height: categoricalHeight(rows.length),
        data: { values: rows },
        layer: [
          {
            mark: { type: 'bar' as const, cornerRadiusEnd: 3, opacity: 0.85 },
            encoding: {
              y: { field: 'model', type: 'nominal' as const, sort: rows.map((r) => r.model), title: null, axis: { labelLimit: 260 } },
              x: { field: 'avgCostUsdPerSession', type: 'quantitative' as const, title: 'Average estimated cost per session (USD)', axis: { format: '$.2f' } },
              color: { value: CHART_COLORS.gold },
              tooltip: [
                { field: 'model', type: 'nominal' as const, title: 'Model' },
                { field: 'avgCostUsdPerSession', type: 'quantitative' as const, title: 'Avg cost / session', format: '$.4f' },
                { field: 'medianCostUsdPerSession', type: 'quantitative' as const, title: 'Median cost / session', format: '$.4f' },
                { field: 'totalCostUsd', type: 'quantitative' as const, title: 'Total cost', format: '$.2f' },
                { field: 'sessionCount', type: 'quantitative' as const, title: 'Priced sessions' },
                { field: 'runCount', type: 'quantitative' as const, title: 'Total runs' },
              ],
            },
          },
        ],
      };
      await ctx.renderSpec('chart-cost-per-session-by-model', spec, 'No priced sessions match the current filters.', ctx.renderToken);
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
