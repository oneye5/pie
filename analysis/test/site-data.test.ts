import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import test from 'node:test';

import { buildSiteDataBundle, readSiteDataBundle, validateSiteDataBundle, writeSiteData } from '../scripts/site-data.ts';
import { prepareSourceAnalytics } from '../scripts/prepare.ts';
import { deepClone, loadFixture, withTempDir } from './helpers.ts';

test('site data generation writes the expected files and passes validation', async () => {
  await withTempDir(async (dir) => {
    const fixture = await loadFixture();
    const prepared = prepareSourceAnalytics(fixture);
    const bundle = buildSiteDataBundle(prepared, new Date('2026-05-14T00:00:00.000Z'));
    validateSiteDataBundle(bundle);

    await writeSiteData(dir, bundle);

    const roundTrip = await readSiteDataBundle(dir);
    assert.equal(roundTrip.manifest.completedRunCount, 7);
    assert.equal(roundTrip.runSummary.rows.length, 8);
    assert.ok(roundTrip.verificationImpact.summaryRows.length > 0);
    assert.ok(roundTrip.toolUsage.summaryRows.length > 0);
  });
});

test('site data generation handles no-scored and open-only edge cases', async () => {
  const fixture = deepClone(await loadFixture());
  fixture.completedRuns.forEach((run) => {
    run.scored = false;
    delete (run as Partial<typeof run>).outcome;
  });
  fixture.outcomes = [];

  const bundle = buildSiteDataBundle(prepareSourceAnalytics(fixture));
  validateSiteDataBundle(bundle);
  assert.equal(bundle.overview.totalScoredRuns, 0);
  assert.equal(bundle.timeline.rows.length > 0, true);
});

test('unexpected files or nested directories in the site-data directory fail validation', async () => {
  await withTempDir(async (dir) => {
    const fixture = await loadFixture();
    const bundle = buildSiteDataBundle(prepareSourceAnalytics(fixture));
    await writeSiteData(dir, bundle);
    await fs.writeFile(path.join(dir, 'run-analytics.json'), JSON.stringify({ completedRuns: [] }), 'utf8');

    await assert.rejects(
      async () => await readSiteDataBundle(dir),
      /Unexpected JSON file found in site data directory: run-analytics.json/,
    );

    await fs.rm(path.join(dir, 'run-analytics.json'), { force: true });
    await fs.mkdir(path.join(dir, 'extra'), { recursive: true });
    await fs.writeFile(path.join(dir, 'extra', 'manifest.json'), '{}', 'utf8');

    await assert.rejects(
      async () => await readSiteDataBundle(dir),
      /Unexpected subdirectory found in site data directory: extra/,
    );
  });
});

test('site data generation tolerates unknown model ids and ignores unknown verification kinds', async () => {
  const fixture = deepClone(await loadFixture());
  delete (fixture.completedRuns[0] as Partial<typeof fixture.completedRuns[0]>).modelId;
  (fixture.completedRuns[0] as any).verification.countsByKind.unexpected = 99;

  const prepared = prepareSourceAnalytics(fixture);
  const bundle = buildSiteDataBundle(prepared);
  validateSiteDataBundle(bundle);

  assert.equal(bundle.runSummary.rows[0]?.modelId, null);
  assert.ok(bundle.modelQuality.rows.some((row) => row.modelId === '(unknown)'));
  assert.ok(!JSON.stringify(bundle).includes('unexpected'));
});

