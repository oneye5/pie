import assert from 'node:assert/strict';
import test from 'node:test';

import { createModelLeaderboard } from '../scripts/leaderboard.ts';
import { prepareSourceAnalytics } from '../scripts/prepare.ts';
import { deepClone, loadFixture } from './helpers.ts';

test('leaderboard produces ranked rows from fixture data', async () => {
  const fixture = await loadFixture();
  const prepared = prepareSourceAnalytics(fixture);
  const leaderboard = createModelLeaderboard(prepared);

  assert.equal(leaderboard.schemaVersion, 1);
  assert.ok(leaderboard.rows.length > 0, 'should produce at least one row');
  assert.equal(leaderboard.minimumScoredRuns, 3);
  assert.deepEqual(Object.keys(leaderboard.weights).sort(), [
    'firstAttemptSuccess', 'resolutionRate', 'satisfaction', 'tokenEfficiency', 'toolReliability', 'verificationAdoption',
  ]);

  // Every row has required fields
  for (const row of leaderboard.rows) {
    assert.ok(typeof row.modelId === 'string');
    assert.ok(typeof row.thinkingLevel === 'string');
    assert.ok(typeof row.runCount === 'number' && row.runCount > 0);
    assert.ok(typeof row.scoredRunCount === 'number');
    assert.ok(row.dimensions !== null && typeof row.dimensions === 'object');
    for (const dim of Object.values(row.dimensions)) {
      assert.ok(typeof dim.n === 'number' && dim.n >= 0);
    }
    assert.ok(typeof row.reliabilityFactor === 'number' || row.reliabilityFactor === null);
  }
});

test('leaderboard excludes open runs from grouping', async () => {
  const fixture = await loadFixture();
  const prepared = prepareSourceAnalytics(fixture);
  const leaderboard = createModelLeaderboard(prepared);

  const totalLeaderboardRuns = leaderboard.rows.reduce((sum, row) => sum + row.runCount, 0);
  const completedRuns = prepared.runs.filter((run) => run.status !== 'open').length;
  assert.equal(totalLeaderboardRuns, completedRuns);
});

test('leaderboard assigns null rank and composite when scored runs < minimum', async () => {
  const fixture = deepClone(await loadFixture());
  // Keep only 1 scored run per model by unscoring most
  let kept = 0;
  for (const run of fixture.completedRuns) {
    if (kept >= 1) {
      run.scored = false;
      delete (run as Partial<typeof run>).outcome;
    } else if (run.scored) {
      kept++;
    }
  }
  fixture.outcomes = fixture.outcomes.slice(0, 1);

  const prepared = prepareSourceAnalytics(fixture);
  const leaderboard = createModelLeaderboard(prepared);

  for (const row of leaderboard.rows) {
    if (row.scoredRunCount < 3) {
      assert.equal(row.compositeScore, null, `model ${row.modelId} should have null composite with ${row.scoredRunCount} scored runs`);
      assert.equal(row.rank, null, `model ${row.modelId} should have null rank`);
    }
  }
});

test('leaderboard handles all-unscored edge case', async () => {
  const fixture = deepClone(await loadFixture());
  fixture.completedRuns.forEach((run) => {
    run.scored = false;
    delete (run as Partial<typeof run>).outcome;
  });
  fixture.outcomes = [];

  const prepared = prepareSourceAnalytics(fixture);
  const leaderboard = createModelLeaderboard(prepared);

  assert.ok(leaderboard.rows.length > 0, 'should still produce rows for completed runs');
  for (const row of leaderboard.rows) {
    assert.equal(row.scoredRunCount, 0);
    assert.equal(row.compositeScore, null);
    assert.equal(row.rank, null);
    assert.equal(row.dimensions.satisfaction.value, null);
    assert.equal(row.dimensions.satisfaction.lowerBound, null);
    assert.equal(row.reliabilityFactor, null);
  }
});

test('leaderboard collapses experiment assignments into model+thinking groups', async () => {
  const fixture = deepClone(await loadFixture());
  // Give the same model different experiment assignments
  for (const run of fixture.completedRuns) {
    run.modelId = 'test-model';
    run.thinkingLevel = 'medium';
    run.experimentAssignment = run.runId === 'run-001' ? 'exp-a' : 'exp-b';
  }

  const prepared = prepareSourceAnalytics(fixture);
  const leaderboard = createModelLeaderboard(prepared);

  // Should collapse into one row since model+thinking are the same
  const testRows = leaderboard.rows.filter((row) => row.modelId === 'test-model');
  assert.equal(testRows.length, 1, 'experiment assignments should be collapsed');
  assert.equal(testRows[0]!.runCount, fixture.completedRuns.length);
});

