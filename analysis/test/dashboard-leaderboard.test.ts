import assert from 'node:assert/strict';
import test from 'node:test';

import { prepareSourceAnalytics } from '../scripts/prepare.ts';
import { createModelLeaderboard } from '../scripts/leaderboard.ts';
import { leaderboardRows } from '../site/app.ts';
import { deepClone, loadFixture } from './helpers.ts';

/**
 * The dashboard recomputes its leaderboard in-browser via `leaderboardRows` (independent of the
 * persisted `model-leaderboard.json`). This guards that the user-facing computation is also
 * provider-agnostic: provider-specific ids sharing a family collapse into one row, with a
 * `providersLabel` making the collapse visible — mirroring `createModelLeaderboard`.
 */
test('dashboard leaderboardRows is provider-agnostic: collapses provider-specific ids sharing a family into one row', async () => {
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
  const { composite } = leaderboardRows(prepared.runs);

  const glmRow = composite.find((row) => row.modelId === 'glm-5.2');
  assert.ok(glmRow, 'GLM 5.2 should appear as a single provider-agnostic row');
  assert.equal(glmRow!.runCount, 6, 'both providers collapsed into one row');
  assert.equal(glmRow!.scoredRunCount, 6);
  // The collapse is surfaced so provider differences stay investigable.
  assert.equal(
    glmRow!.providersLabel,
    '2 providers · glm-5.2:cloud, umans-glm-5.2',
    'providersLabel lists the collapsed provider-specific ids',
  );

  // Distinct family stays a separate row (no over-collapsing).
  const gptRow = composite.find((row) => row.modelId === 'gpt-5.2');
  assert.ok(gptRow, 'GPT-5.2 should appear as its own row');
  assert.equal(gptRow!.runCount, 3);
  // Single provider whose id equals the family → nothing to surface.
  assert.equal(gptRow!.providersLabel, '');

  // No provider-specific id leaks as its own row.
  assert.ok(
    !composite.some((row) => row.modelId === 'umans-glm-5.2'),
    'umans-glm-5.2 must not appear as its own row',
  );
  assert.ok(
    !composite.some((row) => row.modelId === 'glm-5.2:cloud'),
    'glm-5.2:cloud must not appear as its own row',
  );
});

/**
 * The dashboard recomputes its leaderboard in-browser via `leaderboardRows` independently of the
 * Node-side `createModelLeaderboard` that produces `model-leaderboard.json`. These two code paths
 * must agree: for the same prepared runs, every ranked model's composite score and each dimension's
 * shrunk estimate (including fileChurn, which is raw/inverted) must match within rounding. This
 * guards against drift between the two hand-mirrored implementations.
 */
test('dashboard leaderboardRows matches createModelLeaderboard composite and per-dimension shrunk estimates', async () => {
  const fixture = deepClone(await loadFixture());
  const baseRun = fixture.completedRuns[0]!;
  fixture.completedRuns = [];
  fixture.openRuns = [];
  fixture.outcomes = [];

  // Two models with varied file churn so the fileChurn dimension is non-null and differentiating,
  // plus differing satisfaction so every dimension is exercised. 3 scored runs each (>= minimum).
  const add = (modelId: string, map: Record<string, number>, satisfaction: number) => {
    for (let i = 0; i < 3; i++) {
      const run = deepClone(baseRun);
      run.runId = `${modelId}-p-${i}`;
      run.taskGroupId = `${modelId}-p-task-${i}`;
      run.modelId = modelId;
      run.thinkingLevel = 'high';
      run.status = 'scored';
      run.scored = true;
      run.finalizationReason = 'scored';
      run.finalizedAt = '2026-05-10T14:19:00.000Z';
      run.outcome = { resolution: 'resolved' as const, satisfaction };
      (run as any).fileMutation.editCountsByFile = map;
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
  };
  add('parity-low-churn', { 'file-a': 1 }, 5);   // no re-edits → churn 0
  add('parity-high-churn', { 'file-a': 5 }, 3);  // heavy re-editing → churn 0.8

  const prepared = prepareSourceAnalytics(fixture);
  const nodeLeaderboard = createModelLeaderboard(prepared);
  const dashboardResult = leaderboardRows(prepared.runs);
  const dashboardRows = dashboardResult.composite;

  // Build lookup by modelId for the dashboard (ranked rows only).
  const dashboardByModel = new Map(dashboardRows.map((r) => [r.modelId, r]));
  const dimNames = ['Satisfaction', 'Resolution', 'File churn', 'Tool reliability', 'Verification', 'Token efficiency'];

  for (const nodeRow of nodeLeaderboard.rows) {
    if (nodeRow.compositeScore === null) continue; // unranked rows aren't in the dashboard composite
    const dash = dashboardByModel.get(nodeRow.modelId);
    assert.ok(dash, `dashboard row missing for model ${nodeRow.modelId}`);

    assert.ok(
      Math.abs(nodeRow.compositeScore - dash.compositeScore) < 1e-3,
      `composite mismatch for ${nodeRow.modelId}: node=${nodeRow.compositeScore} dash=${dash.compositeScore}`,
    );

    // Per-dimension shrunk estimates. The dashboard emits one `dimensions` entry per non-null dim.
    const dashDims = new Map<string, number>();
    for (const entry of dashboardResult.dimensions.filter((d) => d.axisLabel === dash.axisLabel)) {
      dashDims.set(entry.dimension, entry.score);
    }
    const nodeDims = nodeRow.dimensions;
    const dimMap: Record<string, number | null> = {
      'Satisfaction': nodeDims.satisfaction.shrunk,
      'Resolution': nodeDims.resolutionRate.shrunk,
      'File churn': nodeDims.fileChurn.shrunk,
      'Tool reliability': nodeDims.toolReliability.shrunk,
      'Verification': nodeDims.verificationPassRate.shrunk,
      'Token efficiency': nodeDims.tokenEfficiency.shrunk,
    };
    for (const name of dimNames) {
      const nodeVal = dimMap[name];
      if (nodeVal === null) continue; // both omit null dims
      const dashVal = dashDims.get(name);
      assert.ok(dashVal !== undefined, `dashboard missing dimension "${name}" for ${nodeRow.modelId}`);
      assert.ok(
        Math.abs(nodeVal - dashVal) < 1e-3,
        `dimension "${name}" shrunk mismatch for ${nodeRow.modelId}: node=${nodeVal} dash=${dashVal}`,
      );
    }
  }
});
