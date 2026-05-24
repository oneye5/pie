import type {
  ModelSettings,
  RunOutcome,
  SessionAnalyticsFactors,
  ThinkingLevel,
} from '../../shared/protocol';
import {
  appendUnique,
  areStringArraysEqual,
  toActiveRunSummary,
  toPersistedSessionState,
} from './helpers';
import {
  RUN_ANALYTICS_SCHEMA_VERSION,
  createEmptyFileExtensionRollup,
  createEmptyFileMutationRollup,
  createEmptyToolUsageRollup,
  createEmptyVerificationRollup,
  normalizeExperimentAssignment,
  type OutcomeHistoryLogEntry,
  type PersistedSessionRunState,
  type RunFinalizationReason,
  type RunSnapshot,
  type TreatmentChangeKind,
} from '../run-analytics';
import {
  getSessionByPath,
  sessionStateActions,
  type AppStore,
  type RootState,
} from '../store';
import {
  emptySessionRunState,
  type SessionRunState,
} from './types';

interface SessionRunStateManagerOptions {
  dispatch: AppStore['dispatch'];
  getState: () => RootState;
  schedulePersist: (snapshotToAppend?: RunSnapshot, outcomeToAppend?: OutcomeHistoryLogEntry) => void;
  now: () => Date;
  createId: () => string;
  getExperimentAssignment: () => string | null;
}

export class SessionRunStateManager {
  readonly sessions = new Map<string, SessionRunState>();
  private readonly dispatch: AppStore['dispatch'];
  private readonly getState: () => RootState;
  private readonly schedulePersistCallback: SessionRunStateManagerOptions['schedulePersist'];
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly getExperimentAssignment: () => string | null;

  constructor(options: SessionRunStateManagerOptions) {
    this.dispatch = options.dispatch;
    this.getState = options.getState;
    this.schedulePersistCallback = options.schedulePersist;
    this.now = options.now;
    this.createId = options.createId;
    this.getExperimentAssignment = options.getExperimentAssignment;
  }

  restore(checkpointSessions: Record<string, PersistedSessionRunState>): void {
    this.sessions.clear();
    for (const [sessionPath, sessionState] of Object.entries(checkpointSessions)) {
      this.sessions.set(sessionPath, {
        currentRun: sessionState.currentRun,
        lastRun: sessionState.lastRun,
        nextTaskIntent: sessionState.nextTaskIntent,
        queuedUnsupportedInputCount: sessionState.queuedUnsupportedInputCount,
        turnIdsSeenInCurrentRun: new Set<string>(),
        busyStartedAt: sessionState.busyStartedAt,
      });
      this.syncSessionSummary(sessionPath);
    }
  }

  serializeSessions(): Record<string, PersistedSessionRunState> {
    const sessions: Record<string, PersistedSessionRunState> = {};
    for (const [sessionPath, state] of this.sessions) {
      sessions[sessionPath] = toPersistedSessionState(state);
    }
    return sessions;
  }

  getOrCreateSessionState(sessionPath: string): SessionRunState {
    let state = this.sessions.get(sessionPath);
    if (!state) {
      state = emptySessionRunState();
      this.sessions.set(sessionPath, state);
    }
    return state;
  }

  getMostRelevantRun(sessionPath: string): RunSnapshot | null {
    const state = this.sessions.get(sessionPath);
    if (!state) {
      return null;
    }
    return state.currentRun ?? state.lastRun;
  }

  createRunSnapshot(sessionPath: string, state: SessionRunState): RunSnapshot {
    const nowIso = this.isoNow();
    const currentConfig = this.getCurrentModelConfig(sessionPath);
    const shouldStartNewTaskGroup = state.nextTaskIntent === 'new_task' || !state.lastRun?.taskGroupId;

    return {
      sessionPath,
      runId: this.createId(),
      taskGroupId: shouldStartNewTaskGroup ? this.createId() : (state.lastRun?.taskGroupId ?? this.createId()),
      status: 'open',
      scored: false,
      startedAt: nowIso,
      updatedAt: nowIso,
      modelId: currentConfig.modelId,
      thinkingLevel: currentConfig.thinkingLevel,
      mixedModelConfig: false,
      mixedTreatmentConfig: false,
      treatmentChangeKinds: [],
      experimentAssignment: normalizeExperimentAssignment(this.getExperimentAssignment()),
      analyticsFactors: this.getCurrentAnalyticsFactors(sessionPath),
      sendCount: 0,
      assistantTurnCount: 0,
      assistantTurnDurationMs: 0,
      busyDurationMs: 0,
      busyPeriodCount: 0,
      interruptedCount: 0,
      messageEditCount: 0,
      truncatedAfterCount: 0,
      backendErrorCodes: [],
      contextTokens: null,
      contextLimit: null,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      tokenReportedTurnCount: 0,
      lastTurnUsage: null,
      filesystemPathRefCount: 0,
      imageInputCount: 0,
      imageInputBytes: 0,
      unsupportedInputCount: 0,
      inputKindsUsed: [],
      toolUsage: createEmptyToolUsageRollup(),
      fileMutation: createEmptyFileMutationRollup(),
      fileExtensions: createEmptyFileExtensionRollup(),
      verification: createEmptyVerificationRollup(),
    };
  }

