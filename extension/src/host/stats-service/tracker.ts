import {
  analyzeToolCall,
  incrementNamedCount,
  mergeFileMutationDelta,
  normalizeToolCallName,
  type ToolFailureKind,
} from '../../shared/tool-call-analysis';
import type {
  AssistantUsage,
  ComposerInput,
  RunOutcome,
  SessionAnalyticsFactors,
  ThinkingLevel,
  ToolCall,
} from '../../shared/protocol';
import { appendUnique, summarizeInputs } from './helpers';
import {
  normalizeExperimentAssignment,
  type OutcomeHistoryLogEntry,
  type RunSnapshot,
  type TreatmentChangeKind,
} from '../run-analytics';
import { SessionRunStateManager } from './run-state-manager';
import type { GetArchState, MutateArchState } from './types';

const TOOL_FAILURE_SAMPLE_LIMIT = 20;

interface SessionRunTrackerOptions {
  getArchState: GetArchState;
  mutateArchState: MutateArchState;
  scheduleRender: () => void;
  schedulePersist: (snapshotToAppend?: RunSnapshot, outcomeToAppend?: OutcomeHistoryLogEntry) => void;
  now: () => Date;
  createId: () => string;
  getExperimentAssignment: () => string | null;
}

export class SessionRunTracker {
  private readonly getArchState: GetArchState;
  private readonly mutateArchState: MutateArchState;
  private readonly scheduleRender: () => void;
  private readonly runState: SessionRunStateManager;

  constructor(options: SessionRunTrackerOptions) {
    this.getArchState = options.getArchState;
    this.mutateArchState = options.mutateArchState;
    this.scheduleRender = options.scheduleRender;
    this.runState = new SessionRunStateManager({
      getArchState: options.getArchState,
      mutateArchState: options.mutateArchState,
      schedulePersist: options.schedulePersist,
      now: options.now,
      createId: options.createId,
      getExperimentAssignment: options.getExperimentAssignment,
    });
  }

  restore(checkpointSessions: Parameters<SessionRunStateManager['restore']>[0]): void {
    this.runState.restore(checkpointSessions);
  }

  serializeSessions(): ReturnType<SessionRunStateManager['serializeSessions']> {
    return this.runState.serializeSessions();
  }

  prepareForSend(sessionPath: string, inputs: ComposerInput[]): string {
    const state = this.runState.getOrCreateSessionState(sessionPath);

    if (state.currentRun) {
      this.runState.finalizeCurrentRun(
        sessionPath,
        state.nextTaskIntent === 'new_task' ? 'new_task' : 'closed_unscored',
      );
    }

    const run = this.runState.createRunSnapshot(sessionPath, state);
    state.currentRun = run;
    state.turnIdsSeenInCurrentRun.clear();
    state.busyStartedAt = null;

    run.sendCount += 1;
    run.updatedAt = this.runState.isoNow();
    summarizeInputs(run, inputs);
    if (state.queuedUnsupportedInputCount > 0) {
      run.unsupportedInputCount += state.queuedUnsupportedInputCount;
      state.queuedUnsupportedInputCount = 0;
    }
    state.nextTaskIntent = null;

    this.runState.syncSessionSummary(sessionPath);
    this.runState.persist();
    this.scheduleRender();
    return run.runId;
  }

  onAssistantTurnStarted(sessionPath: string, turnId: string): void {
    const state = this.runState.sessions.get(sessionPath);
    const run = state?.currentRun;
    if (!run || !state) {
      return;
    }

    if (!state.turnIdsSeenInCurrentRun.has(turnId)) {
      state.turnIdsSeenInCurrentRun.add(turnId);
      run.assistantTurnCount += 1;
      run.updatedAt = this.runState.isoNow();
      this.runState.persist();
    }
  }

