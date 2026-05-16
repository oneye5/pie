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
