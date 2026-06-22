import assert from 'node:assert/strict';
import test from 'node:test';

import { prepareSourceAnalytics } from '../scripts/prepare.ts';
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
