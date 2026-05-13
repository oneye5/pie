import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { serializeJsonLine } from '../shared/jsonl';
import {
  analyzeToolCall,
  incrementNamedCount,
  mergeFileMutationDelta,
  normalizeToolCallName,
} from '../shared/tool-call-analysis';
import type {
  ComposerInput,
  ModelSettings,
  RunOutcome,
  SessionAnalyticsFactors,
  ThinkingLevel,
  ToolCall,
} from '../shared/protocol';
import {
  appendUnique,
  areStringArraysEqual,
  defaultCreateId,
  defaultNow,
  parseCheckpoint,
  summarizeInputs,
  toActiveRunSummary,
  toPersistedSessionState,
  workspaceHash,
} from './stats-service-helpers';
import {
  readCheckpointFromDisk,
  writeCheckpointToDisk,
  type CheckpointSlot,
} from './stats-service-persistence';
import { exportRunAnalyticsStore, queryRunAnalyticsStore, type RunAnalyticsExportPayload, type RunAnalyticsQueryResult } from './run-analytics-query';
import {
  RUN_ANALYTICS_SCHEMA_VERSION,
  createEmptyFileMutationRollup,
  createEmptyToolUsageRollup,
  createEmptyVerificationRollup,
  normalizeExperimentAssignment,
  type OutcomeHistoryLogEntry,
  type PersistedSessionRunState,
  type RunCheckpoint,
  type RunFinalizationReason,
  type RunSnapshot,
  type RunSnapshotLogEntry,
  type TaskBoundaryIntent,
  type TreatmentChangeKind,
} from './run-analytics-types';
import {
  getSessionByPath,
  sessionStateActions,
  store as appStore,
  type AppStore,
  type RootState,
} from './store';

type StoreDispatch = AppStore['dispatch'];
type StoreGetState = () => RootState;

interface SessionRunState {
  currentRun: RunSnapshot | null;
  lastRun: RunSnapshot | null;
  nextTaskIntent: TaskBoundaryIntent;
  queuedUnsupportedInputCount: number;
  turnIdsSeenInCurrentRun: Set<string>;
  busyStartedAt: string | null;
}

export interface RunObserver {
  prepareForSend(sessionPath: string, inputs: ComposerInput[]): string;
  onAssistantTurnStarted(sessionPath: string, turnId: string): void;
  onAssistantTurnEnded(sessionPath: string, turnId: string, durationMs: number): void;
  onToolStarted(sessionPath: string, toolCall: ToolCall): void;
  onToolFinished(sessionPath: string, toolCall: ToolCall): void;
  onInterrupted(sessionPath: string): void;
  onMessageEdited(sessionPath: string, messageId: string): void;
  onTruncatedAfter(sessionPath: string, messageId: string): void;
  onBackendError(sessionPath: string | undefined, code: string): void;
  onContextUsageChanged(sessionPath: string, tokens: number | null, limit: number): void;
  onBusyChanged(sessionPath: string, busy: boolean): void;
  onModelConfigChanged(sessionPath: string, modelId: string | undefined, thinkingLevel: ThinkingLevel | undefined): void;
  onSessionAnalyticsFactorsChanged(sessionPath: string, factors: SessionAnalyticsFactors | null): void;
  onUnsupportedInputAttempt(sessionPath: string): void;
  onSessionClosed(sessionPath: string): void;
  replaceSessionPath(oldPath: string, newPath: string): void;
}

export const NOOP_RUN_OBSERVER: RunObserver = {
  prepareForSend: () => 'noop-run',
  onAssistantTurnStarted: () => undefined,
  onAssistantTurnEnded: () => undefined,
  onToolStarted: () => undefined,
  onToolFinished: () => undefined,
  onInterrupted: () => undefined,
  onMessageEdited: () => undefined,
  onTruncatedAfter: () => undefined,
  onBackendError: () => undefined,
  onContextUsageChanged: () => undefined,
  onBusyChanged: () => undefined,
  onModelConfigChanged: () => undefined,
  onSessionAnalyticsFactorsChanged: () => undefined,
  onUnsupportedInputAttempt: () => undefined,
  onSessionClosed: () => undefined,
  replaceSessionPath: () => undefined,
};

