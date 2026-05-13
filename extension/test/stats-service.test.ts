import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { StatsService } from '../src/host/stats-service';
import { createAppStore, sessionStateActions, sessionsActions, settingsActions } from '../src/host/store';
import type { ComposerInput } from '../src/shared/protocol';

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-stats-test-'));
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

async function readJsonl(filePath: string): Promise<unknown[]> {
  const raw = await fs.readFile(filePath, 'utf8');
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

test('StatsService records run outcomes and persists snapshot metrics', async () => {
  await withTempDir(async (tempDir) => {
    const store = createAppStore();
    const sessionPath = '/workspace/session-a.jsonl';
    let idCounter = 0;

    store.dispatch(sessionsActions.upsertSession({
      path: sessionPath,
      name: 'Session A',
      cwd: '/workspace',
      modifiedAt: new Date().toISOString(),
      messageCount: 0,
      modelId: 'claude-3.7',
    }));
    store.dispatch(settingsActions.setModelSettings({
      defaultModel: 'claude-3.7',
      defaultThinkingLevel: 'medium',
    }));

    const stats = new StatsService({
      globalStoragePath: tempDir,
      workspaceId: 'workspace-a',
      dispatch: store.dispatch,
      getState: store.getState,
      createId: () => `id-${++idCounter}`,
    });

    await stats.start();

    const inputs: ComposerInput[] = [
      {
        id: 'input-1',
        kind: 'filesystemPathRef',
        path: '/workspace/src/index.ts',
        name: 'index.ts',
        source: 'picker',
      },
      {
        id: 'input-2',
        kind: 'imageBlob',
        mimeType: 'image/png',
        name: 'diagram.png',
        sizeBytes: 2048,
        dataBase64: 'ZmFrZQ==',
        width: 64,
        height: 64,
        source: 'paste',
      },
    ];

    const runId = stats.prepareForSend(sessionPath, inputs);
    assert.equal(runId, 'id-1');
    assert.deepEqual(store.getState().sessionState.activeRunSummaryBySession[sessionPath], {
      runId: 'id-1',
      status: 'open',
      scored: false,
    });

    stats.onAssistantTurnStarted(sessionPath, 'req-1');
    stats.onAssistantTurnEnded(sessionPath, 'req-1', 1200);
    stats.onContextUsageChanged(sessionPath, 8000, 200000);
    stats.recordOutcome(sessionPath, { resolution: 'resolved', satisfaction: 5 });

    assert.deepEqual(store.getState().sessionState.activeRunSummaryBySession[sessionPath], {
      runId: 'id-1',
      status: 'scored',
      scored: true,
    });

    await stats.shutdown();

    const storageDir = await getRunStorageDir(tempDir);
    const snapshotEntries = await readJsonl(path.join(storageDir, 'run-snapshots.jsonl')) as Array<{
      kind: string;
      run: {
        runId: string;
        taskGroupId: string;
        status: string;
        scored: boolean;
        sendCount: number;
        assistantTurnCount: number;
        assistantTurnDurationMs: number;
        filesystemPathRefCount: number;
        imageInputCount: number;
        imageInputBytes: number;
        contextTokens: number | null;
        contextLimit: number | null;
        outcome?: { resolution: string; satisfaction: number };
      };
    }>;
    const outcomeEntries = await readJsonl(path.join(storageDir, 'outcome-history.jsonl')) as Array<{
      kind: string;
      runId: string;
      taskGroupId: string;
      outcome: { resolution: string; satisfaction: number };
    }>;

    assert.equal(snapshotEntries.length, 1);
    assert.equal(snapshotEntries[0].kind, 'run_snapshot');
    assert.equal(snapshotEntries[0].run.runId, 'id-1');
    assert.equal(snapshotEntries[0].run.taskGroupId, 'id-2');
    assert.equal(snapshotEntries[0].run.status, 'scored');
    assert.equal(snapshotEntries[0].run.scored, true);
    assert.equal(snapshotEntries[0].run.sendCount, 1);
    assert.equal(snapshotEntries[0].run.assistantTurnCount, 1);
    assert.equal(snapshotEntries[0].run.assistantTurnDurationMs, 1200);
    assert.equal(snapshotEntries[0].run.filesystemPathRefCount, 1);
    assert.equal(snapshotEntries[0].run.imageInputCount, 1);
    assert.equal(snapshotEntries[0].run.imageInputBytes, 2048);
    assert.equal(snapshotEntries[0].run.contextTokens, 8000);
    assert.equal(snapshotEntries[0].run.contextLimit, 200000);
    assert.deepEqual(snapshotEntries[0].run.outcome, { resolution: 'resolved', satisfaction: 5 });

    assert.equal(outcomeEntries.length, 1);
    assert.equal(outcomeEntries[0].kind, 'run_outcome');
    assert.equal(outcomeEntries[0].runId, 'id-1');
    assert.equal(outcomeEntries[0].taskGroupId, 'id-2');
    assert.deepEqual(outcomeEntries[0].outcome, { resolution: 'resolved', satisfaction: 5 });
  });
});

test('StatsService starts a new task group on the next send after startNewTask', async () => {
  await withTempDir(async (tempDir) => {
    const store = createAppStore();
    const sessionPath = '/workspace/session-b.jsonl';
    let idCounter = 0;

    store.dispatch(sessionsActions.upsertSession({
      path: sessionPath,
      name: 'Session B',
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
      workspaceId: 'workspace-b',
      dispatch: store.dispatch,
      getState: store.getState,
      createId: () => `id-${++idCounter}`,
    });

    await stats.start();

    const firstRunId = stats.prepareForSend(sessionPath, []);
    stats.startNewTask(sessionPath);
    const secondRunId = stats.prepareForSend(sessionPath, []);

    assert.equal(firstRunId, 'id-1');
    assert.equal(secondRunId, 'id-3');
    assert.deepEqual(store.getState().sessionState.activeRunSummaryBySession[sessionPath], {
      runId: 'id-3',
      status: 'open',
      scored: false,
    });

    await stats.shutdown();

    const storageDir = await getRunStorageDir(tempDir);
    const snapshotEntries = await readJsonl(path.join(storageDir, 'run-snapshots.jsonl')) as Array<{
      run: {
        runId: string;
        taskGroupId: string;
        finalizationReason?: string;
        status: string;
      };
    }>;

    assert.equal(snapshotEntries.length, 2, 'first run closes on new-task boundary; second closes on shutdown');
    assert.equal(snapshotEntries[0].run.runId, 'id-1');
    assert.equal(snapshotEntries[0].run.taskGroupId, 'id-2');
    assert.equal(snapshotEntries[0].run.finalizationReason, 'new_task');
    assert.equal(snapshotEntries[0].run.status, 'closed_unscored');
    assert.equal(snapshotEntries[1].run.runId, 'id-3');
    assert.equal(snapshotEntries[1].run.taskGroupId, 'id-4');
    assert.equal(snapshotEntries[1].run.finalizationReason, 'closed_unscored');
  });
});

test('StatsService restores active run summaries from checkpointed state', async () => {
  await withTempDir(async (tempDir) => {
    const firstStore = createAppStore();
    const secondStore = createAppStore();
    const sessionPath = '/workspace/session-c.jsonl';

    for (const store of [firstStore, secondStore]) {
      store.dispatch(sessionsActions.upsertSession({
        path: sessionPath,
        name: 'Session C',
        cwd: '/workspace',
        modifiedAt: new Date().toISOString(),
        messageCount: 0,
        modelId: 'claude',
      }));
      store.dispatch(settingsActions.setModelSettings({
        defaultModel: 'claude',
        defaultThinkingLevel: 'minimal',
      }));
    }

    let idCounter = 0;
    const firstStats = new StatsService({
      globalStoragePath: tempDir,
      workspaceId: 'workspace-c',
      dispatch: firstStore.dispatch,
      getState: firstStore.getState,
      createId: () => `id-${++idCounter}`,
    });

    await firstStats.start();
    firstStats.prepareForSend(sessionPath, []);
    await firstStats.flush();

    const secondStats = new StatsService({
      globalStoragePath: tempDir,
      workspaceId: 'workspace-c',
      dispatch: secondStore.dispatch,
      getState: secondStore.getState,
    });

    await secondStats.start();

    assert.deepEqual(secondStore.getState().sessionState.activeRunSummaryBySession[sessionPath], {
      runId: 'id-1',
      status: 'open',
      scored: false,
    });

    await firstStats.shutdown();
    await secondStats.shutdown();
    secondStore.dispatch(sessionStateActions.setActiveRunSummary({ sessionPath, summary: null }));
  });
});

test('StatsService counts multiple assistant turns using distinct turn ids within one run', async () => {
  await withTempDir(async (tempDir) => {
    const store = createAppStore();
    const sessionPath = '/workspace/session-d.jsonl';
    let idCounter = 0;

    store.dispatch(sessionsActions.upsertSession({
      path: sessionPath,
      name: 'Session D',
      cwd: '/workspace',
      modifiedAt: new Date().toISOString(),
      messageCount: 0,
      modelId: 'claude',
    }));
    store.dispatch(settingsActions.setModelSettings({
      defaultModel: 'claude',
      defaultThinkingLevel: 'medium',
    }));

    const stats = new StatsService({
      globalStoragePath: tempDir,
      workspaceId: 'workspace-d',
      dispatch: store.dispatch,
      getState: store.getState,
      createId: () => `id-${++idCounter}`,
    });

    await stats.start();
    stats.prepareForSend(sessionPath, []);
    stats.onAssistantTurnStarted(sessionPath, 'req-1:1');
    stats.onAssistantTurnEnded(sessionPath, 'req-1:1', 400);
    stats.onAssistantTurnStarted(sessionPath, 'req-1:2');
    stats.onAssistantTurnEnded(sessionPath, 'req-1:2', 600);
    stats.recordOutcome(sessionPath, { resolution: 'resolved', satisfaction: 4 });
    await stats.shutdown();

    const storageDir = await getRunStorageDir(tempDir);
    const snapshotEntries = await readJsonl(path.join(storageDir, 'run-snapshots.jsonl')) as Array<{
      run: {
        assistantTurnCount: number;
        assistantTurnDurationMs: number;
      };
    }>;

    assert.equal(snapshotEntries.length, 1);
    assert.equal(snapshotEntries[0].run.assistantTurnCount, 2);
    assert.equal(snapshotEntries[0].run.assistantTurnDurationMs, 1000);
  });
});

test('StatsService marks runs mixed when model config changes mid-run', async () => {
  await withTempDir(async (tempDir) => {
    const store = createAppStore();
    const sessionPath = '/workspace/session-e.jsonl';
    let idCounter = 0;

    store.dispatch(sessionsActions.upsertSession({
      path: sessionPath,
      name: 'Session E',
      cwd: '/workspace',
      modifiedAt: new Date().toISOString(),
      messageCount: 0,
      modelId: 'claude',
    }));
    store.dispatch(settingsActions.setModelSettings({
      defaultModel: 'claude',
      defaultThinkingLevel: 'medium',
    }));

    const stats = new StatsService({
      globalStoragePath: tempDir,
      workspaceId: 'workspace-e',
      dispatch: store.dispatch,
      getState: store.getState,
      createId: () => `id-${++idCounter}`,
    });

    await stats.start();
    stats.prepareForSend(sessionPath, []);
    stats.onModelConfigChanged(sessionPath, 'gpt-4.1', 'high');
    stats.recordOutcome(sessionPath, { resolution: 'resolved', satisfaction: 4 });
    await stats.shutdown();

    const storageDir = await getRunStorageDir(tempDir);
    const snapshotEntries = await readJsonl(path.join(storageDir, 'run-snapshots.jsonl')) as Array<{
      run: {
        mixedModelConfig: boolean;
      };
    }>;

    assert.equal(snapshotEntries.length, 1);
    assert.equal(snapshotEntries[0].run.mixedModelConfig, true);
  });
});

test('StatsService carries unsupported input attempts into the next run snapshot', async () => {
  await withTempDir(async (tempDir) => {
    const store = createAppStore();
    const sessionPath = '/workspace/session-f.jsonl';
    let idCounter = 0;

    store.dispatch(sessionsActions.upsertSession({
      path: sessionPath,
      name: 'Session F',
      cwd: '/workspace',
      modifiedAt: new Date().toISOString(),
      messageCount: 0,
      modelId: 'claude',
    }));
    store.dispatch(settingsActions.setModelSettings({
      defaultModel: 'claude',
      defaultThinkingLevel: 'medium',
    }));

    const stats = new StatsService({
      globalStoragePath: tempDir,
      workspaceId: 'workspace-f',
      dispatch: store.dispatch,
      getState: store.getState,
      createId: () => `id-${++idCounter}`,
    });

    await stats.start();
    stats.onUnsupportedInputAttempt(sessionPath);
    stats.prepareForSend(sessionPath, []);
    stats.recordOutcome(sessionPath, { resolution: 'resolved', satisfaction: 4 });
    await stats.shutdown();

    const storageDir = await getRunStorageDir(tempDir);
    const snapshotEntries = await readJsonl(path.join(storageDir, 'run-snapshots.jsonl')) as Array<{
      run: {
        unsupportedInputCount: number;
      };
    }>;

    assert.equal(snapshotEntries.length, 1);
    assert.equal(snapshotEntries[0].run.unsupportedInputCount, 1);
  });
});

test('StatsService captures structured analytics factors and experiment assignment at run start', async () => {
  await withTempDir(async (tempDir) => {
    const store = createAppStore();
    const sessionPath = '/workspace/session-g.jsonl';
    let idCounter = 0;

    store.dispatch(sessionsActions.upsertSession({
      path: sessionPath,
      name: 'Session G',
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
      factors: {
        promptFamily: 'harness+customPrompt',
        promptHash: 'prompt-hash',
        harnessPromptHash: 'harness-hash',
        customPromptHash: 'custom-hash',
        appendSystemPromptHash: null,
        promptGuidelineHashes: ['guideline-hash'],
        contextFiles: [{ path: '/workspace/context.md', hash: 'context-hash' }],
        selectedToolIds: ['bash'],
        toolSnippetHashes: [{ toolId: 'bash', hash: 'snippet-hash' }],
        toolSetHash: 'tool-set-hash',
        skills: [{
          name: 'verification-before-completion',
          contentHash: 'skill-hash',
          sourceHash: 'skill-source-hash',
          disableModelInvocation: false,
        }],
        skillSetHash: 'skill-set-hash',
      },
    }));

    const stats = new StatsService({
      globalStoragePath: tempDir,
      workspaceId: 'workspace-g',
      dispatch: store.dispatch,
      getState: store.getState,
      createId: () => `id-${++idCounter}`,
      getExperimentAssignment: () => 'exp-a',
    });

    await stats.start();
    stats.prepareForSend(sessionPath, []);
    stats.recordOutcome(sessionPath, { resolution: 'resolved', satisfaction: 5 });
    await stats.shutdown();

    const storageDir = await getRunStorageDir(tempDir);
    const snapshotEntries = await readJsonl(path.join(storageDir, 'run-snapshots.jsonl')) as Array<{
      run: {
        experimentAssignment: string | null;
        analyticsFactors: { promptHash: string; skillSetHash: string | null } | null;
      };
    }>;

    assert.equal(snapshotEntries.length, 1);
    assert.equal(snapshotEntries[0].run.experimentAssignment, 'exp-a');
    assert.equal(snapshotEntries[0].run.analyticsFactors?.promptHash, 'prompt-hash');
    assert.equal(snapshotEntries[0].run.analyticsFactors?.skillSetHash, 'skill-set-hash');
  });
});

test('StatsService rolls up tool usage, verification commands, subagents, and file mutations', async () => {
  await withTempDir(async (tempDir) => {
    const store = createAppStore();
    const sessionPath = '/workspace/session-h.jsonl';
    let idCounter = 0;

    store.dispatch(sessionsActions.upsertSession({
      path: sessionPath,
      name: 'Session H',
      cwd: '/workspace',
      modifiedAt: new Date().toISOString(),
      messageCount: 0,
      modelId: 'claude',
    }));
    store.dispatch(settingsActions.setModelSettings({
      defaultModel: 'claude',
      defaultThinkingLevel: 'medium',
    }));

    const stats = new StatsService({
      globalStoragePath: tempDir,
      workspaceId: 'workspace-h',
      dispatch: store.dispatch,
      getState: store.getState,
      createId: () => `id-${++idCounter}`,
    });

    await stats.start();
    stats.prepareForSend(sessionPath, []);

    const failedVerificationTool = {
      id: 'tool-1',
      name: 'bash',
      input: { command: 'npm test -- --runInBand' },
      result: { exitCode: 1 },
      status: 'failed' as const,
    };
    stats.onToolStarted(sessionPath, { ...failedVerificationTool, result: undefined, status: 'running' });
    stats.onToolFinished(sessionPath, failedVerificationTool);

    const subagentTool = {
      id: 'tool-2',
      name: 'subagent',
      input: {
        tasks: [
          { agent: 'scout', task: 'Trace tool events' },
          { agent: 'reviewer', task: 'Check analytics snapshot' },
        ],
      },
      result: 'done',
      status: 'completed' as const,
    };
    stats.onToolStarted(sessionPath, { ...subagentTool, result: undefined, status: 'running' });
    stats.onToolFinished(sessionPath, subagentTool);

    const mutationTool = {
      id: 'tool-3',
      name: 'edit',
      input: {
        path: '/workspace/src/main.ts',
        edits: [{
          oldText: 'const value = 1;\nconst next = 2;\n',
          newText: 'const value = 10;\nconst next = 20;\n',
        }],
      },
      result: 'patched',
      status: 'completed' as const,
    };
    stats.onToolStarted(sessionPath, { ...mutationTool, result: undefined, status: 'running' });
    stats.onToolFinished(sessionPath, mutationTool);

    stats.recordOutcome(sessionPath, { resolution: 'resolved', satisfaction: 4 });
    await stats.shutdown();

    const storageDir = await getRunStorageDir(tempDir);
    const snapshotEntries = await readJsonl(path.join(storageDir, 'run-snapshots.jsonl')) as Array<{
      run: {
        toolUsage: {
          totalCount: number;
          failureCount: number;
          countsByName: Record<string, number>;
          subagentCallCount: number;
          subagentTaskCount: number;
          subagentAgentNames: string[];
        };
        verification: {
          totalCount: number;
          failureCount: number;
          countsByKind: Record<string, number>;
        };
        fileMutation: {
          editCount: number;
          lineModifications: number;
        };
      };
    }>;

    assert.equal(snapshotEntries.length, 1);
    assert.equal(snapshotEntries[0].run.toolUsage.totalCount, 3);
    assert.equal(snapshotEntries[0].run.toolUsage.failureCount, 1);
    assert.equal(snapshotEntries[0].run.toolUsage.countsByName['bash'], 1);
    assert.equal(snapshotEntries[0].run.toolUsage.subagentCallCount, 1);
    assert.equal(snapshotEntries[0].run.toolUsage.subagentTaskCount, 2);
    assert.deepEqual(snapshotEntries[0].run.toolUsage.subagentAgentNames, ['scout', 'reviewer']);
    assert.equal(snapshotEntries[0].run.verification.totalCount, 1);
    assert.equal(snapshotEntries[0].run.verification.failureCount, 1);
    assert.equal(snapshotEntries[0].run.verification.countsByKind['test'], 1);
    assert.equal(snapshotEntries[0].run.fileMutation.editCount, 1);
    assert.equal(snapshotEntries[0].run.fileMutation.lineModifications, 2);
  });
});

test('StatsService tracks busy durations and mixed treatment changes', async () => {
  await withTempDir(async (tempDir) => {
    const store = createAppStore();
    const sessionPath = '/workspace/session-i.jsonl';
    let idCounter = 0;
    let currentMs = 0;

    store.dispatch(sessionsActions.upsertSession({
      path: sessionPath,
      name: 'Session I',
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
      factors: {
        promptFamily: 'harness',
        promptHash: 'prompt-a',
        harnessPromptHash: 'harness-a',
        customPromptHash: null,
        appendSystemPromptHash: null,
        promptGuidelineHashes: [],
        contextFiles: [],
        selectedToolIds: ['bash'],
        toolSnippetHashes: [],
        toolSetHash: 'tools-a',
        skills: [],
        skillSetHash: null,
      },
    }));

    const stats = new StatsService({
      globalStoragePath: tempDir,
      workspaceId: 'workspace-i',
      dispatch: store.dispatch,
      getState: store.getState,
      createId: () => `id-${++idCounter}`,
      now: () => new Date(currentMs),
      getExperimentAssignment: () => 'exp-a',
    });

    await stats.start();
    stats.prepareForSend(sessionPath, []);

    currentMs = 1000;
    stats.onBusyChanged(sessionPath, true);
    currentMs = 2500;
    stats.onBusyChanged(sessionPath, false);
    currentMs = 3000;
    stats.onBusyChanged(sessionPath, true);
    currentMs = 4200;
    stats.onBusyChanged(sessionPath, false);

    stats.onSessionAnalyticsFactorsChanged(sessionPath, {
      promptFamily: 'harness+customPrompt',
      promptHash: 'prompt-b',
      harnessPromptHash: 'harness-a',
      customPromptHash: 'custom-b',
      appendSystemPromptHash: null,
      promptGuidelineHashes: [],
      contextFiles: [],
      selectedToolIds: ['bash'],
      toolSnippetHashes: [],
      toolSetHash: 'tools-a',
      skills: [],
      skillSetHash: null,
    });
    stats.onExperimentAssignmentChanged('exp-b');
    stats.recordOutcome(sessionPath, { resolution: 'resolved', satisfaction: 4 });
    await stats.shutdown();

    const storageDir = await getRunStorageDir(tempDir);
    const snapshotEntries = await readJsonl(path.join(storageDir, 'run-snapshots.jsonl')) as Array<{
      run: {
        busyDurationMs: number;
        busyPeriodCount: number;
        mixedTreatmentConfig: boolean;
        treatmentChangeKinds: string[];
      };
    }>;

    assert.equal(snapshotEntries.length, 1);
    assert.equal(snapshotEntries[0].run.busyDurationMs, 2700);
    assert.equal(snapshotEntries[0].run.busyPeriodCount, 2);
    assert.equal(snapshotEntries[0].run.mixedTreatmentConfig, true);
    assert.deepEqual(snapshotEntries[0].run.treatmentChangeKinds, ['prompt', 'experimentAssignment']);
  });
});
