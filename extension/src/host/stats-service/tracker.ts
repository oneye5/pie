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
  type TurnLatencyMeasurement,
  type TurnThroughputSample,
  type TurnThroughputStatus,
} from '../run-analytics';
import { SessionRunStateManager } from './run-state-manager';
import type { GetArchState, DispatchArchEvent } from './types';

const TOOL_FAILURE_SAMPLE_LIMIT = 20;

interface SessionRunTrackerOptions {
  getArchState: GetArchState;
  dispatchArchEvent: DispatchArchEvent;
  scheduleRender: () => void;
  schedulePersist: (snapshotToAppend?: RunSnapshot, outcomeToAppend?: OutcomeHistoryLogEntry) => void;
  now: () => Date;
  createId: () => string;
  getExperimentAssignment: () => string | null;
}

export class SessionRunTracker {
  private readonly getArchState: GetArchState;
  private readonly dispatchArchEvent: DispatchArchEvent;
  private readonly scheduleRender: () => void;
  private readonly runState: SessionRunStateManager;
  /**
   * Session paths currently mid-run (busy) across ALL sessions. Maintained on
   * the shared tracker instance so per-turn throughput samples can stamp how
   * many sessions were concurrently active — the multi-session load signal
   * for throughput / rate-limit-resilience analysis.
   */
  private readonly busySessionPaths = new Set<string>();

  constructor(options: SessionRunTrackerOptions) {
    this.getArchState = options.getArchState;
    this.dispatchArchEvent = options.dispatchArchEvent;
    this.scheduleRender = options.scheduleRender;
    this.runState = new SessionRunStateManager({
      getArchState: options.getArchState,
      dispatchArchEvent: options.dispatchArchEvent,
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
    state.endedTurnIdsInCurrentRun.clear();
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

  onAssistantTurnEnded(
    sessionPath: string,
    turnId: string,
    durationMs: number,
    usage?: AssistantUsage,
    status: TurnThroughputStatus = 'completed',
    latency?: TurnLatencyMeasurement,
  ): void {
    const state = this.runState.sessions.get(sessionPath);
    const run = state?.currentRun;
    if (!run || !state) {
      return;
    }

    if (!state.turnIdsSeenInCurrentRun.has(turnId)) {
      state.turnIdsSeenInCurrentRun.add(turnId);
      run.assistantTurnCount += 1;
    }

    // Ignore duplicate `message.finished` events for the same turn so duration,
    // token totals, and throughput samples are not double-counted.
    if (state.endedTurnIdsInCurrentRun.has(turnId)) {
      return;
    }
    state.endedTurnIdsInCurrentRun.add(turnId);

    const generationDurationMs = Math.max(0, Math.trunc(durationMs));
    run.assistantTurnDurationMs += generationDurationMs;
    const outputTokens = usage?.outputTokens ?? 0;
    if (usage) {
      run.inputTokens += usage.inputTokens;
      run.outputTokens += usage.outputTokens;
      run.cacheReadTokens += usage.cacheReadTokens;
      run.cacheWriteTokens += usage.cacheWriteTokens;
      run.tokenReportedTurnCount += 1;
      run.lastTurnUsage = usage;
    }

    // Record a throughput sample whenever the turn produced measurable
    // generation time or tokens, ended abnormally, or captured a turn-latency
    // measurement (any component — overhead alone still counts, e.g. a turn
    // that observed `turn_start` but produced no content delta). This keeps the
    // sum of sample durations / tokens aligned with the cumulative counters
    // above while still capturing errored turns (a rate-limit / failure signal)
    // and turns where latency was observable even if generation was negligible.
    const hasLatency = latency !== undefined
      && (latency.turnLatencyMs !== undefined
        || latency.overheadMs !== undefined
        || latency.providerLatencyMs !== undefined);
    if (generationDurationMs > 0 || outputTokens > 0 || status !== 'completed' || hasLatency) {
      const sample: TurnThroughputSample = {
        endedAt: this.runState.isoNow(),
        outputTokens,
        generationDurationMs,
        concurrentBusySessions: this.busySessionPaths.size,
        status,
        turnLatencyMs: latency?.turnLatencyMs ?? null,
        overheadMs: latency?.overheadMs ?? null,
        providerLatencyMs: latency?.providerLatencyMs ?? null,
      };
      run.turnThroughputSamples = [...run.turnThroughputSamples, sample];
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
    // Track concurrent busy sessions globally (before the run-state guard) so
    // the counter stays accurate even for sessions whose run snapshot hasn't
    // been created yet or has already been finalized.
    if (busy) {
      this.busySessionPaths.add(sessionPath);
    } else {
      this.busySessionPaths.delete(sessionPath);
    }

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
    this.busySessionPaths.delete(sessionPath);
    if (this.runState.sessions.get(sessionPath)?.currentRun) {
      this.runState.finalizeCurrentRun(sessionPath, 'closed_unscored');
    }
    this.runState.sessions.delete(sessionPath);
    this.dispatchArchEvent({ kind: 'ActiveRunSummaryChanged', sessionPath, summary: null });
    this.runState.persist();
    this.scheduleRender();
  }

  replaceSessionPath(oldPath: string, newPath: string): void {
    if (!oldPath || !newPath || oldPath === newPath) {
      return;
    }
    if (this.busySessionPaths.has(oldPath)) {
      this.busySessionPaths.delete(oldPath);
      this.busySessionPaths.add(newPath);
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
    this.busySessionPaths.clear();
  }
}
