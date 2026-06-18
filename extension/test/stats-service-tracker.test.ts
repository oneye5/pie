import assert from 'node:assert/strict';
import test from 'node:test';

import { SessionRunTracker } from '../src/host/stats-service/tracker';
import { createInitialArchState } from '../src/host/core/arch-state';
import { reducer } from '../src/host/core/reducer';
import type { Event } from '../src/host/core/events';
import type { ArchState } from '../src/host/core/arch-state';
import type { ComposerInput, RunOutcome, SessionAnalyticsFactors } from '../src/shared/protocol';
import { produce } from 'immer';

function createHarness() {
  const sessionPath = '/workspace/session.jsonl';
  const persistCalls: Array<{ snapshot?: unknown; outcome?: unknown }> = [];
  let renderCount = 0;
  let idCounter = 0;
  let nowMs = Date.UTC(2026, 0, 1, 0, 0, 0);
  let experimentAssignment: string | null = 'control';

  let archState = createInitialArchState();
  // Seed session and model info
  archState = produce(archState, (draft) => {
    draft.sessions.sessions.push({
      path: sessionPath,
      name: 'Session',
      cwd: '/workspace',
      modifiedAt: new Date(nowMs).toISOString(),
      messageCount: 0,
      modelId: 'claude-test',
    });
    draft.settings.modelSettings = {
      defaultModel: 'claude-test',
      defaultThinkingLevel: 'medium',
    };
  });

  const getArchState = () => archState;
  const dispatchArchEvent = (event: Event) => {
    const result = reducer(archState, event);
    archState = result.state;
  };

  const tracker = new SessionRunTracker({
    getArchState,
    dispatchArchEvent,
    scheduleRender: () => {
      renderCount += 1;
    },
    schedulePersist: (snapshot, outcome) => {
      persistCalls.push({ snapshot, outcome });
    },
    now: () => new Date(nowMs),
    createId: () => `id-${++idCounter}`,
    getExperimentAssignment: () => experimentAssignment,
  });

  return {
    tracker,
    get archState() { return archState; },
    getArchState,
    sessionPath,
    persistCalls,
    get renderCount() {
      return renderCount;
    },
    advance(ms: number) {
      nowMs += ms;
    },
    setExperimentAssignment(value: string | null) {
      experimentAssignment = value;
    },
    setAnalyticsFactors(sessionPath: string, factors: SessionAnalyticsFactors) {
      dispatchArchEvent({ kind: 'AnalyticsFactorsChanged', sessionPath, factors });
    },
  };
}

const filesystemInput: ComposerInput = {
  id: 'input-1',
  kind: 'filesystemPathRef',
  path: '/workspace/src/index.ts',
  name: 'index.ts',
  source: 'picker',
};

const sampleFactors: SessionAnalyticsFactors = {
  promptFamily: 'harness+skills',
  promptHash: 'prompt-hash',
  promptCapturedAt: '2025-06-15T10:30:00.000Z',
  harnessPromptHash: 'harness-hash',
  customPromptHash: null,
  appendSystemPromptHash: null,
  promptGuidelineHashes: ['guideline-hash'],
  contextFiles: [{ path: '/workspace/AGENTS.md', hash: 'context-hash' }],
  selectedToolIds: ['read'],
  toolSnippetHashes: [{ toolId: 'read', hash: 'snippet-hash' }],
  toolSetHash: 'tool-set-hash',
  skills: [{ name: 'code-review', contentHash: 'content-hash', sourceHash: 'source-hash', disableModelInvocation: false, lastModifiedAt: null }],
  skillSetHash: 'skill-set-hash',
  activeExtensions: ['subagent'],
};

