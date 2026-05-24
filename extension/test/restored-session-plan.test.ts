import test from 'node:test';
import assert from 'node:assert/strict';

import { buildRestoredSessionPlan } from '../src/host/session-service/restored-session-plan';

test('buildRestoredSessionPlan prefers the stored active session when it is still open', () => {
  const plan = buildRestoredSessionPlan(
    ['/workspace/a.jsonl', '/workspace/b.jsonl', '/workspace/c.jsonl'],
    '/workspace/b.jsonl',
  );

  assert.equal(plan.startupPath, '/workspace/b.jsonl');
  assert.deepEqual(plan.preloadPaths, ['/workspace/a.jsonl', '/workspace/c.jsonl']);
});

test('buildRestoredSessionPlan falls back to the first open tab when the stored active session is missing', () => {
  const plan = buildRestoredSessionPlan(
    ['/workspace/a.jsonl', '/workspace/b.jsonl'],
    '/workspace/missing.jsonl',
  );

  assert.equal(plan.startupPath, '/workspace/a.jsonl');
  assert.deepEqual(plan.preloadPaths, ['/workspace/b.jsonl']);
});

test('buildRestoredSessionPlan returns an empty plan when there are no restored tabs', () => {
  const plan = buildRestoredSessionPlan([], '/workspace/a.jsonl');

  assert.equal(plan.startupPath, null);
  assert.deepEqual(plan.preloadPaths, []);
});
