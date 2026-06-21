import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LEADERBOARD_WEIGHTS,
  LEADERBOARD_DIFFICULTY_EMPHASIZED_DIMS,
  LEADERBOARD_MINIMUM_SCORED_RUNS,
  LEADERBOARD_SHRINKAGE_K,
  LEADERBOARD_TOKEN_EFFICIENCY_MAX,
} from '../scripts/leaderboard-scoring.ts';

test('LEADERBOARD_WEIGHTS dimensions sum to 1.0 (composite weighting invariant)', () => {
  // The composite score is a convex combination of the per-dimension point estimates,
  // so the weights must sum to exactly 1.0. This guards against silent drift if a
  // weight is rebalanced or a dimension is added/removed without re-normalizing.
  const total = Object.values(LEADERBOARD_WEIGHTS).reduce((sum, w) => sum + w, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, `composite weights must sum to 1.0, got ${total}`);
});

test('LEADERBOARD_WEIGHTS has the expected six dimensions, each with a positive weight', () => {
  // Known-answer structural pin: a rename/add/remove of a weighted dimension is
  // caught here rather than silently shifting the composite. Every weight must
  // also be strictly positive so no dimension is a no-op.
  assert.deepEqual(
    Object.keys(LEADERBOARD_WEIGHTS).sort(),
    ['firstAttemptSuccess', 'resolutionRate', 'satisfaction', 'tokenEfficiency', 'toolReliability', 'verificationPassRate'],
  );
  for (const [dim, weight] of Object.entries(LEADERBOARD_WEIGHTS)) {
    assert.ok(weight > 0, `weight for "${dim}" must be positive, got ${weight}`);
  }
});

test('LEADERBOARD_DIFFICULTY_EMPHASIZED_DIMS is a subset of the weighted dimensions', () => {
  // Every emphasized (complexity-weighted mastery) dimension must carry a weight;
  // otherwise a dimension could be "emphasized" without contributing to the score.
  const weighted = new Set(Object.keys(LEADERBOARD_WEIGHTS));
  for (const dim of LEADERBOARD_DIFFICULTY_EMPHASIZED_DIMS) {
    assert.ok(weighted.has(dim), `emphasized dim "${dim}" is missing from LEADERBOARD_WEIGHTS`);
  }
});

test('LEADERBOARD_DIFFICULTY_EMPHASIZED_DIMS contains exactly the four outcome mastery dimensions', () => {
  // Known-answer: the four outcome dimensions that measure "completing complex
  // tasks" are complexity-emphasized. toolReliability (process quality) and
  // tokenEfficiency (cost-adjacent efficiency) are deliberately left raw.
  assert.equal(LEADERBOARD_DIFFICULTY_EMPHASIZED_DIMS.size, 4);
  for (const dim of ['satisfaction', 'resolutionRate', 'firstAttemptSuccess', 'verificationPassRate']) {
    assert.ok(LEADERBOARD_DIFFICULTY_EMPHASIZED_DIMS.has(dim), `expected "${dim}" to be emphasized`);
  }
  assert.ok(!LEADERBOARD_DIFFICULTY_EMPHASIZED_DIMS.has('toolReliability'), 'toolReliability must NOT be emphasized');
  assert.ok(!LEADERBOARD_DIFFICULTY_EMPHASIZED_DIMS.has('tokenEfficiency'), 'tokenEfficiency must NOT be emphasized');
});

test('scalar scoring constants are positive with their known-answer values', () => {
  // Pin the small-sample gate, empirical-Bayes prior strength, and token-efficiency
  // saturation cap. Asserting exact values also proves each import resolved to a
  // real export (undefined would fail the > 0 checks).
  assert.equal(LEADERBOARD_MINIMUM_SCORED_RUNS, 3);
  assert.equal(LEADERBOARD_SHRINKAGE_K, 4);
  assert.equal(LEADERBOARD_TOKEN_EFFICIENCY_MAX, 50);
  assert.ok(LEADERBOARD_MINIMUM_SCORED_RUNS > 0);
  assert.ok(LEADERBOARD_SHRINKAGE_K > 0);
  assert.ok(LEADERBOARD_TOKEN_EFFICIENCY_MAX > 0);
});