test('prepareForSend carries queued unsupported inputs and startNewTask closes the previous run', () => {
  const harness = createHarness();

  harness.tracker.onUnsupportedInputAttempt(harness.sessionPath);
  const firstRunId = harness.tracker.prepareForSend(harness.sessionPath, [filesystemInput]);
  harness.tracker.startNewTask(harness.sessionPath);
  const secondRunId = harness.tracker.prepareForSend(harness.sessionPath, []);

  const sessions = harness.tracker.serializeSessions();
  const currentRun = sessions[harness.sessionPath]?.currentRun;
  const lastRun = sessions[harness.sessionPath]?.lastRun;

  assert.equal(firstRunId, 'id-1');
  assert.equal(secondRunId, 'id-3');
  assert.equal(lastRun?.runId, 'id-1');
  assert.equal(lastRun?.finalizationReason, 'new_task');
  assert.equal(lastRun?.unsupportedInputCount, 1);
  assert.equal(currentRun?.runId, 'id-3');
  assert.equal(currentRun?.sendCount, 1);
  assert.equal(currentRun?.filesystemPathRefCount, 0);
  assert.equal(harness.archState.composer.activeRunSummaryBySession[harness.sessionPath]?.runId, 'id-3');
  assert.ok(harness.renderCount >= 3);
});

test('assistant turns, busy windows, unsupported inputs, and experiment assignment changes update the active run', () => {
  const harness = createHarness();
  harness.setAnalyticsFactors(harness.sessionPath, sampleFactors);

  const runId = harness.tracker.prepareForSend(harness.sessionPath, []);
  harness.tracker.onAssistantTurnStarted(harness.sessionPath, 'turn-1');
  harness.tracker.onAssistantTurnStarted(harness.sessionPath, 'turn-1');
  harness.advance(250);
  harness.tracker.onAssistantTurnEnded(harness.sessionPath, 'turn-1', 400, {
    inputTokens: 10,
    outputTokens: 20,
    cacheReadTokens: 5,
    cacheWriteTokens: 1,
    totalTokens: 36,
  });
  harness.tracker.onBusyChanged(harness.sessionPath, true);
  harness.advance(500);
  harness.tracker.onBusyChanged(harness.sessionPath, false);
  harness.tracker.onUnsupportedInputAttempt(harness.sessionPath);
  harness.setExperimentAssignment('variant-a');
  harness.tracker.onExperimentAssignmentChanged('variant-a');

  const currentRun = harness.tracker.serializeSessions()[harness.sessionPath]?.currentRun;
  assert.equal(runId, currentRun?.runId);
  assert.equal(currentRun?.assistantTurnCount, 1);
  assert.equal(currentRun?.assistantTurnDurationMs, 400);
  assert.equal(currentRun?.inputTokens, 10);
  assert.equal(currentRun?.outputTokens, 20);
  assert.equal(currentRun?.busyPeriodCount, 1);
  assert.equal(currentRun?.busyDurationMs, 500);
  assert.equal(currentRun?.unsupportedInputCount, 1);
  assert.equal(currentRun?.experimentAssignment, 'control');
  assert.equal(currentRun?.mixedTreatmentConfig, true);
  assert.deepEqual(currentRun?.treatmentChangeKinds, ['experimentAssignment']);

  const persistCountBefore = harness.persistCalls.length;
  harness.tracker.onExperimentAssignmentChanged('control');
  assert.equal(harness.persistCalls.length, persistCountBefore, 'unchanged assignments should not persist again');
});

test('replaceSessionPath, continueTask, and recordOutcome handle last-run state transitions', () => {
  const harness = createHarness();
  const runId = harness.tracker.prepareForSend(harness.sessionPath, []);
  const outcome: RunOutcome = { resolution: 'resolved', satisfaction: 5 };

  harness.tracker.continueTask(harness.sessionPath);
  harness.tracker.recordOutcome(harness.sessionPath, outcome);
  harness.tracker.replaceSessionPath(harness.sessionPath, '/workspace/renamed-session.jsonl');
  harness.tracker.replaceSessionPath('/missing', '/noop');
  harness.tracker.replaceSessionPath('/workspace/renamed-session.jsonl', '/workspace/renamed-session.jsonl');

  const sessions = harness.tracker.serializeSessions();
  const lastRun = sessions['/workspace/renamed-session.jsonl']?.lastRun;

  assert.equal(lastRun?.runId, runId);
  assert.equal(lastRun?.status, 'scored');
  assert.deepEqual(lastRun?.outcome, outcome);
  assert.equal(lastRun?.sessionPath, '/workspace/renamed-session.jsonl');
  assert.equal(harness.archState.composer.activeRunSummaryBySession[harness.sessionPath]?.status, 'scored');

  const persistCountBefore = harness.persistCalls.length;
  harness.tracker.recordOutcome('/workspace/renamed-session.jsonl', outcome);
  assert.equal(harness.persistCalls.length, persistCountBefore, 'recordOutcome should no-op once the last run is already scored');
});

