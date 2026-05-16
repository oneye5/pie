import assert from 'node:assert/strict';
import test from 'node:test';

import { prepareSourceAnalytics } from '../scripts/prepare.ts';
import type { PreparedRunRow } from '../scripts/contracts.ts';
import { deepClone, loadFixture } from './helpers.ts';

test('prepareSourceAnalytics builds the derived row model', async () => {
  const fixture = await loadFixture();
  const prepared = prepareSourceAnalytics(fixture);

  assert.equal(prepared.runs.length, 8);
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

test('prepareSourceAnalytics uses failureCountsByKind fallback when per-tool breakdown is absent', async () => {
  const fixture = await loadFixture();
  const prepared = prepareSourceAnalytics(fixture);

  // run-008 has failures with failureCountsByKind but no failureCountsByNameAndKind
  const unattributedRows = prepared.toolFailures.filter(
    (row) => row.runId === 'run-008' && row.toolName === '(unattributed)',
  );
  assert.ok(unattributedRows.length > 0, 'should emit unattributed rows when per-tool breakdown is absent');

  const missingFile = unattributedRows.find((row) => row.failureKind === 'missing_file_or_path');
  assert.ok(missingFile, 'should classify missing_file_or_path from aggregate counts');
  assert.equal(missingFile.count, 1);

  const nonzeroExit = unattributedRows.find((row) => row.failureKind === 'nonzero_exit');
  assert.ok(nonzeroExit, 'should classify nonzero_exit from aggregate counts');
  assert.equal(nonzeroExit.count, 1);

  // Also verify that classified failures from runs WITH per-tool breakdown are still correct
  const run002FailureRows = prepared.toolFailures.filter((row) => row.runId === 'run-002');
  const verifProject = run002FailureRows.find((r) => r.failureKind === 'verification_project_failure');
  assert.ok(verifProject, 'run-002 should have verification_project_failure');
  assert.equal(verifProject.count, 1);
});

test('prepareSourceAnalytics extracts file extension rows from run data', async () => {
  const fixture = await loadFixture();
  const prepared = prepareSourceAnalytics(fixture);

  assert.ok(prepared.fileExtensions.length > 0, 'should produce file extension rows');

  const tsRow = prepared.fileExtensions.find((row) => row.extension === '.ts' && row.runId === 'run-001');
  assert.ok(tsRow, 'should have a .ts extension row for run-001');
  assert.equal(tsRow.readCount, 2);
  assert.equal(tsRow.writeCount, 1);
  assert.equal(tsRow.editCount, 1);
  assert.equal(tsRow.totalCount, 4);

  const mdRow = prepared.fileExtensions.find((row) => row.extension === '.md' && row.runId === 'run-001');
  assert.ok(mdRow, 'should have a .md extension row for run-001');
  assert.equal(mdRow.readCount, 1);
  assert.equal(mdRow.writeCount, 0);
  assert.equal(mdRow.editCount, 0);
  assert.equal(mdRow.totalCount, 1);
});

test('prepareSourceAnalytics computes derived efficiency metrics', async () => {
  const fixture = await loadFixture();
  const prepared = prepareSourceAnalytics(fixture);

  const byId = new Map<string, PreparedRunRow>(prepared.runs.map((r) => [r.runId, r]));

  // run-001: output=3200, lmt=33 → tokenEfficiency=96.97; cacheRead=4800, input=15200 → ratio=0.24
  //          ctx=18200/200000=0.091; interrupted=0, edited=1 → firstAttemptSuccess=false
  const r1 = byId.get('run-001')!;
  assert.ok(Math.abs(r1.tokenEfficiency! - 3200 / 33) < 0.01);
  assert.ok(Math.abs(r1.cacheHitRatio! - 4800 / (4800 + 15200)) < 0.001);
  assert.ok(Math.abs(r1.contextUtilization! - 18200 / 200000) < 0.001);
  assert.equal(r1.firstAttemptSuccess, false);

  // run-003: output=0, lmt=35 → tokenEfficiency=0; both tokens 0 → cacheHitRatio=null
  //          ctx=16800/200000; interrupted=0, edited=0, truncated=0, resolved → firstAttemptSuccess=true
  const r3 = byId.get('run-003')!;
  assert.equal(r3.tokenEfficiency, 0);
  assert.equal(r3.cacheHitRatio, null);
  assert.ok(Math.abs(r3.contextUtilization! - 16800 / 200000) < 0.001);
  assert.equal(r3.firstAttemptSuccess, true);

  // run-004: lmt=0 → tokenEfficiency=null; no outcome → firstAttemptSuccess=false
  const r4 = byId.get('run-004')!;
  assert.equal(r4.tokenEfficiency, null);
  assert.equal(r4.firstAttemptSuccess, false);

  // run-005: cacheRead=0, input=24500 → cacheHitRatio=0; interrupted=1 → firstAttemptSuccess=false
  const r5 = byId.get('run-005')!;
  assert.equal(r5.cacheHitRatio, 0);
  assert.equal(r5.firstAttemptSuccess, false);

  // run-006: contextTokens=null → contextUtilization=null
  const r6 = byId.get('run-006')!;
  assert.equal(r6.contextUtilization, null);
});

test('prepareSourceAnalytics sets tokenEfficiency to null when lineMutationTotal is zero', async () => {
  const fixture = deepClone(await loadFixture());
  (fixture.completedRuns[0] as any).fileMutation.lineAdditions = 0;
  (fixture.completedRuns[0] as any).fileMutation.lineDeletions = 0;
  (fixture.completedRuns[0] as any).fileMutation.lineModifications = 0;

  const prepared = prepareSourceAnalytics(fixture);
  const r = prepared.runs[0]!;
  assert.equal(r.tokenEfficiency, null);
  // cacheHitRatio unaffected by line mutations
  assert.ok(r.cacheHitRatio !== null);
});
