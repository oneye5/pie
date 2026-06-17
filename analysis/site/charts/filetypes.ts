import type { ChartEntry, ChartContext } from '../lib.ts';
import { CHART_COLORS, categoricalHeight, selectedRunIds } from '../lib.ts';

export const fileTypeCharts: ChartEntry[] = [
  {
    id: 'chart-file-type-activity',
    render: async (ctx: ChartContext) => {
      const runIds = selectedRunIds(ctx.runs);
      const map = new Map<string, { read: number; write: number; edit: number; runs: Set<string> }>();
      for (const row of ctx.fileExtensions.rows) {
        if (!runIds.has(row.runId)) {
          continue;
        }
        const e = map.get(row.extension) ?? { read: 0, write: 0, edit: 0, runs: new Set<string>() };
        e.read += row.readCount;
        e.write += row.writeCount;
        e.edit += row.editCount;
        e.runs.add(row.runId);
        map.set(row.extension, e);
      }
      const rows = [...map.entries()]
        .map(([extension, e]) => ({
          extension: extension || '(none)',
          read: e.read,
          write: e.write,
          edit: e.edit,
          total: e.read + e.write + e.edit,
          runs: e.runs.size,
        }))
        .sort((a, b) => b.total - a.total)
        .slice(0, 15);
      ctx.setNote('file-type-activity-note', `Read / write / edit counts by file extension (top ${rows.length}).`, ctx.renderToken);
      const spec = rows.length === 0 ? null : {
        width: 'container',
        height: categoricalHeight(rows.length, 26),
        data: { values: rows },
        mark: { type: 'bar' as const },
        encoding: {
          y: { field: 'extension', type: 'nominal' as const, sort: rows.map((r) => r.extension), title: null, axis: { labelLimit: 120 } },
          x: { field: 'count', type: 'quantitative' as const, title: 'Operations' },
          color: {
            field: 'op', type: 'nominal' as const, title: 'Operation',
            scale: { domain: ['read', 'edit', 'write'], range: [CHART_COLORS.accent, CHART_COLORS.gold, CHART_COLORS.coral] },
            legend: { orient: 'bottom' as const },
          },
          tooltip: [
            { field: 'extension', type: 'nominal' as const, title: 'Extension' },
            { field: 'op', type: 'nominal' as const, title: 'Operation' },
            { field: 'count', type: 'quantitative' as const, title: 'Count' },
            { field: 'runs', type: 'quantitative' as const, title: 'Runs' },
          ],
        },
        transform: [{ fold: ['read', 'edit', 'write'], as: ['op', 'count'] }],
      };
      await ctx.renderSpec('chart-file-type-activity', spec, 'No file-extension activity matches the current filters.', ctx.renderToken);
    },
  },
];