test('site data treatment comparison normalizes null hashes and sorts by run count then experiment', async () => {
  const prepared = deepClone(prepareSourceAnalytics(await loadFixture()));
  const completedRuns = prepared.runs.filter((run) => run.status !== 'open').slice(0, 4);

  Object.assign(completedRuns[0]!, {
    promptFamily: null,
    promptHashPrefix: null,
    toolSetHashPrefix: null,
    skillSetHashPrefix: null,
    experimentAssignment: 'exp-z',
    mixedTreatmentConfig: false,
  });
  Object.assign(completedRuns[1]!, {
    promptFamily: null,
    promptHashPrefix: null,
    toolSetHashPrefix: null,
    skillSetHashPrefix: null,
    experimentAssignment: 'exp-z',
    mixedTreatmentConfig: false,
  });
  Object.assign(completedRuns[2]!, {
    promptFamily: 'family-a',
    promptHashPrefix: null,
    toolSetHashPrefix: null,
    skillSetHashPrefix: null,
    experimentAssignment: 'exp-b',
    mixedTreatmentConfig: false,
  });
  Object.assign(completedRuns[3]!, {
    promptFamily: 'family-a',
    promptHashPrefix: null,
    toolSetHashPrefix: null,
    skillSetHashPrefix: null,
    experimentAssignment: 'exp-a',
    mixedTreatmentConfig: false,
  });

  prepared.runs = completedRuns;
  prepared.toolUsage = [];
  prepared.toolFailures = [];
  prepared.verificationUsage = [];
  prepared.backendErrors = [];
  prepared.fileExtensions = [];

  const bundle = buildSiteDataBundle(prepared);
  const rows = bundle.treatmentComparison.rows;

  assert.equal(rows.length, 3);
  assert.equal(rows[0]?.runCount, 2);
  assert.equal(rows[0]?.promptFamily, '(none)');
  assert.equal(rows[0]?.toolSetHashPrefix, null);
  assert.equal(rows[0]?.skillSetHashPrefix, null);
  assert.deepEqual(
    rows.filter((row) => row.promptFamily === 'family-a').map((row) => row.experimentAssignment),
    ['exp-a', 'exp-b'],
  );
});

test('verification impact buckets per-kind counts, not run total', async () => {
  const prepared = deepClone(prepareSourceAnalytics(await loadFixture()));
  const completedRuns = prepared.runs.filter((run) => run.status !== 'open');
  const targetRun = completedRuns[0]!;

  prepared.verificationUsage = prepared.verificationUsage.filter((row) => row.runId !== targetRun.runId);
  prepared.verificationUsage.push(
    { runId: targetRun.runId, kind: 'test', count: 3, runHadAnyFailure: false, startedAt: targetRun.startedAt, startedDay: targetRun.startedDay, modelId: targetRun.modelId, thinkingLevel: targetRun.thinkingLevel, experimentAssignment: targetRun.experimentAssignment, mixedTreatmentConfig: targetRun.mixedTreatmentConfig, scored: targetRun.scored, satisfaction: targetRun.satisfaction, resolution: targetRun.resolution },
    { runId: targetRun.runId, kind: 'build', count: 1, runHadAnyFailure: false, startedAt: targetRun.startedAt, startedDay: targetRun.startedDay, modelId: targetRun.modelId, thinkingLevel: targetRun.thinkingLevel, experimentAssignment: targetRun.experimentAssignment, mixedTreatmentConfig: targetRun.mixedTreatmentConfig, scored: targetRun.scored, satisfaction: targetRun.satisfaction, resolution: targetRun.resolution },
  );

  const bundle = buildSiteDataBundle(prepared);
  validateSiteDataBundle(bundle);

  const testRows = bundle.verificationImpact.rows.filter((row) => row.verificationKind === 'test');
  const buildRows = bundle.verificationImpact.rows.filter((row) => row.verificationKind === 'build');

  assert.ok(testRows.some((row) => row.countBucket === '2-3'), 'test kind should be bucketed by its own count of 3');
  assert.ok(buildRows.some((row) => row.countBucket === '1'), 'build kind should be bucketed by its own count of 1');
  assert.ok(!testRows.some((row) => row.countBucket === '4+'), 'test kind should not inherit the run-total bucket of 4');
  assert.ok(!buildRows.some((row) => row.countBucket === '4+'), 'build kind should not inherit the run-total bucket of 4');
});

