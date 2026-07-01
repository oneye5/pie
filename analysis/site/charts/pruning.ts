import type { ChartEntry, ChartContext } from '../lib.ts';
import { CHART_COLORS, categoricalHeight, median, selectedRunIds, sum } from '../lib.ts';
import type { PreparedPruningEventRow, PreparedPruningSignalRow } from '../../scripts/contracts.ts';

function filteredPruning(ctx: ChartContext): PreparedPruningEventRow[] {
  const runIds = selectedRunIds(ctx.runs);
  return ctx.pruning.rows.filter((r) => runIds.has(r.runId));
}

function filteredPruningSignals(ctx: ChartContext): PreparedPruningSignalRow[] {
  const runIds = selectedRunIds(ctx.runs);
  return ctx.pruning.signalRows.filter((r) => runIds.has(r.runId));
}

function tokensSavedTrend(rows: PreparedPruningEventRow[]) {
  const map = new Map<string, { tokens: number; events: number }>();
  for (const r of rows) {
    const e = map.get(r.startedDay) ?? { tokens: 0, events: 0 };
    e.tokens += r.skillTokensSaved + r.toolTokensSaved;
    e.events += 1;
    map.set(r.startedDay, e);
  }
  return [...map.entries()]
    .map(([day, e]) => ({ day, tokensSaved: e.tokens, events: e.events }))
    .sort((a, b) => a.day.localeCompare(b.day));
}

