import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { StatsService } from '../src/host/stats-service';
import { exportRunAnalyticsStore, queryRunAnalyticsStore } from '../src/host/run-analytics-query';
import { createAppStore, sessionStateActions, sessionsActions, settingsActions } from '../src/host/store';
import type { SessionAnalyticsFactors } from '../src/shared/protocol';

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-run-query-test-'));
  try {
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function getRunStorageDir(tempDir: string): Promise<string> {
  const runsRoot = path.join(tempDir, 'runs');
  const entries = await fs.readdir(runsRoot);
  assert.equal(entries.length, 1, 'expected one hashed workspace directory');
  return path.join(runsRoot, entries[0]);
}

const ANALYTICS_FACTORS: SessionAnalyticsFactors = {
  promptFamily: 'harness+customPrompt',
  promptHash: 'prompt-hash',
  harnessPromptHash: 'harness-hash',
  customPromptHash: 'custom-hash',
  appendSystemPromptHash: null,
  promptGuidelineHashes: [],
  contextFiles: [],
  selectedToolIds: ['bash'],
  toolSnippetHashes: [{ toolId: 'bash', hash: 'snippet-hash' }],
  toolSetHash: 'tool-set-hash',
  skills: [],
  skillSetHash: null,
};

test('queryRunAnalyticsStore returns finalized snapshots and checkpointed open runs', async () => {
  await withTempDir(async (tempDir) => {
    const store = createAppStore();
    const sessionPath = '/workspace/session-query.jsonl';
    let idCounter = 0;

    store.dispatch(sessionsActions.upsertSession({
      path: sessionPath,
      name: 'Query Session',
      cwd: '/workspace',
      modifiedAt: new Date().toISOString(),
      messageCount: 0,
      modelId: 'claude',
    }));
    store.dispatch(settingsActions.setModelSettings({
      defaultModel: 'claude',
      defaultThinkingLevel: 'medium',
    }));
    store.dispatch(sessionStateActions.setAnalyticsFactors({
      sessionPath,
      factors: ANALYTICS_FACTORS,
    }));

    const stats = new StatsService({
      globalStoragePath: tempDir,
      workspaceId: 'workspace-query',
      dispatch: store.dispatch,
      getState: store.getState,
      createId: () => `id-${++idCounter}`,
      getExperimentAssignment: () => 'treatment-a',
    });

    await stats.start();
    const firstRunId = stats.prepareForSend(sessionPath, []);
    stats.recordOutcome(sessionPath, { resolution: 'resolved', satisfaction: 5 });
    const secondRunId = stats.prepareForSend(sessionPath, []);
    await stats.flush();

    const storageDir = await getRunStorageDir(tempDir);
    const result = await queryRunAnalyticsStore(storageDir);

    assert.equal(firstRunId, 'id-1');
    assert.equal(secondRunId, 'id-3');
    assert.equal(result.completedRuns.length, 1);
    assert.equal(result.completedRuns[0]?.runId, 'id-1');
    assert.equal(result.completedRuns[0]?.experimentAssignment, 'treatment-a');
    assert.equal(result.completedRuns[0]?.analyticsFactors?.promptHash, 'prompt-hash');
    assert.equal(result.openRuns.length, 1);
    assert.equal(result.openRuns[0]?.runId, 'id-3');
    assert.equal(result.outcomes.length, 1);

    await stats.shutdown();
  });
});

test('exportRunAnalyticsStore writes a supported JSON export payload', async () => {
  await withTempDir(async (tempDir) => {
    const store = createAppStore();
    const sessionPath = '/workspace/session-export.jsonl';
    let idCounter = 0;

    store.dispatch(sessionsActions.upsertSession({
      path: sessionPath,
      name: 'Export Session',
      cwd: '/workspace',
      modifiedAt: new Date().toISOString(),
      messageCount: 0,
      modelId: 'gpt-4.1',
    }));
    store.dispatch(settingsActions.setModelSettings({
      defaultModel: 'gpt-4.1',
      defaultThinkingLevel: 'low',
    }));

    const stats = new StatsService({
      globalStoragePath: tempDir,
      workspaceId: 'workspace-export',
      dispatch: store.dispatch,
      getState: store.getState,
      createId: () => `id-${++idCounter}`,
    });

    await stats.start();
    stats.prepareForSend(sessionPath, []);
    stats.recordOutcome(sessionPath, { resolution: 'resolved', satisfaction: 4 });
    await stats.flush();

    const storageDir = await getRunStorageDir(tempDir);
    const targetPath = path.join(tempDir, 'analytics-export.json');
    const payload = await exportRunAnalyticsStore(storageDir, targetPath, () => new Date('2026-01-01T00:00:00.000Z'));
    const written = JSON.parse(await fs.readFile(targetPath, 'utf8')) as {
      schemaVersion: number;
      exportedAt: string;
      completedRuns: Array<{ runId: string }>;
      openRuns: unknown[];
      outcomes: Array<{ runId: string }>;
    };

    assert.equal(payload.completedRuns.length, 1);
    assert.equal(payload.openRuns.length, 0);
    assert.equal(written.schemaVersion, 1);
    assert.equal(written.exportedAt, '2026-01-01T00:00:00.000Z');
    assert.equal(written.completedRuns[0]?.runId, 'id-1');
    assert.equal(written.outcomes[0]?.runId, 'id-1');

    await stats.shutdown();
  });
});