  onAssistantTurnEnded(sessionPath: string, turnId: string, durationMs: number, usage?: AssistantUsage): void {
    const state = this.runState.sessions.get(sessionPath);
    const run = state?.currentRun;
    if (!run || !state) {
      return;
    }

    if (!state.turnIdsSeenInCurrentRun.has(turnId)) {
      state.turnIdsSeenInCurrentRun.add(turnId);
      run.assistantTurnCount += 1;
    }

    run.assistantTurnDurationMs += Math.max(0, Math.trunc(durationMs));
    if (usage) {
      run.inputTokens += usage.inputTokens;
      run.outputTokens += usage.outputTokens;
      run.cacheReadTokens += usage.cacheReadTokens;
      run.cacheWriteTokens += usage.cacheWriteTokens;
      run.tokenReportedTurnCount += 1;
      run.lastTurnUsage = usage;
    }
    run.updatedAt = this.runState.isoNow();
    this.runState.persist();
  }

  onToolStarted(sessionPath: string, toolCall: ToolCall): void {
    const run = this.runState.sessions.get(sessionPath)?.currentRun;
    if (!run) {
      return;
    }

    const normalizedName = normalizeToolCallName(toolCall.name) || toolCall.name;
    run.toolUsage.totalCount += 1;
    incrementNamedCount(run.toolUsage.countsByName, normalizedName);
    run.updatedAt = this.runState.isoNow();
    this.runState.persist();
  }

  onToolFinished(sessionPath: string, toolCall: ToolCall): void {
    const run = this.runState.sessions.get(sessionPath)?.currentRun;
    if (!run) {
      return;
    }

    const normalizedName = normalizeToolCallName(toolCall.name) || toolCall.name || '(unknown)';
    const analysis = analyzeToolCall(toolCall);

    if (typeof toolCall.durationMs === 'number' && Number.isFinite(toolCall.durationMs) && toolCall.durationMs >= 0) {
      const durationMs = Math.trunc(toolCall.durationMs);
      run.toolUsage.totalDurationMs += durationMs;
      run.toolUsage.timedCallCount += 1;
      run.toolUsage.durationMsByName[normalizedName] =
        (run.toolUsage.durationMsByName[normalizedName] ?? 0) + durationMs;
    }

    if (toolCall.status === 'failed') {
      run.toolUsage.failureCount += 1;
      incrementNamedCount(run.toolUsage.failureCountsByName, normalizedName);

      const failureKind = analysis.failure?.kind ?? 'unknown';
      incrementNamedCount(run.toolUsage.failureCountsByKind, failureKind);
      const countsForTool = run.toolUsage.failureCountsByNameAndKind[normalizedName] ?? {} as Record<ToolFailureKind, number>;
      run.toolUsage.failureCountsByNameAndKind[normalizedName] = countsForTool;
      incrementNamedCount(countsForTool, failureKind);

      if (failureKind === 'verification_project_failure') {
        run.toolUsage.verificationProjectFailureCount += 1;
      } else if (failureKind === 'probe_no_match') {
        run.toolUsage.probeFailureCount += 1;
      } else {
        run.toolUsage.executionFailureCount += 1;
      }

      if (run.toolUsage.failureSamples.length < TOOL_FAILURE_SAMPLE_LIMIT) {
        run.toolUsage.failureSamples.push({
          toolName: normalizedName,
          failureKind,
          exitCode: analysis.failure?.exitCode ?? null,
          errorExcerpt: analysis.failure?.errorExcerpt ?? '',
          verificationKinds: analysis.verificationKinds,
          occurredAt: this.runState.isoNow(),
        });
      }
    }

    if (analysis.subagentCallCount > 0) {
      run.toolUsage.subagentCallCount += analysis.subagentCallCount;
      run.toolUsage.subagentTaskCount += analysis.subagentTaskCount;
      run.toolUsage.subagentAgentNames = appendUnique(
        run.toolUsage.subagentAgentNames,
        analysis.subagentAgentNames,
      );
      run.toolUsage.subagentScoredTaskCount += analysis.subagentScoredTaskCount;
      const dims = ['precision', 'creativity', 'reasoning', 'thoroughness'] as const;
      for (const dim of dims) {
        const src = analysis.subagentTaskScores[dim];
        const dst = run.toolUsage.subagentTaskScores[dim];
        dst.sum   += src.sum;
        dst.count += src.count;
        dst.max   = Math.max(dst.max, src.max);
      }
    }

    if (analysis.verificationKinds.length > 0) {
      run.verification.totalCount += analysis.verificationKinds.length;
      for (const kind of analysis.verificationKinds) {
        run.verification.countsByKind[kind] += 1;
      }
      if (toolCall.status === 'failed') {
        run.verification.failureCount += analysis.verificationKinds.length;
      }
    }

    if (toolCall.status !== 'failed') {
      run.fileMutation = mergeFileMutationDelta(run.fileMutation, analysis.fileMutation);

      if (analysis.fileExtension) {
        const { extension, operation } = analysis.fileExtension;
        const target = operation === 'read' ? run.fileExtensions.readCountsByExtension
          : operation === 'write' ? run.fileExtensions.writeCountsByExtension
          : run.fileExtensions.editCountsByExtension;
        incrementNamedCount(target, extension);
      }
    }

    run.updatedAt = this.runState.isoNow();
    this.runState.persist();
  }