export interface StatsServiceOptions {
  globalStoragePath: string;
  workspaceId: string;
  scheduleRender?: () => void;
  dispatch?: StoreDispatch;
  getState?: StoreGetState;
  now?: () => Date;
  createId?: () => string;
  getExperimentAssignment?: () => string | null;
}

function emptySessionRunState(): SessionRunState {
  return {
    currentRun: null,
    lastRun: null,
    nextTaskIntent: null,
    queuedUnsupportedInputCount: 0,
    turnIdsSeenInCurrentRun: new Set<string>(),
    busyStartedAt: null,
  };
}

export class StatsService implements RunObserver {
  private readonly storageDir: string;
  private readonly scheduleRender: () => void;
  private readonly dispatch: StoreDispatch;
  private readonly getState: StoreGetState;
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly getExperimentAssignment: () => string | null;

  private readonly sessions = new Map<string, SessionRunState>();
  private persistenceQueue: Promise<void> = Promise.resolve();
  private startPromise: Promise<void> | null = null;
  private seq = 0;
  private activeSlot: CheckpointSlot = 'a';
  private started = false;

  constructor(options: StatsServiceOptions) {
    this.storageDir = path.join(
      options.globalStoragePath,
      'runs',
      workspaceHash(options.workspaceId),
    );
    this.scheduleRender = options.scheduleRender ?? (() => undefined);
    this.dispatch = options.dispatch ?? appStore.dispatch;
    this.getState = options.getState ?? appStore.getState;
    this.now = options.now ?? defaultNow;
    this.createId = options.createId ?? defaultCreateId;
    this.getExperimentAssignment = options.getExperimentAssignment ?? (() => null);
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    if (this.startPromise) {
      return await this.startPromise;
    }

    this.startPromise = (async () => {
      await fs.mkdir(this.storageDir, { recursive: true });
      const checkpoint = await this.readCheckpoint();
      this.seq = checkpoint?.seq ?? 0;

      for (const [sessionPath, sessionState] of Object.entries(checkpoint?.sessions ?? {})) {
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

      this.started = true;
      this.scheduleRender();
    })();

    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  prepareForSend(sessionPath: string, inputs: ComposerInput[]): string {
    const state = this.getOrCreateSessionState(sessionPath);

    if (state.currentRun) {
      this.finalizeCurrentRun(
        sessionPath,
        state.nextTaskIntent === 'new_task' ? 'new_task' : 'closed_unscored',
      );
    }

    const run = this.createRunSnapshot(sessionPath, state);
    state.currentRun = run;
    state.turnIdsSeenInCurrentRun.clear();
    state.busyStartedAt = null;

    run.sendCount += 1;
    run.updatedAt = this.isoNow();
    summarizeInputs(run, inputs);
    if (state.queuedUnsupportedInputCount > 0) {
      run.unsupportedInputCount += state.queuedUnsupportedInputCount;
      state.queuedUnsupportedInputCount = 0;
    }
    state.nextTaskIntent = null;

    this.syncSessionSummary(sessionPath);
    this.schedulePersist();
    this.scheduleRender();
    return run.runId;
  }

  onAssistantTurnStarted(sessionPath: string, turnId: string): void {
    const state = this.sessions.get(sessionPath);
    const run = state?.currentRun;
    if (!run || !state) {
      return;
    }

    if (!state.turnIdsSeenInCurrentRun.has(turnId)) {
      state.turnIdsSeenInCurrentRun.add(turnId);
      run.assistantTurnCount += 1;
      run.updatedAt = this.isoNow();
      this.schedulePersist();
    }
  }

  onAssistantTurnEnded(sessionPath: string, turnId: string, durationMs: number): void {
    const state = this.sessions.get(sessionPath);
    const run = state?.currentRun;
    if (!run || !state) {
      return;
    }

    if (!state.turnIdsSeenInCurrentRun.has(turnId)) {
      state.turnIdsSeenInCurrentRun.add(turnId);
      run.assistantTurnCount += 1;
    }

    run.assistantTurnDurationMs += Math.max(0, Math.trunc(durationMs));
    run.updatedAt = this.isoNow();
    this.schedulePersist();
  }

  onToolStarted(sessionPath: string, toolCall: ToolCall): void {
    const run = this.sessions.get(sessionPath)?.currentRun;
    if (!run) {
      return;
    }

    const normalizedName = normalizeToolCallName(toolCall.name) || toolCall.name;
    run.toolUsage.totalCount += 1;
    incrementNamedCount(run.toolUsage.countsByName, normalizedName);
    run.updatedAt = this.isoNow();
    this.schedulePersist();
  }

  onToolFinished(sessionPath: string, toolCall: ToolCall): void {
    const run = this.sessions.get(sessionPath)?.currentRun;
    if (!run) {
      return;
    }

    const normalizedName = normalizeToolCallName(toolCall.name) || toolCall.name;
    if (toolCall.status === 'failed') {
      run.toolUsage.failureCount += 1;
      incrementNamedCount(run.toolUsage.failureCountsByName, normalizedName);
    }

    const analysis = analyzeToolCall(toolCall);
    if (analysis.subagentCallCount > 0) {
      run.toolUsage.subagentCallCount += analysis.subagentCallCount;
      run.toolUsage.subagentTaskCount += analysis.subagentTaskCount;
      run.toolUsage.subagentAgentNames = appendUnique(
        run.toolUsage.subagentAgentNames,
        analysis.subagentAgentNames,
      );
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
    }

    run.updatedAt = this.isoNow();
    this.schedulePersist();
  }

  onInterrupted(sessionPath: string): void {
    const run = this.sessions.get(sessionPath)?.currentRun;
    if (!run) {
      return;
    }

    run.interruptedCount += 1;
    run.updatedAt = this.isoNow();
    this.schedulePersist();
  }

  onMessageEdited(sessionPath: string, _messageId: string): void {
    const run = this.getMostRelevantRun(sessionPath);
    if (!run) {
      return;
    }

    run.messageEditCount += 1;
    run.updatedAt = this.isoNow();
    this.schedulePersist();
  }

  onTruncatedAfter(sessionPath: string, _messageId: string): void {
    const run = this.getMostRelevantRun(sessionPath);
    if (!run) {
      return;
    }

    run.truncatedAfterCount += 1;
    run.updatedAt = this.isoNow();
    this.schedulePersist();
  }

  onBackendError(sessionPath: string | undefined, code: string): void {
    if (!sessionPath) {
      return;
    }
    const run = this.getMostRelevantRun(sessionPath);
    if (!run) {
      return;
    }

    run.backendErrorCodes = [...run.backendErrorCodes, code];
    run.updatedAt = this.isoNow();
    this.schedulePersist();
  }

  onContextUsageChanged(sessionPath: string, tokens: number | null, limit: number): void {
    const run = this.sessions.get(sessionPath)?.currentRun;
    if (!run) {
      return;
    }

    run.contextTokens = tokens;
    run.contextLimit = limit;
    run.updatedAt = this.isoNow();
    this.schedulePersist();
  }

  onBusyChanged(sessionPath: string, busy: boolean): void {
    const state = this.sessions.get(sessionPath);
    const run = state?.currentRun;
    if (!state || !run) {
      return;
    }

    if (busy) {
      if (!state.busyStartedAt) {
        state.busyStartedAt = this.isoNow();
        run.busyPeriodCount += 1;
        run.updatedAt = this.isoNow();
        this.schedulePersist();
      }
      return;
    }

    if (this.closeBusyInterval(state)) {
      run.updatedAt = this.isoNow();
      this.schedulePersist();
    }
  }

  onModelConfigChanged(
    sessionPath: string,
    modelId: string | undefined,
    thinkingLevel: ThinkingLevel | undefined,
  ): void {
    const run = this.sessions.get(sessionPath)?.currentRun;
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
    this.markTreatmentChanges(run, changedKinds);
    run.updatedAt = this.isoNow();
    this.schedulePersist();
  }

  onSessionAnalyticsFactorsChanged(sessionPath: string, factors: SessionAnalyticsFactors | null): void {
    const run = this.sessions.get(sessionPath)?.currentRun;
    if (!run || !run.analyticsFactors || !factors) {
      return;
    }

    const changedKinds = this.diffAnalyticsFactors(run.analyticsFactors, factors);
    if (changedKinds.length === 0) {
      return;
    }

    this.markTreatmentChanges(run, changedKinds);
    run.updatedAt = this.isoNow();
    this.schedulePersist();
  }

  onUnsupportedInputAttempt(sessionPath: string): void {
    const state = this.getOrCreateSessionState(sessionPath);
    if (state.currentRun) {
      state.currentRun.unsupportedInputCount += 1;
      state.currentRun.updatedAt = this.isoNow();
    } else {
      state.queuedUnsupportedInputCount += 1;
    }
    this.schedulePersist();
  }

  onSessionClosed(sessionPath: string): void {
    if (this.sessions.get(sessionPath)?.currentRun) {
      this.finalizeCurrentRun(sessionPath, 'closed_unscored');
    }
    this.sessions.delete(sessionPath);
    this.dispatch(sessionStateActions.setActiveRunSummary({ sessionPath, summary: null }));
    this.schedulePersist();
    this.scheduleRender();
  }

  replaceSessionPath(oldPath: string, newPath: string): void {
    if (!oldPath || !newPath || oldPath === newPath) {
      return;
    }
    const state = this.sessions.get(oldPath);
    if (!state) {
      return;
    }

    if (state.currentRun) {
      state.currentRun = { ...state.currentRun, sessionPath: newPath };
    }
    if (state.lastRun) {
      state.lastRun = { ...state.lastRun, sessionPath: newPath };
    }

    this.sessions.delete(oldPath);
    this.sessions.set(newPath, state);
    this.schedulePersist();
  }

  recordOutcome(sessionPath: string, outcome: RunOutcome): void {
    const state = this.getOrCreateSessionState(sessionPath);

    if (state.currentRun) {
      this.finalizeCurrentRun(sessionPath, 'scored', outcome);
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
      finalizedAt: state.lastRun.finalizedAt ?? this.isoNow(),
      updatedAt: this.isoNow(),
    };
    state.lastRun = updatedRun;

    this.syncSessionSummary(sessionPath);
    this.schedulePersist(updatedRun, this.buildOutcomeHistoryEntry(updatedRun, outcome));
    this.scheduleRender();
  }

  startNewTask(sessionPath: string): void {
    const state = this.getOrCreateSessionState(sessionPath);
    state.nextTaskIntent = 'new_task';
    this.schedulePersist();
  }

  continueTask(sessionPath: string): void {
    const state = this.getOrCreateSessionState(sessionPath);
    state.nextTaskIntent = 'continue_task';
    this.schedulePersist();
  }

  onExperimentAssignmentChanged(assignment: string | null): void {
    const normalized = normalizeExperimentAssignment(assignment);
    let changed = false;
    for (const state of this.sessions.values()) {
      const run = state.currentRun;
      if (!run || run.experimentAssignment === normalized) {
        continue;
      }
      this.markTreatmentChanges(run, ['experimentAssignment']);
      run.updatedAt = this.isoNow();
      changed = true;
    }
    if (changed) {
      this.schedulePersist();
    }
  }

  async queryRunAnalytics(): Promise<RunAnalyticsQueryResult> {
    await this.flush();
    return await queryRunAnalyticsStore(this.storageDir);
  }

  async exportRunAnalytics(targetPath: string): Promise<RunAnalyticsExportPayload> {
    await this.flush();
    return await exportRunAnalyticsStore(this.storageDir, targetPath, this.now);
  }

  async flush(): Promise<void> {
    await this.persistenceQueue.catch(() => undefined);
  }

  async shutdown(): Promise<void> {
    const openSessionPaths = [...this.sessions.entries()]
      .filter(([, state]) => !!state.currentRun)
      .map(([sessionPath]) => sessionPath);

    for (const sessionPath of openSessionPaths) {
      this.finalizeCurrentRun(sessionPath, 'closed_unscored');
    }

    await this.flush();
  }

  private getOrCreateSessionState(sessionPath: string): SessionRunState {
    let state = this.sessions.get(sessionPath);
    if (!state) {
      state = emptySessionRunState();
      this.sessions.set(sessionPath, state);
    }
    return state;
  }

  private getMostRelevantRun(sessionPath: string): RunSnapshot | null {
    const state = this.sessions.get(sessionPath);
    if (!state) {
      return null;
    }
    return state.currentRun ?? state.lastRun;
  }

  private createRunSnapshot(sessionPath: string, state: SessionRunState): RunSnapshot {
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
      filesystemPathRefCount: 0,
      imageInputCount: 0,
      imageInputBytes: 0,
      unsupportedInputCount: 0,
      inputKindsUsed: [],
      toolUsage: createEmptyToolUsageRollup(),
      fileMutation: createEmptyFileMutationRollup(),
      verification: createEmptyVerificationRollup(),
    };
  }

  private finalizeCurrentRun(
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
    this.schedulePersist(
      finalizedRun,
      outcome ? this.buildOutcomeHistoryEntry(finalizedRun, outcome) : undefined,
    );
    return finalizedRun;
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

  private syncSessionSummary(sessionPath: string): void {
    const state = this.sessions.get(sessionPath);
    const summary = toActiveRunSummary(state?.currentRun ?? state?.lastRun ?? null);
    this.dispatch(sessionStateActions.setActiveRunSummary({ sessionPath, summary }));
  }

  private markTreatmentChanges(run: RunSnapshot, kinds: TreatmentChangeKind[]): void {
    if (kinds.length === 0) {
      return;
    }

    run.mixedTreatmentConfig = true;
    run.treatmentChangeKinds = appendUnique(run.treatmentChangeKinds, kinds);
  }

  private diffAnalyticsFactors(
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

    return changedKinds;
  }

  private closeBusyInterval(state: SessionRunState): boolean {
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

  private schedulePersist(
    snapshotToAppend?: RunSnapshot,
    outcomeToAppend?: OutcomeHistoryLogEntry,
  ): void {
    const checkpoint = this.buildCheckpoint(++this.seq);
    this.persistenceQueue = this.persistenceQueue
      .catch(() => undefined)
      .then(async () => {
        await fs.mkdir(this.storageDir, { recursive: true });
        if (snapshotToAppend) {
          await fs.appendFile(
            path.join(this.storageDir, 'run-snapshots.jsonl'),
            serializeJsonLine({
              schemaVersion: RUN_ANALYTICS_SCHEMA_VERSION,
              kind: 'run_snapshot',
              recordedAt: this.isoNow(),
              run: snapshotToAppend,
            } satisfies RunSnapshotLogEntry),
            'utf8',
          );
        }
        if (outcomeToAppend) {
          await fs.appendFile(
            path.join(this.storageDir, 'outcome-history.jsonl'),
            serializeJsonLine(outcomeToAppend),
            'utf8',
          );
        }
        await this.writeCheckpoint(checkpoint);
      });
  }

  private buildCheckpoint(seq: number): RunCheckpoint {
    const sessions: Record<string, PersistedSessionRunState> = {};
    for (const [sessionPath, state] of this.sessions) {
      sessions[sessionPath] = toPersistedSessionState(state);
    }
    return {
      schemaVersion: RUN_ANALYTICS_SCHEMA_VERSION,
      seq,
      sessions,
    };
  }

  private buildOutcomeHistoryEntry(run: RunSnapshot, outcome: RunOutcome): OutcomeHistoryLogEntry {
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

  private async readCheckpoint(): Promise<RunCheckpoint | null> {
    const { checkpoint, activeSlot } = await readCheckpointFromDisk(this.storageDir, parseCheckpoint);
    this.activeSlot = activeSlot;
    return checkpoint;
  }

  private async writeCheckpoint(checkpoint: RunCheckpoint): Promise<void> {
    this.activeSlot = await writeCheckpointToDisk(this.storageDir, this.activeSlot, checkpoint);
  }

  private isoNow(): string {
    return this.now().toISOString();
  }
}