test('leaderboard ranks are sorted descending by composite score', async () => {
  const fixture = await loadFixture();
  const prepared = prepareSourceAnalytics(fixture);
  const leaderboard = createModelLeaderboard(prepared);

  const ranked = leaderboard.rows.filter((row) => row.rank !== null);
  for (let index = 1; index < ranked.length; index++) {
    const previous = ranked[index - 1]!;
    const current = ranked[index]!;
    assert.ok(previous.rank! <= current.rank!, 'ranks should be ascending');
    assert.ok(previous.compositeScore! >= current.compositeScore!, 'composite scores should be descending');
  }

  // Unranked rows come after ranked rows
  const unranked = leaderboard.rows.filter((row) => row.rank === null);
  if (ranked.length > 0 && unranked.length > 0) {
    const lastRankedIdx = leaderboard.rows.indexOf(ranked[ranked.length - 1]!);
    const firstUnrankedIdx = leaderboard.rows.indexOf(unranked[0]!);
    assert.ok(lastRankedIdx < firstUnrankedIdx, 'unranked rows should come after ranked rows');
  }
});

test('leaderboard dimension values are within expected bounds', async () => {
  const fixture = await loadFixture();
  const prepared = prepareSourceAnalytics(fixture);
  const leaderboard = createModelLeaderboard(prepared);

  for (const row of leaderboard.rows) {
    const { satisfaction, resolutionRate, firstAttemptSuccess, toolReliability, verificationAdoption, tokenEfficiency } = row.dimensions;

    if (satisfaction.value !== null) {
      assert.ok(satisfaction.value >= 1 && satisfaction.value <= 5, `satisfaction value ${satisfaction.value} out of [1,5]`);
    }
    if (satisfaction.lowerBound !== null) {
      assert.ok(satisfaction.lowerBound >= 1 && satisfaction.lowerBound <= 5, `satisfaction lowerBound ${satisfaction.lowerBound} out of [1,5]`);
    }

    for (const dim of [resolutionRate, firstAttemptSuccess, toolReliability, verificationAdoption]) {
      if (dim.value !== null) {
        assert.ok(dim.value >= 0 && dim.value <= 1, `dimension value ${dim.value} out of [0,1]`);
      }
      if (dim.lowerBound !== null) {
        assert.ok(dim.lowerBound >= 0 && dim.lowerBound <= 1, `dimension lowerBound ${dim.lowerBound} out of [0,1]`);
      }
    }

    if (tokenEfficiency.value !== null) {
      assert.ok(tokenEfficiency.value >= 0 && tokenEfficiency.value <= 50, `tokenEfficiency value ${tokenEfficiency.value} out of [0,50]`);
    }
    if (tokenEfficiency.lowerBound !== null) {
      assert.ok(tokenEfficiency.lowerBound >= 0 && tokenEfficiency.lowerBound <= 50, `tokenEfficiency lowerBound ${tokenEfficiency.lowerBound} out of [0,50]`);
    }
  }
});

test('leaderboard tracks subagent context from fixture data', async () => {
  const fixture = await loadFixture();
  const prepared = prepareSourceAnalytics(fixture);
  const leaderboard = createModelLeaderboard(prepared);

  // Fixture has exactly 1 run with subagent calls (run-003)
  const totalSubagentRuns = leaderboard.rows.reduce((sum, row) => sum + row.subagentRunCount, 0);
  assert.equal(totalSubagentRuns, 1, 'fixture should have 1 run with subagent usage');

  for (const row of leaderboard.rows) {
    assert.ok(row.subagentUsageRate !== null);
    if (row.subagentRunCount === 0) {
      assert.equal(row.avgSubagentTasksPerRun, null);
    } else {
      assert.ok(typeof row.avgSubagentTasksPerRun === 'number');
    }
  }
});

test('leaderboard weights sum to 1.0', async () => {
  const fixture = await loadFixture();
  const prepared = prepareSourceAnalytics(fixture);
  const leaderboard = createModelLeaderboard(prepared);

  const sum = Object.values(leaderboard.weights).reduce((acc, w) => acc + w, 0);
  assert.ok(Math.abs(sum - 1.0) < 0.001, `weights sum to ${sum}, expected 1.0`);
});