function topPrunedNames(rows: PreparedPruningEventRow[], field: 'prunedSkillNames' | 'prunedToolNames', limit: number) {
  const counts = new Map<string, number>();
  for (const r of rows) {
    for (const name of r[field]) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

export const pruningCharts: ChartEntry[] = [
  {
    id: 'chart-pruning-tokens-trend',
    render: async (ctx: ChartContext) => {
      const rows = filteredPruning(ctx);
      const trend = tokensSavedTrend(rows);
      const totalSaved = sum(trend.map((r) => r.tokensSaved));
      ctx.setNote('pruning-tokens-trend-note', `Daily tokens saved by the skill/tool pruner; ${trend.length} days, ${Math.round(totalSaved).toLocaleString()} tokens total.`, ctx.renderToken);
      const spec = trend.length === 0 ? null : {
        width: 'container',
        height: 200,
        data: { values: trend },
        layer: [
          {
            mark: { type: 'area' as const, opacity: 0.2 },
            encoding: {
              x: { field: 'day', type: 'temporal' as const, timeUnit: 'yearmonthdate', title: 'Day' },
              y: { field: 'tokensSaved', type: 'quantitative' as const, title: 'Tokens saved' },
              color: { value: CHART_COLORS.success },
            },
          },
          {
            mark: { type: 'line' as const, strokeWidth: 2, point: { size: 30, filled: true } },
            encoding: {
              x: { field: 'day', type: 'temporal' as const, timeUnit: 'yearmonthdate' },
              y: { field: 'tokensSaved', type: 'quantitative' as const },
              color: { value: CHART_COLORS.success },
              tooltip: [
                { field: 'day', type: 'temporal' as const, timeUnit: 'yearmonthdate', title: 'Day' },
                { field: 'tokensSaved', type: 'quantitative' as const, title: 'Tokens saved', format: ',' },
                { field: 'events', type: 'quantitative' as const, title: 'Pruning events' },
              ],
            },
          },
        ],
      };
      await ctx.renderSpec('chart-pruning-tokens-trend', spec, 'No pruning events match the current filters.', ctx.renderToken);
    },
  },
  {
    id: 'chart-pruning-latency',
    render: async (ctx: ChartContext) => {
      const rows = filteredPruning(ctx);
      const latencies = rows.map((r) => r.llmLatencyMs).filter((v) => Number.isFinite(v) && v > 0);
      const med = median(latencies);
      ctx.setNote('pruning-latency-note', `Pruner LLM latency distribution across ${latencies.length} events${med !== null ? `; median ${Math.round(med)} ms` : ''}.`, ctx.renderToken);
      const spec = latencies.length === 0 ? null : {
        width: 'container',
        height: 220,
        data: { values: latencies.map((ms) => ({ latency: ms })) },
        mark: { type: 'bar' as const, opacity: 0.8 },
        encoding: {
          x: { bin: { maxbins: 30 }, field: 'latency', type: 'quantitative' as const, title: 'Pruner LLM latency (ms)' },
          y: { aggregate: 'count' as const, type: 'quantitative' as const, title: 'Events' },
          color: { value: CHART_COLORS.accent2 },
        },
      };
      await ctx.renderSpec('chart-pruning-latency', spec, 'No pruning events with latency data match the current filters.', ctx.renderToken);
    },
  },
  {
    id: 'chart-pruning-top-skills',
    render: async (ctx: ChartContext) => {
      const rows = filteredPruning(ctx);
      const top = topPrunedNames(rows, 'prunedSkillNames', 15);
      ctx.setNote('pruning-top-skills-note', `Most frequently pruned skills (top ${top.length}).`, ctx.renderToken);
      const spec = top.length === 0 ? null : {
        width: 'container',
        height: categoricalHeight(top.length, 24),
        data: { values: top },
        mark: { type: 'bar' as const, cornerRadiusEnd: 3, opacity: 0.85 },
        encoding: {
          y: { field: 'name', type: 'nominal' as const, sort: top.map((r) => r.name), title: null, axis: { labelLimit: 300 } },
          x: { field: 'count', type: 'quantitative' as const, title: 'Times pruned' },
          color: { value: CHART_COLORS.gold },
          tooltip: [
            { field: 'name', type: 'nominal' as const, title: 'Skill' },
            { field: 'count', type: 'quantitative' as const, title: 'Times pruned' },
          ],
        },
      };
      await ctx.renderSpec('chart-pruning-top-skills', spec, 'No pruned skills match the current filters.', ctx.renderToken);
    },
  },
  {
    id: 'chart-pruning-top-tools',
    render: async (ctx: ChartContext) => {
      const rows = filteredPruning(ctx);
      const top = topPrunedNames(rows, 'prunedToolNames', 15);
      ctx.setNote('pruning-top-tools-note', `Most frequently pruned tools (top ${top.length}).`, ctx.renderToken);
      const spec = top.length === 0 ? null : {
        width: 'container',
        height: categoricalHeight(top.length, 24),
        data: { values: top },
        mark: { type: 'bar' as const, cornerRadiusEnd: 3, opacity: 0.85 },
        encoding: {
          y: { field: 'name', type: 'nominal' as const, sort: top.map((r) => r.name), title: null, axis: { labelLimit: 300 } },
          x: { field: 'count', type: 'quantitative' as const, title: 'Times pruned' },
          color: { value: CHART_COLORS.accent },
          tooltip: [
            { field: 'name', type: 'nominal' as const, title: 'Tool' },
            { field: 'count', type: 'quantitative' as const, title: 'Times pruned' },
          ],
        },
      };
      await ctx.renderSpec('chart-pruning-top-tools', spec, 'No pruned tools match the current filters.', ctx.renderToken);
    },
  },
  {
    id: 'chart-pruning-recovery-rate',
    render: async (ctx: ChartContext) => {
      const decisionRows = filteredPruning(ctx);
      const signals = filteredPruningSignals(ctx);
      let skillMiss = 0;
      let shadowMiss = 0;
      let toolRecovered = 0;
      let skillRead = 0;
      for (const s of signals) {
        if (s.event === 'skill_miss') skillMiss += 1;
        else if (s.event === 'shadow_miss_candidate') shadowMiss += 1;
        else if (s.event === 'tool_recovered') toolRecovered += 1;
        else if (s.event === 'skill_read') skillRead += 1;
      }
      // "Prunes that were recovered" rate = tool_recovered events / decisions that pruned >=1 tool.
      const decisionsThatPrunedTools = decisionRows.filter((r) => r.toolCountPruned >= 1).length;
      const recoveredRate = decisionsThatPrunedTools > 0 ? toolRecovered / decisionsThatPrunedTools : null;
      const missDenominator = skillRead + skillMiss + shadowMiss;
      const missRate = missDenominator > 0 ? (skillMiss + shadowMiss) / missDenominator : null;
      const rateText = recoveredRate === null ? 'n/a (no tool-pruning decisions)' : `${Math.round(recoveredRate * 100)}%`;
      const missRateText = missRate === null ? 'n/a (no skill reads)' : `${Math.round(missRate * 100)}%`;
      ctx.setNote(
        'pruning-recovery-rate-note',
        `Over-pruning signals: ${toolRecovered} tool recoveries across ${decisionsThatPrunedTools} tool-pruning decisions (recovered rate ${rateText}); ${skillMiss + shadowMiss} skill misses of ${missDenominator} skill reads (miss rate ${missRateText}).`,
        ctx.renderToken,
      );
      const recoveredRateValue = recoveredRate === null ? 0 : recoveredRate;
      const missRateValue = missRate === null ? 0 : missRate;
      const values = [
        {
          signal: 'Recovered rate',
          rate: recoveredRateValue,
          count: toolRecovered,
          denominator: decisionsThatPrunedTools,
        },
        {
          signal: 'Miss rate',
          rate: missRateValue,
          count: skillMiss + shadowMiss,
          denominator: missDenominator,
        },
      ];
      const signalDomain = ['Recovered rate', 'Miss rate'];
      const signalRange = [CHART_COLORS.accent, CHART_COLORS.coral];
      const spec = values.every((v) => v.count === 0) ? null : {
        width: 'container',
        height: categoricalHeight(values.length, 32),
        data: { values },
        mark: { type: 'bar' as const, cornerRadiusEnd: 3, opacity: 0.85 },
        encoding: {
          y: { field: 'signal', type: 'nominal' as const, sort: signalDomain, title: null, axis: { labelLimit: 300 } },
          x: {
            field: 'rate',
            type: 'quantitative' as const,
            title: 'Rate',
            // `recoveredRate` is a ratio (tool recoveries ÷ tool-pruning decisions),
            // not a proportion — one decision can recover multiple tools, so it
            // can exceed 1.0. Size the domain to the data so >100% bars don't clip.
            scale: { domain: [0, Math.max(1, recoveredRateValue, missRateValue)] },
            axis: { format: '.0%' },
          },
          color: { field: 'signal', type: 'nominal' as const, scale: { domain: signalDomain, range: signalRange }, legend: null },
          tooltip: [
            { field: 'signal', type: 'nominal' as const, title: 'Signal' },
            { field: 'rate', type: 'quantitative' as const, title: 'Rate', format: '.0%' },
            { field: 'count', type: 'quantitative' as const, title: 'Events' },
            { field: 'denominator', type: 'quantitative' as const, title: 'Denominator' },
          ],
        },
      };
      await ctx.renderSpec('chart-pruning-recovery-rate', spec, 'No over-pruning signals match the current filters.', ctx.renderToken);
    },
  },
];