  onInterrupted(sessionPath: string): void {
    const run = this.runState.sessions.get(sessionPath)?.currentRun;
    if (!run) {
      return;
    }

    run.interruptedCount += 1;
    run.updatedAt = this.runState.isoNow();
    this.runState.persist();
  }

  onMessageEdited(sessionPath: string): void {
    const run = this.runState.getMostRelevantRun(sessionPath);
    if (!run) {
      return;
    }

    run.messageEditCount += 1;
    run.updatedAt = this.runState.isoNow();
    this.runState.persist();
  }

  onTruncatedAfter(sessionPath: string): void {
    const run = this.runState.getMostRelevantRun(sessionPath);
    if (!run) {
      return;
    }

    run.truncatedAfterCount += 1;
    run.updatedAt = this.runState.isoNow();
    this.runState.persist();
  }

  onBackendError(sessionPath: string | undefined, code: string): void {
    if (!sessionPath) {
      return;
    }
    const run = this.runState.getMostRelevantRun(sessionPath);
    if (!run) {
      return;
    }

    run.backendErrorCodes = [...run.backendErrorCodes, code];
    run.updatedAt = this.runState.isoNow();
    this.runState.persist();
  }

  onContextUsageChanged(sessionPath: string, tokens: number | null, limit: number): void {
    const run = this.runState.sessions.get(sessionPath)?.currentRun;
    if (!run) {
      return;
    }

    run.contextTokens = tokens;
    run.contextLimit = limit;
    run.updatedAt = this.runState.isoNow();
    this.runState.persist();
  }

  onBusyChanged(sessionPath: string, busy: boolean): void {
    const state = this.runState.sessions.get(sessionPath);
    const run = state?.currentRun;
    if (!state || !run) {
      return;
    }

    if (busy) {
      if (!state.busyStartedAt) {
        state.busyStartedAt = this.runState.isoNow();
        run.busyPeriodCount += 1;
        run.updatedAt = this.runState.isoNow();
        this.runState.persist();
      }
      return;
    }

    if (this.runState.closeBusyInterval(state)) {
      run.updatedAt = this.runState.isoNow();
      this.runState.persist();
    }
  }

  onModelConfigChanged(
    sessionPath: string,
    modelId: string | undefined,
    thinkingLevel: ThinkingLevel | undefined,
  ): void {
    const run = this.runState.sessions.get(sessionPath)?.currentRun;
    if (!run) {
      return;
    }

    const changedKinds: TreatmentChangeKind[] = [];
    if ((run.modelId ?? null) !== (modelId ?? null)) {
      changedKinds.push('model');
    }
    if ((run.thinkingLevel ?? null) !== (thinkingLevel ?? null)) {
      changedKinds.push('thinking');
    }
    if (changedKinds.length === 0) {
      return;
    }

    run.mixedModelConfig = true;
    this.runState.markTreatmentChanges(run, changedKinds);
    run.updatedAt = this.runState.isoNow();
    this.runState.persist();
  }

  onSessionAnalyticsFactorsChanged(sessionPath: string, factors: SessionAnalyticsFactors | null): void {
    const run = this.runState.sessions.get(sessionPath)?.currentRun;
    if (!run || !run.analyticsFactors || !factors) {
      return;
    }

    const changedKinds = this.runState.diffAnalyticsFactors(run.analyticsFactors, factors);
    if (changedKinds.length === 0) {
      return;
    }

    this.runState.markTreatmentChanges(run, changedKinds);
    run.updatedAt = this.runState.isoNow();
    this.runState.persist();
  }