test('leaderboard reliability penalty scales with scored run count', async () => {
  const fixture = deepClone(await loadFixture());
  // Create two models: one with 3 scored runs, one with 10+
  const baseRun = fixture.completedRuns[0]!;
  const fewRuns: typeof fixture.completedRuns = [];
  const manyRuns: typeof fixture.completedRuns = [];

  // Model with only 3 scored runs (minimum)
  for (let i = 0; i < 3; i++) {
    const r = deepClone(baseRun);
    r.runId = `few-run-${i}`;
    r.taskGroupId = `few-task-${i}`;
    r.modelId = 'few-scored-model';
    r.thinkingLevel = 'high';
    r.scored = true;
    r.outcome = { resolution: 'resolved' as const, satisfaction: 5 };
    fewRuns.push(r);
  }

  // Model with 12 scored runs (well above target)
  for (let i = 0; i < 12; i++) {
    const r = deepClone(baseRun);
    r.runId = `many-run-${i}`;
    r.taskGroupId = `many-task-${i}`;
    r.modelId = 'many-scored-model';
    r.thinkingLevel = 'high';
    r.scored = true;
    r.outcome = { resolution: 'resolved' as const, satisfaction: 4 };
    manyRuns.push(r);
  }

  fixture.completedRuns.push(...fewRuns, ...manyRuns);
  fixture.outcomes.push(
    ...fewRuns.map((run) => ({
      schemaVersion: 1,
      kind: 'run_outcome' as const,
      recordedAt: '2026-05-10T14:19:00.000Z',
      sessionPath: baseRun.sessionPath,
      runId: run.runId,
      taskGroupId: run.taskGroupId,
      outcome: run.outcome!,
    })),
    ...manyRuns.map((run) => ({
      schemaVersion: 1,
      kind: 'run_outcome' as const,
      recordedAt: '2026-05-10T14:19:00.000Z',
      sessionPath: baseRun.sessionPath,
      runId: run.runId,
      taskGroupId: run.taskGroupId,
      outcome: run.outcome!,
    })),
  );

  const prepared = prepareSourceAnalytics(fixture);
  const leaderboard = createModelLeaderboard(prepared);

  const fewRow = leaderboard.rows.find((row) => row.modelId === 'few-scored-model');
  const manyRow = leaderboard.rows.find((row) => row.modelId === 'many-scored-model');

  assert.ok(fewRow, 'few-scored-model should appear');
  assert.ok(manyRow, 'many-scored-model should appear');

  // Few-scored model should have reliability factor of 0.3 (3/10)
  assert.ok(fewRow!.reliabilityFactor !== null, 'reliabilityFactor should not be null for scored model');
  assert.equal(fewRow!.reliabilityFactor, 0.3, '3 scored runs should give 0.3 reliability factor');

  // Many-scored model should have reliability factor capped at 1.0 (12/10 = 1.2, clamped to 1.0)
  assert.ok(manyRow!.reliabilityFactor !== null, 'reliabilityFactor should not be null for scored model');
  assert.equal(manyRow!.reliabilityFactor, 1, '12 scored runs should give reliability factor of 1.0');

  // Even though few-scored has perfect satisfaction (5) vs many (4),
  // the reliability penalty means many-scored should rank higher
  assert.ok(manyRow!.rank !== null && fewRow!.rank !== null, 'both should be ranked');
  assert.ok(manyRow!.rank! < fewRow!.rank!, `many-scored (rank ${manyRow!.rank}) should outrank few-scored (rank ${fewRow!.rank}) thanks to reliability penalty`);
});

