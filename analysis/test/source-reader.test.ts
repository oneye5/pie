import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import test from 'node:test';

import { RUN_ANALYTICS_SCHEMA_VERSION, type SourceAnalyticsPayload } from '../scripts/contracts.ts';
import { loadSourceAnalytics, readSourceAnalyticsPayload } from '../scripts/source.ts';
import { deepClone, loadFixture, withTempDir } from './helpers.ts';

test('readSourceAnalyticsPayload loads the committed fixture', async () => {
  const fixture = await loadFixture();
  assert.equal(fixture.schemaVersion, RUN_ANALYTICS_SCHEMA_VERSION);
  assert.equal(fixture.completedRuns.length, 7);
  assert.equal(fixture.openRuns.length, 2);
  assert.equal(fixture.outcomes.length, 5);
});

test('readSourceAnalyticsPayload rejects an invalid schema version', async () => {
  await withTempDir(async (dir) => {
    const invalidPayload: SourceAnalyticsPayload = {
      ...(await loadFixture()),
      schemaVersion: 999,
    };
    const filePath = path.join(dir, 'invalid.json');
    await fs.writeFile(filePath, JSON.stringify(invalidPayload), 'utf8');

    await assert.rejects(
      async () => await readSourceAnalyticsPayload(filePath),
      /Unsupported schemaVersion/,
    );
  });
});

test('loadSourceAnalytics can query a storage-dir run store', async () => {
  await withTempDir(async (dir) => {
    const fixture = await loadFixture();
    await fs.mkdir(dir, { recursive: true });
    const completedRuns = fixture.completedRuns.slice(0, 2);
    const openRun = fixture.openRuns[0];

    await fs.writeFile(
      path.join(dir, 'run-snapshots.jsonl'),
      completedRuns.map((run) => JSON.stringify({
        schemaVersion: RUN_ANALYTICS_SCHEMA_VERSION,
        kind: 'run_snapshot',
        recordedAt: run.updatedAt,
        run,
      })).join('\n') + '\n',
      'utf8',
    );
    await fs.writeFile(
      path.join(dir, 'outcome-history.jsonl'),
      fixture.outcomes.slice(0, 2).map((entry) => JSON.stringify(entry)).join('\n') + '\n',
      'utf8',
    );
    await fs.writeFile(path.join(dir, 'open-runs.gen'), 'a', 'utf8');
    await fs.writeFile(
      path.join(dir, 'open-runs.a.json'),
      JSON.stringify({
        schemaVersion: RUN_ANALYTICS_SCHEMA_VERSION,
        seq: 1,
        sessions: {
          [openRun.sessionPath]: {
            currentRun: openRun,
            lastRun: null,
            nextTaskIntent: null,
            queuedUnsupportedInputCount: 0,
            busyStartedAt: null,
          },
        },
      }, null, 2),
      'utf8',
    );

    const loaded = await loadSourceAnalytics({ storageDir: dir });
    assert.equal(loaded.sourceKind, 'storage-dir');
    assert.equal(loaded.source.completedRuns.length, 2);
    assert.equal(loaded.source.openRuns.length, 1);
    assert.equal(loaded.source.outcomes.length, 2);
    assert.equal(loaded.source.workspaceKey, path.basename(dir));
  });
});

test('missing optional fields are coerced safely', async () => {
  await withTempDir(async (dir) => {
    const fixture = deepClone(await loadFixture());
    delete (fixture.completedRuns[0] as Partial<typeof fixture.completedRuns[0]>).thinkingLevel;
    delete (fixture.completedRuns[0] as Partial<typeof fixture.completedRuns[0]>).analyticsFactors;
    const filePath = path.join(dir, 'missing-optionals.json');
    await fs.writeFile(filePath, JSON.stringify(fixture), 'utf8');

    const loaded = await readSourceAnalyticsPayload(filePath);
    assert.equal(loaded.completedRuns[0]?.thinkingLevel, undefined);
    assert.equal(loaded.completedRuns[0]?.analyticsFactors, null);
  });
});

test('max thinking level alias is accepted and normalized to xhigh', async () => {
  await withTempDir(async (dir) => {
    const fixture = deepClone(await loadFixture());
    (fixture.completedRuns[0] as any).thinkingLevel = 'max';
    const filePath = path.join(dir, 'max-thinking-level.json');
    await fs.writeFile(filePath, JSON.stringify(fixture), 'utf8');

    const loaded = await readSourceAnalyticsPayload(filePath);
    assert.equal(loaded.completedRuns[0]?.thinkingLevel, 'xhigh');
  });
});