test('tracker no-op guards and metadata updates behave correctly across inactive and active runs', () => {
  const harness = createHarness();

  harness.tracker.onAssistantTurnStarted(harness.sessionPath, 'no-run');
  harness.tracker.onAssistantTurnEnded(harness.sessionPath, 'no-run', 123);
  harness.tracker.onToolStarted(harness.sessionPath, { id: 'tool-1', name: 'bash', input: { command: 'echo ok' }, status: 'running' });
  harness.tracker.onToolFinished(harness.sessionPath, { id: 'tool-1', name: 'bash', input: { command: 'echo ok' }, status: 'completed' });
  harness.tracker.onInterrupted(harness.sessionPath);
  harness.tracker.onMessageEdited(harness.sessionPath);
  harness.tracker.onTruncatedAfter(harness.sessionPath);
  harness.tracker.onBackendError(undefined, 'MISSING_SESSION');
  harness.tracker.onContextUsageChanged(harness.sessionPath, 10, 100);
  harness.tracker.onBusyChanged(harness.sessionPath, false);
  harness.tracker.onSessionAnalyticsFactorsChanged(harness.sessionPath, sampleFactors);
  assert.equal(harness.persistCalls.length, 0, 'no current run means no persistence side effects');

  harness.setAnalyticsFactors(harness.sessionPath, sampleFactors);
  const runId = harness.tracker.prepareForSend(harness.sessionPath, []);
  harness.tracker.onBackendError(harness.sessionPath, 'MESSAGE_SEND_FAILED');
  harness.tracker.onContextUsageChanged(harness.sessionPath, 50, 200);
  harness.tracker.onInterrupted(harness.sessionPath);
  harness.tracker.onMessageEdited(harness.sessionPath);
  harness.tracker.onTruncatedAfter(harness.sessionPath);
  harness.tracker.onModelConfigChanged(harness.sessionPath, 'claude-test', 'medium');
  harness.tracker.onModelConfigChanged(harness.sessionPath, 'model-b', 'high');
  harness.tracker.onSessionAnalyticsFactorsChanged(harness.sessionPath, sampleFactors);
  harness.tracker.onSessionAnalyticsFactorsChanged(harness.sessionPath, {
    ...sampleFactors,
    toolSetHash: 'tool-set-hash-2',
    activeExtensions: ['subagent', 'skill-pruner'],
  });

  const currentRun = harness.tracker.serializeSessions()[harness.sessionPath]?.currentRun;
  assert.equal(currentRun?.runId, runId);
  assert.deepEqual(currentRun?.backendErrorCodes, ['MESSAGE_SEND_FAILED']);
  assert.equal(currentRun?.contextTokens, 50);
  assert.equal(currentRun?.contextLimit, 200);
  assert.equal(currentRun?.interruptedCount, 1);
  assert.equal(currentRun?.messageEditCount, 1);
  assert.equal(currentRun?.truncatedAfterCount, 1);
  assert.equal(currentRun?.mixedModelConfig, true);
  assert.deepEqual(currentRun?.treatmentChangeKinds, ['model', 'thinking', 'toolSelection', 'extensions']);
});

test('onSessionClosed and finalizeOpenRunsForShutdown close active runs and clear summaries', () => {
  const harness = createHarness();

  harness.tracker.prepareForSend(harness.sessionPath, []);
  harness.tracker.onSessionClosed(harness.sessionPath);
  assert.equal(harness.tracker.serializeSessions()[harness.sessionPath], undefined);
  assert.equal(harness.archState.composer.activeRunSummaryBySession[harness.sessionPath], null);

  const second = createHarness();
  second.tracker.prepareForSend(second.sessionPath, []);
  second.tracker.finalizeOpenRunsForShutdown();

  const finalized = second.tracker.serializeSessions()[second.sessionPath]?.lastRun;
  assert.equal(finalized?.status, 'closed_unscored');
  assert.equal(finalized?.finalizationReason, 'closed_unscored');
});