test('leaderboard reliability penalty prevents cherry-picked runs from dominating', async () => {
  const fixture = deepClone(await loadFixture());
  const baseRun = fixture.completedRuns[0]!;

  // Weak model with many mediocre runs (10 scored, satisfaction 3)
  const manyMediocre: typeof fixture.completedRuns = [];
  for (let i = 0; i < 10; i++) {
    const r = deepClone(baseRun);
    r.runId = `mediocre-run-${i}`;
    r.taskGroupId = `mediocre-task-${i}`;
    r.modelId = 'mediocre-model';
    r.thinkingLevel = 'high';
    r.scored = true;
    r.outcome = { resolution: 'partially_resolved' as const, satisfaction: 3 };
    manyMediocre.push(r);
  }

  // Cherry-picked mini model with 4 perfect runs
  const cherryPicked: typeof fixture.completedRuns = [];
  for (let i = 0; i < 4; i++) {
    const r = deepClone(baseRun);
    r.runId = `cherry-run-${i}`;
    r.taskGroupId = `cherry-task-${i}`;
    r.modelId = 'cherry-model';
    r.thinkingLevel = 'high';
    r.scored = true;
    r.outcome = { resolution: 'resolved' as const, satisfaction: 5 };
    cherryPicked.push(r);
  }

  fixture.completedRuns.push(...manyMediocre, ...cherryPicked);
  fixture.outcomes.push(
    ...manyMediocre.map((run) => ({
      schemaVersion: 1,
      kind: 'run_outcome' as const,
      recordedAt: '2026-05-10T14:19:00.000Z',
      sessionPath: baseRun.sessionPath,
      runId: run.runId,
      taskGroupId: run.taskGroupId,
      outcome: run.outcome!,
    })),
    ...cherryPicked.map((run) => ({
      schemaVersion: 1,
      kind: 'run_outcome' as const,
      recordedAt: '2026-05-10T14:19:00.000Z',
      sessionPath: baseRun.sessionPath,
      runId: run.runId,
      taskGroupId: run.taskGroupId,
      outcome: run.outcome!,
    })),
  );

  const prepared = prepareSourceAnalytics(fixture);
  const leaderboard = createModelLeaderboard(prepared);

  const cherryRow = leaderboard.rows.find((row) => row.modelId === 'cherry-model');
  const mediocreRow = leaderboard.rows.find((row) => row.modelId === 'mediocre-model');

  assert.ok(cherryRow, 'cherry-model should appear');
  assert.ok(mediocreRow, 'mediocre-model should appear');

  // Cherry-picked model should have 0.4 reliability (4/10)
  assert.equal(cherryRow!.reliabilityFactor, 0.4, '4 scored runs → 0.4 reliability');
  // Mediocre model should have 1.0 reliability (10/10)
  assert.equal(mediocreRow!.reliabilityFactor, 1.0, '10 scored runs → 1.0 reliability');
});

test('leaderboard proportion dimensions use scored runs only', async () => {
  const fixture = deepClone(await loadFixture());
  const baseRun = fixture.completedRuns[0]!;

  // Create a model where total runs have 0% firstAttemptSuccess but scored runs have 100%
  const runs: typeof fixture.completedRuns = [];
  // 3 scored runs with firstAttemptSuccess = true
  for (let i = 0; i < 3; i++) {
    const r = deepClone(baseRun);
    r.runId = `scored-fas-run-${i}`;
    r.taskGroupId = `scored-fas-task-${i}`;
    r.modelId = 'pop-test-model';
    r.thinkingLevel = 'high';
    r.scored = true;
    r.outcome = { resolution: 'resolved' as const, satisfaction: 4 };
    runs.push(r);
  }
  // 7 unscored runs with firstAttemptSuccess = false
  for (let i = 0; i < 7; i++) {
    const r = deepClone(baseRun);
    r.runId = `unscored-no-fas-run-${i}`;
    r.taskGroupId = `unscored-no-fas-task-${i}`;
    r.modelId = 'pop-test-model';
    r.thinkingLevel = 'high';
    r.scored = false;
    delete (r as Partial<typeof r>).outcome;
    runs.push(r);
  }

  fixture.completedRuns.push(...runs);
  fixture.outcomes.push(
    ...runs.filter((r) => r.scored).map((run) => ({
      schemaVersion: 1,
      kind: 'run_outcome' as const,
      recordedAt: '2026-05-10T14:19:00.000Z',
      sessionPath: baseRun.sessionPath,
      runId: run.runId,
      taskGroupId: run.taskGroupId,
      outcome: run.outcome!,
    })),
  );

  const prepared = prepareSourceAnalytics(fixture);
  const leaderboard = createModelLeaderboard(prepared);

  const row = leaderboard.rows.find((r) => r.modelId === 'pop-test-model');
  assert.ok(row, 'pop-test-model should appear');

  // firstAttemptSuccess dimension.n should be 3 (scored only), not 10 (total)
  assert.equal(row!.dimensions.firstAttemptSuccess.n, 3, 'firstAttemptSuccess dimension should use scored runs only (n=3)');
  // toolReliability n should also be scored-only
  assert.equal(row!.dimensions.toolReliability.n, 3, 'toolReliability dimension should use scored runs only (n=3)');
  // verificationAdoption n should also be scored-only
  assert.equal(row!.dimensions.verificationAdoption.n, 3, 'verificationAdoption dimension should use scored runs only (n=3)');
  // runCount should still reflect total (10)
  assert.equal(row!.runCount, 10, 'runCount should reflect all runs, not just scored');
  assert.equal(row!.scoredRunCount, 3, 'scoredRunCount should be 3');
});