  onUnsupportedInputAttempt(sessionPath: string): void {
    const state = this.runState.getOrCreateSessionState(sessionPath);
    if (state.currentRun) {
      state.currentRun.unsupportedInputCount += 1;
      state.currentRun.updatedAt = this.runState.isoNow();
    } else {
      state.queuedUnsupportedInputCount += 1;
    }
    this.runState.persist();
  }

  onSessionClosed(sessionPath: string): void {
    if (this.runState.sessions.get(sessionPath)?.currentRun) {
      this.runState.finalizeCurrentRun(sessionPath, 'closed_unscored');
    }
    this.runState.sessions.delete(sessionPath);
    this.mutateArchState((draft) => {
      draft.composer.activeRunSummaryBySession[sessionPath] = null;
    });
    this.runState.persist();
    this.scheduleRender();
  }

  replaceSessionPath(oldPath: string, newPath: string): void {
    if (!oldPath || !newPath || oldPath === newPath) {
      return;
    }
    const state = this.runState.sessions.get(oldPath);
    if (!state) {
      return;
    }

    if (state.currentRun) {
      state.currentRun = { ...state.currentRun, sessionPath: newPath };
    }
    if (state.lastRun) {
      state.lastRun = { ...state.lastRun, sessionPath: newPath };
    }

    this.runState.sessions.delete(oldPath);
    this.runState.sessions.set(newPath, state);
    this.runState.persist();
  }

  recordOutcome(sessionPath: string, outcome: RunOutcome): void {
    const state = this.runState.getOrCreateSessionState(sessionPath);

    if (state.currentRun) {
      this.runState.finalizeCurrentRun(sessionPath, 'scored', outcome);
      this.scheduleRender();
      return;
    }

    if (!state.lastRun || state.lastRun.status !== 'closed_unscored') {
      return;
    }

    const updatedRun: RunSnapshot = {
      ...state.lastRun,
      status: 'scored',
      scored: true,
      outcome,
      finalizationReason: 'scored',
      finalizedAt: state.lastRun.finalizedAt ?? this.runState.isoNow(),
      updatedAt: this.runState.isoNow(),
    };
    state.lastRun = updatedRun;

    this.runState.syncSessionSummary(sessionPath);
    this.runState.persist(
      updatedRun,
      this.runState.buildOutcomeHistoryEntry(updatedRun, outcome),
    );
    this.scheduleRender();
  }

  startNewTask(sessionPath: string): void {
    const state = this.runState.getOrCreateSessionState(sessionPath);
    if (state.nextTaskIntent === 'new_task') {
      return;
    }

    state.nextTaskIntent = 'new_task';
    this.runState.syncSessionSummary(sessionPath);
    this.runState.persist();
    this.scheduleRender();
  }

  continueTask(sessionPath: string): void {
    const state = this.runState.getOrCreateSessionState(sessionPath);
    if (state.nextTaskIntent === 'continue_task') {
      return;
    }

    state.nextTaskIntent = 'continue_task';
    this.runState.syncSessionSummary(sessionPath);
    this.runState.persist();
    this.scheduleRender();
  }

  onExperimentAssignmentChanged(assignment: string | null): void {
    const normalized = normalizeExperimentAssignment(assignment);
    let changed = false;
    for (const state of this.runState.sessions.values()) {
      const run = state.currentRun;
      if (!run || run.experimentAssignment === normalized) {
        continue;
      }
      this.runState.markTreatmentChanges(run, ['experimentAssignment']);
      run.updatedAt = this.runState.isoNow();
      changed = true;
    }
    if (changed) {
      this.runState.persist();
    }
  }

  finalizeOpenRunsForShutdown(): void {
    const openSessionPaths = [...this.runState.sessions.entries()]
      .filter(([, state]) => !!state.currentRun)
      .map(([sessionPath]) => sessionPath);

    for (const sessionPath of openSessionPaths) {
      this.runState.finalizeCurrentRun(sessionPath, 'closed_unscored');
    }
  }
}
