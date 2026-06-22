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
    'firstAttemptSuccess', 'resolutionRate', 'satisfaction', 'tokenEfficiency', 'toolReliability', 'verificationPassRate',
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
    const { satisfaction, resolutionRate, firstAttemptSuccess, toolReliability, verificationPassRate, tokenEfficiency } = row.dimensions;

    if (satisfaction.value !== null) {
      assert.ok(satisfaction.value >= 1 && satisfaction.value <= 5, `satisfaction value ${satisfaction.value} out of [1,5]`);
    }
    if (satisfaction.lowerBound !== null) {
      assert.ok(satisfaction.lowerBound >= 1 && satisfaction.lowerBound <= 5, `satisfaction lowerBound ${satisfaction.lowerBound} out of [1,5]`);
    }

    for (const dim of [resolutionRate, firstAttemptSuccess, toolReliability, verificationPassRate]) {
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

test('leaderboard reliability factor reports sample confidence n/(n+k)', async () => {
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

  // reliabilityFactor now reports sample confidence = scoredRunCount / (scoredRunCount + SHRINKAGE_K),
  // with SHRINKAGE_K = 4. It is a display-only indicator and is NOT a multiplicative score penalty.
  assert.ok(fewRow!.reliabilityFactor !== null, 'reliabilityFactor should not be null for scored model');
  assert.equal(fewRow!.reliabilityFactor, 0.4286, '3 scored runs → confidence 3/(3+4) = 0.4286');

  assert.ok(manyRow!.reliabilityFactor !== null, 'reliabilityFactor should not be null for scored model');
  assert.equal(manyRow!.reliabilityFactor, 0.75, '12 scored runs → confidence 12/(12+4) = 0.75');

  // Confidence rises with sample size but no longer hard-cliffs the composite (no multiplicative penalty).
  assert.ok(manyRow!.reliabilityFactor! > fewRow!.reliabilityFactor!, 'more runs → higher confidence');
  assert.ok(fewRow!.rank !== null && manyRow!.rank !== null, 'both should be ranked');
});

test('leaderboard shrinkage curbs cherry-picked extremes without burying stronger models', async () => {
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

  // reliabilityFactor = scoredRunCount / (scoredRunCount + SHRINKAGE_K), SHRINKAGE_K = 4.
  assert.equal(cherryRow!.reliabilityFactor, 0.5, '4 scored runs → confidence 4/(4+4) = 0.5');
  assert.equal(mediocreRow!.reliabilityFactor, 0.7143, '10 scored runs → confidence 10/(10+4) = 0.7143');

  // Empirical-Bayes shrinkage pulls the cherry-picked model's perfect estimates toward the grand
  // mean (which the mediocre model drags below 1.0), so shrunk < observed perfection ...
  assert.ok(cherryRow!.dimensions.satisfaction.shrunk !== null && cherryRow!.dimensions.satisfaction.shrunk! < 1,
    'cherry satisfaction shrunk below perfect 1.0 toward the grand mean');
  assert.ok(cherryRow!.dimensions.resolutionRate.shrunk !== null && cherryRow!.dimensions.resolutionRate.shrunk! < 1,
    'cherry resolution shrunk below perfect 1.0 toward the grand mean');
  // ... while preserving that the genuinely stronger model still scores higher on each dimension.
  assert.ok(cherryRow!.dimensions.satisfaction.shrunk! > mediocreRow!.dimensions.satisfaction.shrunk!,
    'cherry (sat 5) still shrinks above mediocre (sat 3)');
  assert.ok(cherryRow!.dimensions.resolutionRate.shrunk! > mediocreRow!.dimensions.resolutionRate.shrunk!,
    'cherry (resolved) still shrinks above mediocre (partially_resolved)');
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
  // verificationPassRate counts scored runs that performed verification (a subset of scored),
  // never the full total of 10.
  assert.ok(row!.dimensions.verificationPassRate.n <= 3, 'verificationPassRate dimension should use scored runs only (n <= 3, not total)');
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

test('leaderboard normalizes blank identifiers and sorts unranked ties deterministically', async () => {
  const source = await loadFixture();
  const baseRun = deepClone(source.completedRuns[0]!);
  const fixture = deepClone(source);
  fixture.completedRuns = [];
  fixture.openRuns = [];
  fixture.outcomes = [];

  function makeUnscoredRun(runId: string, modelId: string | null, thinkingLevel: string | null) {
    const run = deepClone(baseRun) as any;
    run.runId = runId;
    run.taskGroupId = `${runId}-task`;
    run.status = 'closed_unscored';
    run.scored = false;
    run.finalizationReason = 'closed_unscored';
    run.finalizedAt = '2026-05-10T14:19:00.000Z';
    delete run.outcome;
    if (modelId === null) {
      delete run.modelId;
    } else {
      run.modelId = modelId;
    }
    if (thinkingLevel === null) {
      run.thinkingLevel = '   ';
    } else {
      run.thinkingLevel = thinkingLevel;
    }
    return run;
  }

  fixture.completedRuns.push(
    makeUnscoredRun('alpha-run-xhigh', 'alpha-model', 'xhigh'),
    makeUnscoredRun('alpha-run-medium', 'alpha-model', 'medium'),
    makeUnscoredRun('beta-run-2', 'beta-model', 'low'),
    makeUnscoredRun('beta-run-1', 'beta-model', 'low'),
    makeUnscoredRun('unknown-run', null, null),
  );

  const prepared = prepareSourceAnalytics(fixture);
  const leaderboard = createModelLeaderboard(prepared);

  assert.equal(leaderboard.rows[0]?.modelId, 'beta-model');
  assert.equal(leaderboard.rows[0]?.thinkingLevel, 'low');
  assert.equal(leaderboard.rows[0]?.runCount, 2);
  assert.deepEqual(
    leaderboard.rows.slice(1).map((row) => `${row.modelId}:${row.thinkingLevel}`),
    ['(unknown):(unspecified)', 'alpha-model:medium', 'alpha-model:xhigh'],
  );
});

test('leaderboard handles large scored samples and ranked rows without token efficiency data', async () => {
  const fixture = deepClone(await loadFixture());
  const baseRun = fixture.completedRuns[0]!;
  fixture.completedRuns = [];
  fixture.openRuns = [];
  fixture.outcomes = [];

  function addScoredRuns(
    modelId: string,
    runCount: number,
    tokenMode: 'normal' | 'none' | 'clamped',
  ): void {
    for (let index = 0; index < runCount; index += 1) {
      const run = deepClone(baseRun);
      run.runId = `${modelId}-run-${index}`;
      run.taskGroupId = `${modelId}-task-${index}`;
      run.modelId = modelId;
      run.thinkingLevel = 'high';
      run.status = 'scored';
      run.scored = true;
      run.finalizationReason = 'scored';
      run.finalizedAt = '2026-05-10T14:19:00.000Z';
      run.outcome = { resolution: 'resolved', satisfaction: tokenMode === 'none' ? 5 : 4 };
      if (tokenMode === 'none') {
        run.fileMutation.lineAdditions = 0;
        run.fileMutation.lineDeletions = 0;
        run.fileMutation.lineModifications = 0;
      } else if (tokenMode === 'clamped') {
        run.fileMutation.lineAdditions = 1;
        run.fileMutation.lineDeletions = 0;
        run.fileMutation.lineModifications = 0;
        run.outputTokens = 500;
      } else {
        run.fileMutation.lineAdditions = 10;
        run.fileMutation.lineDeletions = 0;
        run.fileMutation.lineModifications = 0;
        run.outputTokens = 100;
      }
      fixture.completedRuns.push(run);
      fixture.outcomes.push({
        schemaVersion: 1,
        kind: 'run_outcome',
        recordedAt: '2026-05-10T14:19:00.000Z',
        sessionPath: baseRun.sessionPath,
        runId: run.runId,
        taskGroupId: run.taskGroupId,
        outcome: run.outcome,
      });
    }
  }

  addScoredRuns('df-35-model', 35, 'normal');
  addScoredRuns('df-55-model', 55, 'normal');
  addScoredRuns('df-121-model', 121, 'normal');
  addScoredRuns('df-122-model', 122, 'clamped');
  addScoredRuns('no-token-model', 3, 'none');

  const prepared = prepareSourceAnalytics(fixture);
  const leaderboard = createModelLeaderboard(prepared);

  for (const modelId of ['df-35-model', 'df-55-model', 'df-121-model', 'df-122-model']) {
    const row = leaderboard.rows.find((candidate) => candidate.modelId === modelId);
    assert.ok(row?.rank !== null, `${modelId} should be ranked`);
    // Large samples yield high sample confidence n/(n+4), approaching (but never hard-capping at) 1.
    assert.ok(row?.reliabilityFactor !== null && row!.reliabilityFactor! > 0.85, `${modelId} should have high confidence`);
  }

  const clampedRow = leaderboard.rows.find((row) => row.modelId === 'df-122-model');
  assert.equal(clampedRow?.dimensions.tokenEfficiency.value, 50);
  assert.ok((clampedRow?.dimensions.tokenEfficiency.lowerBound ?? 0) <= 50);

  const noTokenRow = leaderboard.rows.find((row) => row.modelId === 'no-token-model');
  assert.ok(noTokenRow, 'no-token-model should appear');
  assert.equal(noTokenRow.dimensions.tokenEfficiency.n, 0);
  assert.equal(noTokenRow.dimensions.tokenEfficiency.value, null);
  assert.equal(noTokenRow.dimensions.tokenEfficiency.lowerBound, null);
  assert.ok(noTokenRow.rank !== null, 'models without token efficiency data should still be rankable');
});

test('leaderboard ranks the genuinely stronger model #1 by expected strength', async () => {
  const source = await loadFixture();
  const baseRun = deepClone(source.completedRuns[0]!);
  const fixture = deepClone(source);
  fixture.completedRuns = [];
  fixture.openRuns = [];
  fixture.outcomes = [];

  function addModelRuns(modelId: string, count: number, resolution: 'resolved' | 'unresolved', satisfaction: number): void {
    for (let i = 0; i < count; i++) {
      const run = deepClone(baseRun);
      run.runId = `${modelId}-run-${i}`;
      run.taskGroupId = `${modelId}-task-${i}`;
      run.modelId = modelId;
      run.thinkingLevel = 'high';
      run.status = 'scored';
      run.scored = true;
      run.finalizationReason = 'scored';
      run.finalizedAt = '2026-05-10T14:19:00.000Z';
      run.outcome = { resolution, satisfaction };
      fixture.completedRuns.push(run);
      fixture.outcomes.push({
        schemaVersion: 1,
        kind: 'run_outcome',
        recordedAt: '2026-05-10T14:19:00.000Z',
        sessionPath: baseRun.sessionPath,
        runId: run.runId,
        taskGroupId: run.taskGroupId,
        outcome: run.outcome,
      });
    }
  }

  // Strong model: resolved, top satisfaction. Weak model: unresolved, low satisfaction.
  // Both have enough scored runs to rank; other dimensions are inherited identically from the
  // same base run and cancel out, so the ranking reflects genuine outcome strength.
  addModelRuns('strong-model', 6, 'resolved', 5);
  addModelRuns('weak-model', 6, 'unresolved', 2);

  const prepared = prepareSourceAnalytics(fixture);
  const leaderboard = createModelLeaderboard(prepared);

  const strong = leaderboard.rows.find((row) => row.modelId === 'strong-model');
  const weak = leaderboard.rows.find((row) => row.modelId === 'weak-model');
  assert.ok(strong && weak, 'both models should appear');
  assert.equal(strong!.rank, 1, 'strong model should rank #1');
  assert.equal(weak!.rank, 2, 'weak model should rank #2');
  assert.ok(strong!.compositeScore! > weak!.compositeScore!, 'strong composite should exceed weak');
  // Cost is surfaced separately and does not affect the ranking.
  assert.ok(strong!.medianCostUsd === null || typeof strong!.medianCostUsd === 'number');
});

test('leaderboard difficulty-emphasizes so easy-task models do not outrank hard-task performers', async () => {
  const source = await loadFixture();
  const baseRun = deepClone(source.completedRuns[0]!);
  const fixture = deepClone(source);
  fixture.completedRuns = [];
  fixture.openRuns = [];
  fixture.outcomes = [];

  let counter = 0;
  function addRun(modelId: string, lineAdd: number, resolution: 'resolved' | 'unresolved', satisfaction: number): void {
    const run = deepClone(baseRun);
    counter += 1;
    run.runId = `${modelId}-run-${counter}`;
    run.taskGroupId = `${modelId}-task-${counter}`;
    run.modelId = modelId;
    run.thinkingLevel = 'high';
    run.status = 'scored';
    run.scored = true;
    run.finalizationReason = 'scored';
    run.finalizedAt = '2026-05-10T14:19:00.000Z';
    run.outcome = { resolution, satisfaction };
    // Vary five of the six complexity signals with `lineAdd` (a difficulty proxy) so task complexity
    // spans the full 0–1 range — lineMutations, touchedFileCount, toolCallCount, busyDurationMs,
    // inputTokens. Keep token efficiency constant (~5 tok/line: outputTokens = 5 × lineMutations) and
    // verification inherited from the base run, so those dims cancel across models and the ranking
    // isolates the difficulty emphasis.
    run.fileMutation.lineAdditions = lineAdd;
    run.fileMutation.lineDeletions = 0;
    run.fileMutation.lineModifications = 0;
    run.fileMutation.touchedFileCount = Math.max(1, Math.round(lineAdd / 5));
    run.toolUsage.totalCount = Math.max(1, Math.round(lineAdd / 2));
    run.busyDurationMs = lineAdd * 1000;
    run.inputTokens = lineAdd * 50;
    run.outputTokens = lineAdd * 5;
    fixture.completedRuns.push(run);
    fixture.outcomes.push({
      schemaVersion: 1,
      kind: 'run_outcome',
      recordedAt: '2026-05-10T14:19:00.000Z',
      sessionPath: baseRun.sessionPath,
      runId: run.runId,
      taskGroupId: run.taskGroupId,
      outcome: run.outcome,
    });
  }

  // mini-model: aces EASY tasks (low complexity) — raw resolution/satisfaction look perfect.
  for (const la of [2, 4, 6, 8]) addRun('mini-model', la, 'resolved', 5);
  // strong-model: performs well on HARD tasks (high complexity) — raw rates slightly below mini.
  // One unresolved run keeps strong's raw rate below mini's, so pre-adjustment mini would lead.
  [30, 34, 38, 42, 46, 50].forEach((la, i) => addRun('strong-model', la, i === 5 ? 'unresolved' : 'resolved', i === 5 ? 4 : 5));
  // weak-model: fails HARD tasks at complexities overlapping strong's — this drags the hard-task
  // baseline down so strong earns a positive residual (the crux of the adjustment).
  for (const la of [32, 36, 40, 44, 48, 52]) addRun('weak-model', la, 'unresolved', 2);

  const prepared = prepareSourceAnalytics(fixture);
  const leaderboard = createModelLeaderboard(prepared);
  const mini = leaderboard.rows.find((r) => r.modelId === 'mini-model')!;
  const strong = leaderboard.rows.find((r) => r.modelId === 'strong-model')!;
  const weak = leaderboard.rows.find((r) => r.modelId === 'weak-model')!;

  // Emphasis is enabled (the population has task-complexity variance).
  assert.equal(mini.difficultyEmphasized, true, 'population has complexity variance → emphasis enabled');
  assert.equal(strong.difficultyEmphasized, true);

  // Headline: the hard-task performer outranks the easy-task model despite worse raw rates —
  // completing complex tasks is the hallmark of strength under difficulty emphasis.
  assert.ok(strong.rank! < mini.rank!, `strong (rank ${strong.rank}) should outrank mini (rank ${mini.rank}) under difficulty emphasis`);
  assert.ok(strong.compositeScore! > mini.compositeScore!, 'emphasized strong composite should exceed mini');
  // A model that fails hard tasks lands below the easy-task model (failing hard work is not rewarded).
  assert.ok(weak.rank! > mini.rank!, `weak (rank ${weak.rank}) should rank below mini (rank ${mini.rank})`);

  // Isolation of the emphasis: raw mini > strong on resolution, but complexity-weighted strong > mini.
  assert.ok(mini.dimensions.resolutionRate.value! > strong.dimensions.resolutionRate.value!,
    'mini raw resolution (1.0) should exceed strong (~0.83)');
  assert.ok(strong.dimensions.resolutionRate.shrunk! > mini.dimensions.resolutionRate.shrunk!,
    'strong complexity-weighted resolution mastery should exceed mini after difficulty emphasis');

  // Verification pass rate is also complexity-weighted (regression guard): mini and strong share an
  // equal 100% raw pass rate (inherited from the base run), but strong verifies on harder tasks so
  // its mastery estimate must exceed mini's. A raw-proportion bug would tie these at the grand mean.
  assert.equal(mini.dimensions.verificationPassRate.value, strong.dimensions.verificationPassRate.value,
    'mini and strong share an equal raw verification pass rate (both 100%)');
  assert.ok(strong.dimensions.verificationPassRate.shrunk! > mini.dimensions.verificationPassRate.shrunk!,
    'strong verification pass mastery should exceed mini after difficulty emphasis');

  // meanTaskComplexity is exposed, bounded, and reflects task mix (mini easier than strong).
  for (const row of [mini, strong, weak]) {
    assert.ok(row.meanTaskComplexity !== null && row.meanTaskComplexity >= 0 && row.meanTaskComplexity <= 1,
      `${row.modelId} meanTaskComplexity should be in [0,1]`);
  }
  assert.ok(mini.meanTaskComplexity! < strong.meanTaskComplexity!, 'mini tasks should be lower-complexity than strong');
});

test('leaderboard difficulty emphasis is a no-op when the population has no complexity variance', async () => {
  const source = await loadFixture();
  const baseRun = deepClone(source.completedRuns[0]!);
  const fixture = deepClone(source);
  fixture.completedRuns = [];
  fixture.openRuns = [];
  fixture.outcomes = [];

  // Two models, 6 scored runs each, all cloned from the same base run → identical complexity signals
  // → zero complexity variance → residual control disables (bit-identical to pre-adjustment).
  let counter = 0;
  function addRun(modelId: string, satisfaction: number): void {
    const run = deepClone(baseRun);
    counter += 1;
    run.runId = `${modelId}-run-${counter}`;
    run.taskGroupId = `${modelId}-task-${counter}`;
    run.modelId = modelId;
    run.thinkingLevel = 'high';
    run.status = 'scored';
    run.scored = true;
    run.finalizationReason = 'scored';
    run.finalizedAt = '2026-05-10T14:19:00.000Z';
    run.outcome = { resolution: 'resolved' as const, satisfaction };
    fixture.completedRuns.push(run);
    fixture.outcomes.push({
      schemaVersion: 1,
      kind: 'run_outcome',
      recordedAt: '2026-05-10T14:19:00.000Z',
      sessionPath: baseRun.sessionPath,
      runId: run.runId,
      taskGroupId: run.taskGroupId,
      outcome: run.outcome,
    });
  }
  for (let i = 0; i < 6; i++) addRun('model-x', 5);
  for (let i = 0; i < 6; i++) addRun('model-y', 4);

  const prepared = prepareSourceAnalytics(fixture);
  const leaderboard = createModelLeaderboard(prepared);

  // All runs share identical complexity → no variance → emphasis disabled for every row
  // (mastery collapses to a uniform rescaling of raw outcomes, so ordering is preserved).
  for (const row of leaderboard.rows) {
    assert.equal(row.difficultyEmphasized, false, `${row.modelId} should not be difficulty-emphasized (zero variance)`);
  }
  // model-x (sat 5) still outranks model-y (sat 4) via the unadjusted expected-strength composite.
  const x = leaderboard.rows.find((r) => r.modelId === 'model-x')!;
  const y = leaderboard.rows.find((r) => r.modelId === 'model-y')!;
  assert.ok(x.rank! < y.rank!, 'higher-satisfaction model should still rank higher (no-op adjustment)');
});

test('leaderboard is provider-agnostic: collapses provider-specific ids sharing a family into one row', async () => {
  // The same underlying model is offered by multiple providers under different ids (e.g.
  // `umans-glm-5.2` via Umans and `glm-5.2:cloud` via Ollama Cloud are both GLM 5.2). models.json
  // declares them as siblings via the optional `family` field; prepare resolves `modelFamily` and
  // the leaderboard groups by it, while the backend keeps storing each provider-specific `modelId`.
  const fixture = deepClone(await loadFixture());
  const baseRun = fixture.completedRuns[0]!;
  fixture.completedRuns = [];
  fixture.openRuns = [];
  fixture.outcomes = [];

  function addScoredRun(runId: string, modelId: string): void {
    const run = deepClone(baseRun);
    run.runId = runId;
    run.taskGroupId = `${runId}-task`;
    run.modelId = modelId;
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

  // GLM 5.2 across two providers (3 scored runs each) — must collapse into ONE row.
  addScoredRun('umans-glm-a', 'umans-glm-5.2');
  addScoredRun('umans-glm-b', 'umans-glm-5.2');
  addScoredRun('umans-glm-c', 'umans-glm-5.2');
  addScoredRun('ollama-glm-a', 'glm-5.2:cloud');
  addScoredRun('ollama-glm-b', 'glm-5.2:cloud');
  addScoredRun('ollama-glm-c', 'glm-5.2:cloud');
  // A distinct model (different family) must NOT collapse with GLM 5.2.
  addScoredRun('gpt-a', 'gpt-5.2');
  addScoredRun('gpt-b', 'gpt-5.2');
  addScoredRun('gpt-c', 'gpt-5.2');

  const prepared = prepareSourceAnalytics(fixture);
  const leaderboard = createModelLeaderboard(prepared);

  const glmRow = leaderboard.rows.find((row) => row.modelId === 'glm-5.2');
  assert.ok(glmRow, 'GLM 5.2 should appear as a single provider-agnostic row');
  assert.equal(glmRow!.runCount, 6, 'both providers collapsed into one row');
  assert.equal(glmRow!.scoredRunCount, 6);
  assert.ok(glmRow!.rank !== null, 'collapsed row should be ranked');

  // Provider breakdown: both provider-specific ids surfaced so provider differences stay investigable.
  assert.equal(glmRow!.providers.length, 2, 'providers breakdown lists both provider-specific ids');
  assert.deepEqual(
    glmRow!.providers.map((p) => p.modelId).sort(),
    ['glm-5.2:cloud', 'umans-glm-5.2'],
  );
  for (const p of glmRow!.providers) {
    assert.equal(p.runCount, 3);
    assert.equal(p.scoredRunCount, 3);
  }
  // Breakdown reconciles with row totals — every run is attributed to exactly one provider id.
  assert.equal(glmRow!.providers.reduce((sum, p) => sum + p.runCount, 0), glmRow!.runCount);
  assert.equal(glmRow!.providers.reduce((sum, p) => sum + p.scoredRunCount, 0), glmRow!.scoredRunCount);

  // Distinct family stays a separate row (no over-collapsing).
  const gptRow = leaderboard.rows.find((row) => row.modelId === 'gpt-5.2');
  assert.ok(gptRow, 'GPT-5.2 should appear as its own row');
  assert.equal(gptRow!.runCount, 3);
  assert.equal(gptRow!.providers.length, 1);
  assert.equal(gptRow!.providers[0]!.modelId, 'gpt-5.2');

  // No provider-specific id leaks as its own row.
  assert.ok(
    !leaderboard.rows.some((row) => row.modelId === 'umans-glm-5.2'),
    'umans-glm-5.2 must not appear as its own row',
  );
  assert.ok(
    !leaderboard.rows.some((row) => row.modelId === 'glm-5.2:cloud'),
    'glm-5.2:cloud must not appear as its own row',
  );
});
