import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSiteDataBundle } from '../scripts/site-data.ts';
import { prepareSourceAnalytics } from '../scripts/prepare.ts';
import { validateSiteDataBundleNumericFields } from '../scripts/validate-site-data.ts';
import { deepClone, loadFixture } from './helpers.ts';

test('validateSiteDataBundleNumericFields accepts a valid bundle', async () => {
  const fixture = await loadFixture();
  const prepared = prepareSourceAnalytics(fixture);
  const bundle = buildSiteDataBundle(prepared);
  validateSiteDataBundleNumericFields(bundle);
});

test('validateSiteDataBundleNumericFields rejects NaN count fields in run summary', async () => {
  const fixture = deepClone(await loadFixture());
  const prepared = prepareSourceAnalytics(fixture);
  const bundle = buildSiteDataBundle(prepared);

  bundle.runSummary.rows[0]!.toolCallCount = Number.NaN;
  assert.throws(
    () => validateSiteDataBundleNumericFields(bundle),
    /run-summary\.json row 0\.toolCallCount must be a finite non-negative number, got NaN/,
  );
});

test('validateSiteDataBundleNumericFields rejects Infinity count fields in run summary', async () => {
  const fixture = deepClone(await loadFixture());
  const prepared = prepareSourceAnalytics(fixture);
  const bundle = buildSiteDataBundle(prepared);

  bundle.runSummary.rows[0]!.outputTokens = Number.POSITIVE_INFINITY;
  assert.throws(
    () => validateSiteDataBundleNumericFields(bundle),
    /run-summary\.json row 0\.outputTokens must be a finite non-negative number, got Infinity/,
  );
});

test('validateSiteDataBundleNumericFields rejects negative count fields in run summary', async () => {
  const fixture = deepClone(await loadFixture());
  const prepared = prepareSourceAnalytics(fixture);
  const bundle = buildSiteDataBundle(prepared);

  bundle.runSummary.rows[0]!.toolFailureCount = -3;
  assert.throws(
    () => validateSiteDataBundleNumericFields(bundle),
    /run-summary\.json row 0\.toolFailureCount must be a finite non-negative number, got -3/,
  );
});

test('validateSiteDataBundleNumericFields rejects NaN nullable estimated cost', async () => {
  const fixture = deepClone(await loadFixture());
  const prepared = prepareSourceAnalytics(fixture);
  const bundle = buildSiteDataBundle(prepared);

  bundle.runSummary.rows[0]!.estimatedCostUsd = Number.NaN;
  assert.throws(
    () => validateSiteDataBundleNumericFields(bundle),
    /run-summary\.json row 0\.estimatedCostUsd must be null or a finite non-negative number, got NaN/,
  );
});

test('validateSiteDataBundleNumericFields allows null estimated cost and satisfaction', async () => {
  const fixture = deepClone(await loadFixture());
  const prepared = prepareSourceAnalytics(fixture);
  const bundle = buildSiteDataBundle(prepared);

  bundle.runSummary.rows[0]!.estimatedCostUsd = null;
  bundle.runSummary.rows[0]!.satisfaction = null;
  validateSiteDataBundleNumericFields(bundle);
});

test('validateSiteDataBundleNumericFields validates satisfaction bounds', async () => {
  const fixture = deepClone(await loadFixture());
  const prepared = prepareSourceAnalytics(fixture);
  const bundle = buildSiteDataBundle(prepared);

  bundle.overview.averageSatisfaction = 5.5;
  assert.throws(
    () => validateSiteDataBundleNumericFields(bundle),
    /overview\.averageSatisfaction must be null or a finite number in \[1, 5\], got 5\.5/,
  );

  bundle.overview.averageSatisfaction = 0.5;
  assert.throws(
    () => validateSiteDataBundleNumericFields(bundle),
    /overview\.averageSatisfaction must be null or a finite number in \[1, 5\], got 0\.5/,
  );
});

test('validateSiteDataBundleNumericFields rejects NaN in overview averages', async () => {
  const fixture = deepClone(await loadFixture());
  const prepared = prepareSourceAnalytics(fixture);
  const bundle = buildSiteDataBundle(prepared);

  bundle.overview.toolFailureRate = Number.NaN;
  assert.throws(
    () => validateSiteDataBundleNumericFields(bundle),
    /overview\.toolFailureRate must be null or a finite number, got NaN/,
  );
});

test('validateSiteDataBundleNumericFields rejects NaN in aggregate rows', async () => {
  const fixture = deepClone(await loadFixture());
  const prepared = prepareSourceAnalytics(fixture);
  const bundle = buildSiteDataBundle(prepared);

  bundle.modelQuality.rows[0]!.runCount = Number.NaN;
  assert.throws(
    () => validateSiteDataBundleNumericFields(bundle),
    /model-quality\.json row 0\.runCount must be a finite non-negative number, got NaN/,
  );

  bundle.modelQuality.rows[0]!.runCount = 0;
  bundle.modelQuality.rows[0]!.averageSatisfaction = Number.POSITIVE_INFINITY;
  assert.throws(
    () => validateSiteDataBundleNumericFields(bundle),
    /model-quality\.json row 0\.averageSatisfaction must be null or a finite number in \[1, 5\], got Infinity/,
  );
});

test('validateSiteDataBundleNumericFields rejects negative timeline counts', async () => {
  const fixture = deepClone(await loadFixture());
  const prepared = prepareSourceAnalytics(fixture);
  const bundle = buildSiteDataBundle(prepared);

  bundle.timeline.rows[0]!.runCount = -1;
  assert.throws(
    () => validateSiteDataBundleNumericFields(bundle),
    /timeline\.json row 0\.runCount must be a finite non-negative number, got -1/,
  );
});
