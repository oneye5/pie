import assert from 'node:assert/strict';
import * as path from 'node:path';
import test from 'node:test';

import { buildDuckDbDatabase, runNamedDuckDbQuery } from '../scripts/duckdb.ts';
import { prepareSourceAnalytics } from '../scripts/prepare.ts';
import { loadFixture, withTempDir } from './helpers.ts';

test('DuckDB build and named queries work against the fixture', async () => {
  await withTempDir(async (dir) => {
    const prepared = prepareSourceAnalytics(await loadFixture());
    const dbPath = path.join(dir, 'usage.duckdb');
    const exportsDir = path.join(dir, 'exports');

    await buildDuckDbDatabase({ dbPath, exportsDir, prepared });

    const modelQualityRows = await runNamedDuckDbQuery(dbPath, 'model_quality');
    const toolUsageRows = await runNamedDuckDbQuery(dbPath, 'tool_usage');
    const toolFailureRows = await runNamedDuckDbQuery(dbPath, 'tool_failures');
    const timelineRows = await runNamedDuckDbQuery(dbPath, 'timeline');

    assert.ok(modelQualityRows.length >= 3);
    assert.ok(toolUsageRows.some((row) => row['tool_name'] === 'bash'));
    assert.ok(Array.isArray(toolFailureRows));
    assert.ok(timelineRows.some((row) => row['bucket_start'] === '2026-05-10'));
  });
});

test('cost columns are surfaced in core_runs, model_quality, and timeline', async () => {
  await withTempDir(async (dir) => {
    const prepared = prepareSourceAnalytics(await loadFixture());
    const dbPath = path.join(dir, 'usage.duckdb');
    const exportsDir = path.join(dir, 'exports');

    await buildDuckDbDatabase({ dbPath, exportsDir, prepared });

    const coreRunsRows = await runNamedDuckDbQuery(dbPath, 'core_runs');
    assert.ok(coreRunsRows.length > 0);
    assert.ok(coreRunsRows.every((row) => 'estimated_cost_usd' in row), 'core_runs must expose estimated_cost_usd');
    assert.ok(coreRunsRows.some((row) => row['estimated_cost_usd'] != null), 'at least one priced run');

    const modelQualityRows2 = await runNamedDuckDbQuery(dbPath, 'model_quality');
    assert.ok(
      modelQualityRows2.every((row) => 'average_estimated_cost_usd' in row && 'total_estimated_cost_usd' in row && 'priced_run_count' in row),
      'model_quality must expose cost columns',
    );
    assert.ok(modelQualityRows2.some((row) => row['average_estimated_cost_usd'] != null), 'at least one priced model cell');

    const timelineRows2 = await runNamedDuckDbQuery(dbPath, 'timeline');
    assert.ok(
      timelineRows2.every((row) => 'total_estimated_cost_usd' in row && 'priced_run_count' in row),
      'timeline must expose cost columns',
    );
  });
});