test('leaderboard token efficiency dimension is populated when token data exists', async () => {
  const fixture = await loadFixture();
  const prepared = prepareSourceAnalytics(fixture);
  const leaderboard = createModelLeaderboard(prepared);

  let hasTokenEfficiencyData = false;
  for (const row of leaderboard.rows) {
    assert.ok(row.dimensions.tokenEfficiency !== undefined, 'tokenEfficiency dimension should exist');
    if (row.dimensions.tokenEfficiency.value !== null) {
      hasTokenEfficiencyData = true;
      assert.ok(row.dimensions.tokenEfficiency.value >= 0, 'tokenEfficiency value should be non-negative');
    }
  }
  assert.ok(hasTokenEfficiencyData, 'at least one row should have token efficiency data from fixture');
});

test('leaderboard reliability factor is null for unranked models', async () => {
  const fixture = await loadFixture();
  const prepared = prepareSourceAnalytics(fixture);
  const leaderboard = createModelLeaderboard(prepared);

  for (const row of leaderboard.rows) {
    if (row.scoredRunCount < 3) {
      assert.equal(row.reliabilityFactor, null, `model ${row.modelId} with ${row.scoredRunCount} scored runs should have null reliabilityFactor`);
    } else {
      assert.ok(row.reliabilityFactor !== null, `ranked model ${row.modelId} should have non-null reliabilityFactor`);
      assert.ok(row.reliabilityFactor! > 0, `ranked model ${row.modelId} reliabilityFactor should be positive`);
      assert.ok(row.reliabilityFactor! <= 1, `ranked model ${row.modelId} reliabilityFactor should be at most 1.0`);
    }
  }
});

test('leaderboard correctly orders ranked before unranked with mixed data', async () => {
  const fixture = deepClone(await loadFixture());
  // Create a model with enough scored runs to be ranked by duplicating runs
  const baseRun = fixture.completedRuns[0]!;
  const extraRuns = [];
  for (let i = 0; i < 4; i++) {
    const extra = deepClone(baseRun);
    extra.runId = `synth-run-${i}`;
    extra.taskGroupId = `synth-task-${i}`;
    extra.modelId = 'ranked-model';
    extra.thinkingLevel = 'high';
    extra.scored = true;
    extra.outcome = { resolution: 'resolved' as const, satisfaction: 4 };
    extraRuns.push(extra);
  }
  fixture.completedRuns.push(...extraRuns);
  fixture.outcomes.push(...extraRuns.map((run) => ({
    schemaVersion: 1,
    kind: 'run_outcome' as const,
    recordedAt: '2026-05-10T14:19:00.000Z',
    sessionPath: baseRun.sessionPath,
    runId: run.runId,
    taskGroupId: run.taskGroupId,
    outcome: run.outcome!,
  })));

  const prepared = prepareSourceAnalytics(fixture);
  const leaderboard = createModelLeaderboard(prepared);

  const ranked = leaderboard.rows.filter((row) => row.rank !== null);
  const unranked = leaderboard.rows.filter((row) => row.rank === null);

  assert.ok(ranked.length > 0, 'should have at least one ranked model');
  assert.ok(unranked.length > 0, 'should have at least one unranked model');

  // Ranked come first
  const lastRankedIdx = leaderboard.rows.indexOf(ranked[ranked.length - 1]!);
  const firstUnrankedIdx = leaderboard.rows.indexOf(unranked[0]!);
  assert.ok(lastRankedIdx < firstUnrankedIdx, 'ranked rows must precede unranked rows');

  // Ranked model should be our synthetic one
  assert.ok(ranked.some((row) => row.modelId === 'ranked-model'), 'ranked-model should be ranked');
  for (const row of ranked) {
    assert.ok(row.compositeScore !== null, 'ranked rows must have compositeScore');
    assert.ok(row.rank! >= 1, 'rank must be positive');
  }
});