  finalizeCurrentRun(
    sessionPath: string,
    reason: RunFinalizationReason,
    outcome?: RunOutcome,
  ): RunSnapshot | null {
    const state = this.sessions.get(sessionPath);
    const currentRun = state?.currentRun;
    if (!state || !currentRun) {
      return null;
    }

    this.closeBusyInterval(state);

    const finalizedAt = this.isoNow();
    const finalizedRun: RunSnapshot = {
      ...currentRun,
      status: outcome ? 'scored' : 'closed_unscored',
      scored: !!outcome,
      outcome,
      finalizationReason: reason === 'scored' ? 'scored' : reason,
      finalizedAt,
      updatedAt: finalizedAt,
    };

    state.currentRun = null;
    state.lastRun = finalizedRun;
    state.turnIdsSeenInCurrentRun.clear();
    state.busyStartedAt = null;

    this.syncSessionSummary(sessionPath);
    this.persist(
      finalizedRun,
      outcome ? this.buildOutcomeHistoryEntry(finalizedRun, outcome) : undefined,
    );
    return finalizedRun;
  }

  markTreatmentChanges(run: RunSnapshot, kinds: TreatmentChangeKind[]): void {
    if (kinds.length === 0) {
      return;
    }

    run.mixedTreatmentConfig = true;
    run.treatmentChangeKinds = appendUnique(run.treatmentChangeKinds, kinds);
  }

  diffAnalyticsFactors(
    current: SessionAnalyticsFactors,
    next: SessionAnalyticsFactors,
  ): TreatmentChangeKind[] {
    const changedKinds: TreatmentChangeKind[] = [];

    const promptChanged =
      current.harnessPromptHash !== next.harnessPromptHash
      || current.customPromptHash !== next.customPromptHash
      || current.appendSystemPromptHash !== next.appendSystemPromptHash
      || !areStringArraysEqual(current.promptGuidelineHashes, next.promptGuidelineHashes)
      || JSON.stringify(current.contextFiles) !== JSON.stringify(next.contextFiles);
    if (promptChanged) {
      changedKinds.push('prompt');
    }

    const toolsChanged =
      current.toolSetHash !== next.toolSetHash
      || !areStringArraysEqual(current.selectedToolIds, next.selectedToolIds)
      || JSON.stringify(current.toolSnippetHashes) !== JSON.stringify(next.toolSnippetHashes);
    if (toolsChanged) {
      changedKinds.push('toolSelection');
    }

    const skillsChanged =
      current.skillSetHash !== next.skillSetHash
      || JSON.stringify(current.skills) !== JSON.stringify(next.skills);
    if (skillsChanged) {
      changedKinds.push('skills');
    }

    const extensionsChanged =
      !areStringArraysEqual(current.activeExtensions, next.activeExtensions);
    if (extensionsChanged) {
      changedKinds.push('extensions');
    }

    return changedKinds;
  }

  closeBusyInterval(state: SessionRunState): boolean {
    const run = state.currentRun;
    if (!run || !state.busyStartedAt) {
      state.busyStartedAt = null;
      return false;
    }

    const startedAtMs = Date.parse(state.busyStartedAt);
    const endMs = this.now().getTime();
    if (Number.isFinite(startedAtMs)) {
      run.busyDurationMs += Math.max(0, endMs - startedAtMs);
    }
    state.busyStartedAt = null;
    return true;
  }

  buildOutcomeHistoryEntry(run: RunSnapshot, outcome: RunOutcome): OutcomeHistoryLogEntry {
    return {
      schemaVersion: RUN_ANALYTICS_SCHEMA_VERSION,
      kind: 'run_outcome',
      recordedAt: this.isoNow(),
      sessionPath: run.sessionPath,
      runId: run.runId,
      taskGroupId: run.taskGroupId,
      outcome,
    };
  }

  private getCurrentModelConfig(sessionPath: string): {
    modelId: string | undefined;
    thinkingLevel: ThinkingLevel | undefined;
  } {
    const state = this.getState();
    const session = getSessionByPath(state, sessionPath);
    const modelSettings: ModelSettings | null = state.settings.modelSettings;
    return {
      modelId: session?.modelId ?? modelSettings?.defaultModel,
      thinkingLevel: session?.thinkingLevel ?? modelSettings?.defaultThinkingLevel,
    };
  }

  private getCurrentAnalyticsFactors(sessionPath: string): SessionAnalyticsFactors | null {
    return this.getState().sessionState.analyticsFactorsBySession[sessionPath] ?? null;
  }

  syncSessionSummary(sessionPath: string): void {
    const state = this.sessions.get(sessionPath);
    const summary = toActiveRunSummary(
      state?.currentRun ?? state?.lastRun ?? null,
      state?.nextTaskIntent === 'new_task',
    );
    this.dispatch(sessionStateActions.setActiveRunSummary({ sessionPath, summary }));
  }

  persist(snapshotToAppend?: RunSnapshot, outcomeToAppend?: OutcomeHistoryLogEntry): void {
    this.schedulePersistCallback(snapshotToAppend, outcomeToAppend);
  }

  isoNow(): string {
    return this.now().toISOString();
  }
}