test('site data validation rejects malformed tool usage payloads', async () => {
  const fixture = await loadFixture();
  const bundle = buildSiteDataBundle(prepareSourceAnalytics(fixture));

  const invalidSchema = deepClone(bundle) as any;
  invalidSchema.toolUsage.schemaVersion = 999;
  assert.throws(
    () => validateSiteDataBundle(invalidSchema),
    /tool-usage.json has an unexpected schemaVersion/,
  );

  const missingToolName = deepClone(bundle) as any;
  missingToolName.toolUsage.rows = [{ callCount: 1, runId: 'run-x' }];
  missingToolName.toolUsage.summaryRows = [];
  assert.throws(
    () => validateSiteDataBundle(missingToolName),
    /tool-usage.json row 0 is missing toolName/,
  );

  const missingRows = deepClone(bundle) as any;
  delete missingRows.toolUsage.rows;
  assert.throws(
    () => validateSiteDataBundle(missingRows),
    /tool-usage.json is missing rows/,
  );

  const nonObjectRow = deepClone(bundle) as any;
  nonObjectRow.toolUsage.rows = [null];
  assert.throws(
    () => validateSiteDataBundle(nonObjectRow),
    /tool-usage.json row 0 must be an object/,
  );

  const invalidCallCount = deepClone(bundle) as any;
  invalidCallCount.toolUsage.rows = [{ toolName: 'bash', callCount: -1, runId: 'run-x' }];
  invalidCallCount.toolUsage.summaryRows = [];
  assert.throws(
    () => validateSiteDataBundle(invalidCallCount),
    /tool-usage.json row 0 has an invalid callCount/,
  );

  const missingRunId = deepClone(bundle) as any;
  missingRunId.toolUsage.rows = [{ toolName: 'bash', callCount: 1 }];
  missingRunId.toolUsage.summaryRows = [];
  assert.throws(
    () => validateSiteDataBundle(missingRunId),
    /tool-usage.json row 0 is missing runId/,
  );

  const missingSummaryRows = deepClone(bundle) as any;
  delete missingSummaryRows.toolUsage.summaryRows;
  assert.throws(
    () => validateSiteDataBundle(missingSummaryRows),
    /tool-usage.json is missing summaryRows/,
  );

  const nonObjectSummaryRow = deepClone(bundle) as any;
  nonObjectSummaryRow.toolUsage.summaryRows = [null];
  assert.throws(
    () => validateSiteDataBundle(nonObjectSummaryRow),
    /tool-usage.json summary row 0 must be an object/,
  );

  const invalidSummaryRow = deepClone(bundle) as any;
  invalidSummaryRow.toolUsage.summaryRows = [{ toolName: 'bash', callCount: 1 }];
  assert.throws(
    () => validateSiteDataBundle(invalidSummaryRow),
    /tool-usage.json summary row 0 has an invalid affectedRunCount/,
  );

  const missingSummaryToolName = deepClone(bundle) as any;
  missingSummaryToolName.toolUsage.summaryRows = [{ callCount: 1, affectedRunCount: 0 }];
  assert.throws(
    () => validateSiteDataBundle(missingSummaryToolName),
    /tool-usage.json summary row 0 is missing toolName/,
  );
});

test('writeSiteData rejects JSON targets and unexpected non-JSON files', async () => {
  await withTempDir(async (dir) => {
    const bundle = buildSiteDataBundle(prepareSourceAnalytics(await loadFixture()));
    const populatedDir = path.join(dir, 'site-data');
    await fs.mkdir(populatedDir, { recursive: true });
    await fs.writeFile(path.join(populatedDir, 'notes.txt'), 'unexpected', 'utf8');

    await assert.rejects(
      async () => await writeSiteData(populatedDir, bundle),
      /Unexpected non-JSON file found in site data directory: notes.txt/,
    );
    await assert.rejects(
      async () => await writeSiteData(path.join(dir, 'site-data.json'), bundle),
      /Site-data output must be a directory/,
    );
  });
});
