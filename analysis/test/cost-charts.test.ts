import assert from 'node:assert/strict';
import test from 'node:test';

import type { PreparedRunRow } from '../scripts/contracts.ts';
import { groupCostByModel } from '../site/charts/cost.ts';

/**
 * Minimal run factory: `groupCostByModel` only reads `status`, `modelId`,
 * `sessionPathHash`, and `estimatedCostUsd`, so the other PreparedRunRow fields
 * are irrelevant to this unit and are omitted via an `unknown` cast.
 */
function mkRun(model: string, session: string, cost: number | null, status = 'completed'): PreparedRunRow {
  return { status, modelId: model, sessionPathHash: session, estimatedCostUsd: cost } as unknown as PreparedRunRow;
}

function approx(actual: number, expected: number, epsilon = 1e-9): void {
  assert.ok(Math.abs(actual - expected) < epsilon, `expected ~${expected}, got ${actual}`);
}

test('groupCostByModel rolls runs up by session before averaging (per-session ≠ per-run)', () => {
  // Model "alpha": session s1 has 2 runs (0.10 + 0.20 = 0.30), session s2 has 1 run (0.05).
  // Per-session subtotals = [0.30, 0.05]; per-run costs = [0.10, 0.20, 0.05].
  const rows = groupCostByModel([
    mkRun('alpha', 's1', 0.10),
    mkRun('alpha', 's1', 0.20),
    mkRun('alpha', 's2', 0.05),
  ]);
  assert.equal(rows.length, 1);
  const alpha = rows[0]!;
  approx(alpha.totalCostUsd, 0.35);
  approx(alpha.avgCostUsdPerSession, 0.175); // (0.30 + 0.05) / 2
  approx(alpha.medianCostUsdPerSession, 0.175); // midpoint of [0.05, 0.30]
  approx(alpha.medianCostUsdPerRun, 0.10); // midpoint of [0.05, 0.10, 0.20]
  assert.equal(alpha.sessionCount, 2);
  assert.equal(alpha.withCostCount, 3);
  assert.equal(alpha.runCount, 3);

  // The whole point: averaging per run instead would give 0.35 / 3 ≈ 0.1167,
  // not 0.175 — confirming the per-session rollup is what's being computed.
  assert.notEqual(alpha.avgCostUsdPerSession, 0.1167);
});

test('groupCostByModel treats each single-run session as its own unit', () => {
  // Three sessions, one run each — here per-session == per-run.
  const rows = groupCostByModel([
    mkRun('beta', 's1', 0.10),
    mkRun('beta', 's2', 0.20),
    mkRun('beta', 's3', 0.05),
  ]);
  const beta = rows[0]!;
  approx(beta.totalCostUsd, 0.35);
  approx(beta.avgCostUsdPerSession, 0.1167); // 0.35 / 3, rounded to 4 dp
  approx(beta.medianCostUsdPerSession, 0.10);
  assert.equal(beta.sessionCount, 3);
});

test('groupCostByModel reports zero cost and zero sessions for models with no pricing', () => {
  const rows = groupCostByModel([
    mkRun('gamma', 's1', null),
    mkRun('gamma', 's2', null),
  ]);
  const gamma = rows[0]!;
  assert.equal(gamma.totalCostUsd, 0);
  assert.equal(gamma.avgCostUsdPerSession, 0);
  assert.equal(gamma.sessionCount, 0);
  assert.equal(gamma.withCostCount, 0);
  assert.equal(gamma.runCount, 2);
});

test('groupCostByModel excludes open runs', () => {
  const rows = groupCostByModel([
    mkRun('alpha', 's1', 0.10, 'completed'),
    mkRun('alpha', 's2', 0.20, 'open'), // ignored
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.runCount, 1);
  assert.equal(rows[0]!.sessionCount, 1);
  approx(rows[0]!.totalCostUsd, 0.10);
});

test('groupCostByModel sorts by total spend descending and caps at 12 models', () => {
  const runs: PreparedRunRow[] = [];
  for (let i = 0; i < 13; i += 1) {
    // Higher index → higher cost, so model 12 should top the list.
    runs.push(mkRun(`model-${i}`, `s-${i}`, i + 1));
  }
  const rows = groupCostByModel(runs);
  assert.equal(rows.length, 12, 'should cap at 12 models');
  assert.equal(rows[0]!.model, 'model-12', 'highest-spend model first');
});
