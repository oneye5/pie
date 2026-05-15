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
