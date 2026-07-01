import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test, { after } from 'node:test';

import { buildDuckDbDatabase, runNamedDuckDbQuery } from '../scripts/duckdb.ts';
import { prepareSourceAnalytics } from '../scripts/prepare.ts';
import { loadFixture } from './helpers.ts';

// Building the DuckDB database from the fixture dominates test time (~450ms).
// Build it ONCE at module load (top-level await) so the cost is paid during
// module setup rather than attributed to any test case, then run every named
// query against the shared database. (A `before()` hook would work functionally
// but `node:test` rolls hook time into the first test's reported duration.)
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-analysis-duckdb-test-'));
const sharedDbPath = path.join(tempDir, 'usage.duckdb');
const exportsDir = path.join(tempDir, 'exports');
await buildDuckDbDatabase({
  dbPath: sharedDbPath,
  exportsDir,
  prepared: prepareSourceAnalytics(await loadFixture()),
});

after(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

test('DuckDB build and named queries work against the fixture', async () => {
  const modelQualityRows = await runNamedDuckDbQuery(sharedDbPath, 'model_quality');
  const toolUsageRows = await runNamedDuckDbQuery(sharedDbPath, 'tool_usage');
  const toolFailureRows = await runNamedDuckDbQuery(sharedDbPath, 'tool_failures');
  const timelineRows = await runNamedDuckDbQuery(sharedDbPath, 'timeline');

  assert.ok(modelQualityRows.length >= 3);
  assert.ok(toolUsageRows.some((row) => row['tool_name'] === 'bash'));
  assert.ok(Array.isArray(toolFailureRows));
  assert.ok(timelineRows.some((row) => row['bucket_start'] === '2026-05-10'));
});

test('cost columns are surfaced in core_runs, model_quality, and timeline', async () => {
  const coreRunsRows = await runNamedDuckDbQuery(sharedDbPath, 'core_runs');
  assert.ok(coreRunsRows.length > 0);
  assert.ok(coreRunsRows.every((row) => 'estimated_cost_usd' in row), 'core_runs must expose estimated_cost_usd');
  assert.ok(coreRunsRows.some((row) => row['estimated_cost_usd'] != null), 'at least one priced run');

  const modelQualityRows2 = await runNamedDuckDbQuery(sharedDbPath, 'model_quality');
  assert.ok(
    modelQualityRows2.every((row) => 'average_estimated_cost_usd' in row && 'total_estimated_cost_usd' in row && 'priced_run_count' in row),
    'model_quality must expose cost columns',
  );
  assert.ok(modelQualityRows2.some((row) => row['average_estimated_cost_usd'] != null), 'at least one priced model cell');

  const timelineRows2 = await runNamedDuckDbQuery(sharedDbPath, 'timeline');
  assert.ok(
    timelineRows2.every((row) => 'total_estimated_cost_usd' in row && 'priced_run_count' in row),
    'timeline must expose cost columns',
  );
});

test('verification_impact buckets per-kind counts instead of the run total', async () => {
  const rows = await runNamedDuckDbQuery(sharedDbPath, 'verification_impact');
  assert.ok(rows.length > 0, 'verification_impact should return rows');

  // The fixture has at least one run with multiple verification kinds; the
  // SQL should bucket each kind by its own count, not the run's total bucket.
  const testRows = rows.filter((row) => row['verification_kind'] === 'test');
  const otherRows = rows.filter((row) => row['verification_kind'] === 'other');

  assert.ok(
    testRows.some((row) => row['count_bucket'] === '1' || row['count_bucket'] === '2-3' || row['count_bucket'] === '4+'),
    'test kind should carry a non-run-total bucket',
  );
  assert.ok(
    otherRows.some((row) => row['count_bucket'] === '1'),
    'other kind with a single count should be bucketed as 1',
  );
  assert.ok(
    rows.some((row) => row['verification_kind'] === 'none' && row['count_bucket'] === '0'),
    'none kind should map missing usage to bucket 0',
  );
});
