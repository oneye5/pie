import assert from 'node:assert/strict';
import test from 'node:test';

import { prepareSourceAnalytics } from '../scripts/prepare.ts';
import { deepClone, loadFixture } from './helpers.ts';

test('prepareSourceAnalytics builds the derived row model', async () => {
  const fixture = await loadFixture();
  const prepared = prepareSourceAnalytics(fixture);

  assert.equal(prepared.runs.length, 7);
  assert.ok(prepared.runs.every((run) => typeof run.sessionPathHash === 'string' && run.sessionPathHash.length === 16));
  assert.ok(prepared.toolUsage.some((row) => row.toolName === 'subagent'));
  assert.ok(prepared.verificationUsage.some((row) => row.kind === 'test'));
});

test('prepareSourceAnalytics exposes tool failure reason rows', async () => {
  const fixture = deepClone(await loadFixture());
  const run = fixture.completedRuns[0] as any;
  run.toolUsage.failureCountsByNameAndKind = {
    edit: { invalid_tool_arguments: 2 },
    bash: { verification_project_failure: 1 },
  };
  run.toolUsage.failureSamples = [{
    toolName: 'edit',
    failureKind: 'invalid_tool_arguments',
    exitCode: null,
    errorExcerpt: 'Could not find exact text in D:/repo/src/app.ts.',
    verificationKinds: [],
    occurredAt: run.startedAt,
  }];

  const prepared = prepareSourceAnalytics(fixture);

  assert.ok(prepared.toolFailures.some((row) => (
    row.runId === run.runId
    && row.toolName === 'edit'
    && row.failureKind === 'invalid_tool_arguments'
    && row.count === 2
    && row.errorExcerpt === 'Could not find exact text in D:/repo/src/app.ts.'
  )));
  assert.ok(prepared.toolFailures.some((row) => (
    row.runId === run.runId
    && row.toolName === 'bash'
    && row.failureKind === 'verification_project_failure'
    && row.count === 1
  )));
});

test('prepareSourceAnalytics normalizes max thinking level alias to xhigh', async () => {
  const fixture = deepClone(await loadFixture());
  (fixture.completedRuns[0] as any).thinkingLevel = 'max';

  const prepared = prepareSourceAnalytics(fixture);
  assert.equal(prepared.runs[0]?.thinkingLevel, 'xhigh');
});

test('prepareSourceAnalytics deduplicates run ids across completed and open snapshots', async () => {
  const fixture = deepClone(await loadFixture());
  const duplicateOpenRun = {
    ...fixture.completedRuns[0],
    status: 'open',
    scored: false,
    outcome: undefined,
    updatedAt: '2099-01-01T00:00:00.000Z',
  } as any;
  fixture.openRuns.push(duplicateOpenRun);

  const prepared = prepareSourceAnalytics(fixture);
  const duplicateRunId = fixture.completedRuns[0]?.runId;
  const matchingRuns = prepared.runs.filter((run) => run.runId === duplicateRunId);

  assert.equal(matchingRuns.length, 1);
  assert.equal(matchingRuns[0]?.status, fixture.completedRuns[0]?.status);
});
