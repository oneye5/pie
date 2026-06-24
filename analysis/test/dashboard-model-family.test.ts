import assert from 'node:assert/strict';
import test from 'node:test';

import { prepareSourceAnalytics } from '../scripts/prepare.ts';
import { buildSiteDataBundle } from '../scripts/site-data.ts';
import { compositionByModelRows, modelThinkingRows, applyFilters } from '../site/app.ts';
import { deepClone, loadFixture } from './helpers.ts';

/**
 * Every model-grouped analytics view (except the leaderboard, which was already converted) used to
 * key on the provider-specific `modelId`, so the same model offered by two providers (e.g.
 * `umans-glm-5.2` and `glm-5.2:cloud`) showed as two rows instead of collapsing into one family
 * row. These tests guard that the in-browser views AND the persisted site-data artifacts now group
 * by the canonical `modelFamily` expression (`run.modelFamily?.trim() || run.modelId?.trim() ||
 * '(unknown)'`) — mirroring `dashboard-leaderboard.test.ts`'s collapse assertion.
 *
 * The fixture's models resolve family==id, so a cross-provider collapse case is synthesized here:
 * `umans-glm-5.2` and `glm-5.2:cloud` both resolve to family `glm-5.2` via `models.json`.
 */

type AnalyticsFixture = Awaited<ReturnType<typeof loadFixture>>;

interface ScoredRunSpec {
  runId: string;
  modelId: string;
}

async function buildScoredFixture(specs: ScoredRunSpec[]): Promise<AnalyticsFixture> {
  const fixture = deepClone(await loadFixture());
  // baseRun carries the rest of the required snapshot fields; we only override identity + outcome.
  const baseRun = fixture.completedRuns[0]!;
  fixture.completedRuns = [];
  fixture.openRuns = [];
  fixture.outcomes = [];

  for (const spec of specs) {
    const run = deepClone(baseRun);
    run.runId = spec.runId;
    run.taskGroupId = `${spec.runId}-task`;
    run.modelId = spec.modelId;
    run.thinkingLevel = 'high';
    run.status = 'scored';
    run.scored = true;
    run.finalizationReason = 'scored';
    run.finalizedAt = '2026-05-10T14:19:00.000Z';
    run.outcome = { resolution: 'resolved' as const, satisfaction: 5 };
    fixture.completedRuns.push(run);
    fixture.outcomes.push({
      schemaVersion: 1,
      kind: 'run_outcome' as const,
      recordedAt: '2026-05-10T14:19:00.000Z',
      sessionPath: baseRun.sessionPath,
      runId: run.runId,
      taskGroupId: run.taskGroupId,
      outcome: run.outcome,
    });
  }
  return fixture;
}

const ALL_FILTERS = {
  startDate: '',
  endDate: '',
  modelId: '',
  thinkingLevel: '',
  experimentAssignment: '',
  subagentParentModel: '',
  pruningMode: '',
  scoredOnly: true,
  pureOnly: false,
};

test('modelThinkingRows is provider-agnostic: collapses provider-specific ids sharing a family into one row', async () => {
  const fixture = await buildScoredFixture([
    { runId: 'umans-glm-a', modelId: 'umans-glm-5.2' },
    { runId: 'umans-glm-b', modelId: 'umans-glm-5.2' },
    { runId: 'ollama-glm-a', modelId: 'glm-5.2:cloud' },
    { runId: 'ollama-glm-b', modelId: 'glm-5.2:cloud' },
    { runId: 'gpt-a', modelId: 'gpt-5.2' },
  ]);
  const prepared = prepareSourceAnalytics(fixture);
  const rows = modelThinkingRows(prepared.runs);

  const glmRow = rows.find((row) => row.modelId === 'glm-5.2');
  assert.ok(glmRow, 'GLM 5.2 should appear as a single provider-agnostic row');
  assert.equal(glmRow!.runCount, 4, 'both providers collapsed into one row');

  const gptRow = rows.find((row) => row.modelId === 'gpt-5.2');
  assert.ok(gptRow, 'GPT-5.2 should appear as its own row');
  assert.equal(gptRow!.runCount, 1);

  // No provider-specific id leaks as its own row.
  assert.ok(!rows.some((row) => row.modelId === 'umans-glm-5.2'), 'umans-glm-5.2 must not appear as its own row');
  assert.ok(!rows.some((row) => row.modelId === 'glm-5.2:cloud'), 'glm-5.2:cloud must not appear as its own row');
});

test('compositionByModelRows is provider-agnostic: collapses provider-specific ids sharing a family into one row', async () => {
  const fixture = await buildScoredFixture([
    { runId: 'umans-glm-a', modelId: 'umans-glm-5.2' },
    { runId: 'ollama-glm-a', modelId: 'glm-5.2:cloud' },
    { runId: 'gpt-a', modelId: 'gpt-5.2' },
  ]);
  const prepared = prepareSourceAnalytics(fixture);
  const rows = compositionByModelRows(prepared.runs);

  const families = new Set(rows.map((row) => row.modelId));
  assert.ok(families.has('glm-5.2'), 'glm-5.2 family present');
  assert.ok(families.has('gpt-5.2'), 'gpt-5.2 family present');
  assert.ok(!families.has('umans-glm-5.2'), 'umans-glm-5.2 must not leak as its own family');
  assert.ok(!families.has('glm-5.2:cloud'), 'glm-5.2:cloud must not leak as its own family');

  // Both providers' runs roll up under the single family row (each resolution row shares scoredRunCount).
  const glmScored = rows.filter((row) => row.modelId === 'glm-5.2').map((row) => row.scoredRunCount);
  assert.ok(glmScored.length > 0);
  assert.ok(glmScored.every((count) => count === 2), 'glm-5.2 family rolls up both providers (2 runs)');
});

test('model filter predicate is family-keyed: filtering by a family matches every provider-specific id that resolves to it', async () => {
  // CRITICAL COUPLING: the filter dropdown now lists FAMILIES, so the predicate must compare the
  // same family expression — otherwise filtering by a family matches zero runs.
  const fixture = await buildScoredFixture([
    { runId: 'umans-glm-a', modelId: 'umans-glm-5.2' },
    { runId: 'umans-glm-b', modelId: 'umans-glm-5.2' },
    { runId: 'ollama-glm-a', modelId: 'glm-5.2:cloud' },
    { runId: 'ollama-glm-b', modelId: 'glm-5.2:cloud' },
    { runId: 'gpt-a', modelId: 'gpt-5.2' },
  ]);
  const prepared = prepareSourceAnalytics(fixture);
  const completed = prepared.runs.filter((run) => run.status !== 'open');

  const glmRuns = applyFilters(completed, { ...ALL_FILTERS, modelId: 'glm-5.2' });
  assert.equal(glmRuns.length, 4, 'filtering by glm-5.2 family keeps both providers');
  assert.ok(
    glmRuns.every((run) => (run.modelFamily?.trim() || run.modelId?.trim() || '(unknown)') === 'glm-5.2'),
    'every kept run resolves to the glm-5.2 family',
  );

  const gptRuns = applyFilters(completed, { ...ALL_FILTERS, modelId: 'gpt-5.2' });
  assert.equal(gptRuns.length, 1, 'filtering by gpt-5.2 family keeps only its runs');

  const allRuns = applyFilters(completed, { ...ALL_FILTERS, modelId: '' });
  assert.equal(allRuns.length, 5, 'empty model filter keeps all runs');
});

test('createModelQuality is provider-agnostic: collapses cross-provider ids into one family row and surfaces providerModelIds', async () => {
  const fixture = await buildScoredFixture([
    { runId: 'umans-glm-a', modelId: 'umans-glm-5.2' },
    { runId: 'ollama-glm-a', modelId: 'glm-5.2:cloud' },
    { runId: 'gpt-a', modelId: 'gpt-5.2' },
  ]);
  const prepared = prepareSourceAnalytics(fixture);
  const bundle = buildSiteDataBundle(prepared);

  const glmRow = bundle.modelQuality.rows.find((row) => row.modelId === 'glm-5.2');
  assert.ok(glmRow, 'GLM 5.2 should appear as a single provider-agnostic row');
  assert.equal(glmRow!.runCount, 2, 'both providers collapsed into one row');
  // The collapse is surfaced so provider differences stay investigable (mirrors the leaderboard).
  assert.deepEqual(glmRow!.providerModelIds, ['glm-5.2:cloud', 'umans-glm-5.2']);

  assert.ok(
    !bundle.modelQuality.rows.some((row) => row.modelId === 'umans-glm-5.2' || row.modelId === 'glm-5.2:cloud'),
    'no provider-specific id leaks as its own row',
  );
});

test('createTimeline modelMix is provider-agnostic: keys by family, not provider-specific id', async () => {
  const fixture = await buildScoredFixture([
    { runId: 'umans-glm-a', modelId: 'umans-glm-5.2' },
    { runId: 'umans-glm-b', modelId: 'umans-glm-5.2' },
    { runId: 'ollama-glm-a', modelId: 'glm-5.2:cloud' },
    { runId: 'ollama-glm-b', modelId: 'glm-5.2:cloud' },
    { runId: 'gpt-a', modelId: 'gpt-5.2' },
  ]);
  const prepared = prepareSourceAnalytics(fixture);
  const bundle = buildSiteDataBundle(prepared);

  // All synthesized runs share the base run's startedDay, so they land in one timeline bucket.
  assert.equal(bundle.timeline.rows.length, 1);
  const modelMix = bundle.timeline.rows[0]!.modelMix;
  assert.deepEqual(
    modelMix,
    { 'glm-5.2': 4, 'gpt-5.2': 1 },
    'modelMix keys are families; both providers collapse into glm-5.2',
  );
  assert.ok(!('umans-glm-5.2' in modelMix), 'no provider-specific key leaks into modelMix');
  assert.ok(!('glm-5.2:cloud' in modelMix), 'no provider-specific key leaks into modelMix');
});
