import * as path from 'node:path';

import * as vscode from 'vscode';

import { BackendClient } from '../backend/client';
import { resolveSessionOpenedTranscript } from '../core/session-opened-transcript';
import { type RunObserver } from '../stats-service';
import { auditLog } from '../util/audit';
import { toErrorMessage } from '../util/error-message';


import { isPendingTabPath } from '../../shared/tab-behavior';
import type {
  ComposerInputDraft,
  ModelInfo,
  ModelSettings,
  ThinkingLevel,
  TranscriptPageDirection,
  TranscriptPagePayload,
} from '../../shared/protocol';
import {
  clearPendingImageInputs,
  modelSupportsInputKind,
  normalizeAttachUris,
  upsertPendingComposerInput,
  validateAndMaterializeComposerInput,
} from '../core/composer';
import { buildTranscriptPageRequest } from '../core/transcript-window';
import { SessionServiceState } from './state';
import type { ScheduleRender } from './types';
import type { ArchState } from '../core/arch-state';
import type { Event } from '../core/events';

interface SessionMessageActionsOptions {
  context: vscode.ExtensionContext;
  backend: BackendClient;
  scheduleRender: ScheduleRender;
  runObserver: RunObserver;
  state: SessionServiceState;
  createNewSession: () => string;
  getArchState: () => ArchState;
  dispatchArch: (event: Event) => void;
}

export class SessionMessageActions {
  private readonly context: vscode.ExtensionContext;
  private readonly backend: BackendClient;
  private readonly scheduleRender: ScheduleRender;
  private readonly runObserver: RunObserver;
  private readonly state: SessionServiceState;
  private readonly createNewSession: () => string;
  private readonly getArchState: () => ArchState;
  private readonly dispatchArch: (event: Event) => void;
  private readonly transcriptPageRequestSeqBySession = new Map<string, number>();
  private readonly inFlightTranscriptPageBySession = new Set<string>();

  constructor(options: SessionMessageActionsOptions) {
    this.context = options.context;
    this.backend = options.backend;
    this.scheduleRender = options.scheduleRender;
    this.runObserver = options.runObserver;
    this.state = options.state;
    this.createNewSession = options.createNewSession;
    this.getArchState = options.getArchState;
    this.dispatchArch = options.dispatchArch;
  }

  normalizeAttachUris(uris: vscode.Uri[]): vscode.Uri[] {
    return normalizeAttachUris(uris);
  }

  async addFilesystemPaths(
    requestedSessionPath: string | undefined,
    paths: string[],
    source: 'picker' | 'drop',
  ): Promise<void> {
    const sessionPath = this.resolveComposerTargetSessionPath(requestedSessionPath);
    const uniquePaths = [...new Set(
      paths
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    )];
    if (!sessionPath || uniquePaths.length === 0) {
      return;
    }

    for (const filesystemPath of uniquePaths) {
      const input = validateAndMaterializeComposerInput(
        sessionPath,
        {
          kind: 'filesystemPathRef',
          path: filesystemPath,
          name: path.basename(filesystemPath) || filesystemPath,
          source,
        },
        () => this.state.createComposerInputId(),
        this.scheduleRender,
        this.runObserver,
        this.getArchState,
        this.dispatchArch,
      );
      if (!input) {
        continue;
      }
      upsertPendingComposerInput(sessionPath, input, this.getArchState, this.dispatchArch);
    }

    this.scheduleRender();
  }

  async addComposerInput(
    requestedSessionPath: string | undefined,
    inputDraft: ComposerInputDraft,
  ): Promise<void> {
    const sessionPath = this.resolveComposerTargetSessionPath(requestedSessionPath);
    if (!sessionPath) {
      return;
    }

    const input = validateAndMaterializeComposerInput(
      sessionPath,
      inputDraft,
      () => this.state.createComposerInputId(),
      this.scheduleRender,
      this.runObserver,
      this.getArchState,
      this.dispatchArch,
    );
    if (!input) {
      return;
    }

    upsertPendingComposerInput(sessionPath, input, this.getArchState, this.dispatchArch);
    this.scheduleRender();
  }

  removeComposerInput(requestedSessionPath: string | undefined, inputId: string): void {
    const sessionPath = this.resolveExistingComposerTargetSessionPath(requestedSessionPath);
    if (!sessionPath || !inputId.trim()) {
      return;
    }

    const existing = this.getArchState().composer.pendingComposerInputsBySession[sessionPath] ?? [];
    const filtered = existing.filter((input) => input.id !== inputId);
    if (filtered.length === existing.length) {
      return;
    }
    this.dispatchArch({ kind: 'ComposerInputsReplaced', sessionPath, inputs: filtered.length > 0 ? filtered : null });
    this.scheduleRender();
  }

  async loadOlderTranscript(requestedSessionPath?: string): Promise<void> {
    await this.loadTranscriptPage('older', requestedSessionPath);
  }

  async loadNewerTranscript(requestedSessionPath?: string): Promise<void> {
    await this.loadTranscriptPage('newer', requestedSessionPath);
  }

  async jumpToLatestTranscript(requestedSessionPath?: string): Promise<void> {
    await this.loadTranscriptPage('latest', requestedSessionPath);
  }

  async setModel(
    requestedSessionPath: string | undefined,
    defaultModel: string,
    defaultThinkingLevel: ThinkingLevel,
  ): Promise<void> {
    const sessionPath = this.requireOpenSessionPath('set model', requestedSessionPath);
    if (!sessionPath) {
      return;
    }

    const pendingInputs = this.getArchState().composer.pendingComposerInputsBySession[sessionPath] ?? [];
    const hasPendingImageInputs = pendingInputs.some((input) => input.kind === 'imageBlob');
    const requestedModelSupportsImages = modelSupportsInputKind(sessionPath, defaultModel, 'image', this.getArchState);
    const shouldClearPendingImages = hasPendingImageInputs && requestedModelSupportsImages === false;

    if (shouldClearPendingImages) {
      const choice = await vscode.window.showWarningMessage(
        'Switching to this model will remove pending pasted images because it does not support image inputs.',
        { modal: true },
        'Switch Model',
      );
      if (choice !== 'Switch Model') {
        return;
      }
    }

    try {
      await this.state.enqueueLifecycle(async () => {
        await this.backend.request<ModelSettings>('settings.set', {
          sessionPath,
          defaultModel,
          defaultThinkingLevel,
        });
        this.dispatchArch({ kind: 'ContextUsageChanged', sessionPath, contextUsage: null });
        this.state.bumpSessionDataEpoch(sessionPath);

        this.dispatchArch({ kind: 'SessionMetadataChanged', sessionPath, modelId: defaultModel, thinkingLevel: defaultThinkingLevel });

        if (shouldClearPendingImages) {
          clearPendingImageInputs(sessionPath, this.getArchState, this.dispatchArch);
        }

        this.runObserver.onModelConfigChanged(sessionPath, defaultModel, defaultThinkingLevel);
        this.scheduleRender();
      });
    } catch (err) {
      this.dispatchArch({ kind: 'Error', sessionPath, error: `Failed to set model: ${toErrorMessage(err)}` });
      this.scheduleRender();
    }
  }

  async hydrateModelState(sessionPath: string): Promise<void> {
    try {
      const [modelSettings, models] = await Promise.all([
        this.backend.request<ModelSettings>('settings.get'),
        this.backend.request<ModelInfo[]>('models.list', { sessionPath }),
      ]);
      this.dispatchArch({ kind: 'Command', cmd: { kind: 'SetModel', corrId: `hydrate:${Date.now()}`, sessionPath, modelSettings } });
      const existing = this.getArchState().settings.availableModelsBySession[sessionPath] ?? [];
      if (models.length > 0 || existing.length === 0) {
        this.dispatchArch({ kind: 'AvailableModelsChanged', sessionPath, models });
      }
      this.scheduleRender();
    } catch (err) {
      auditLog(this.context, 'session-service', 'hydrateModelState.failed', { error: toErrorMessage(err) });
    }
  }

  private async loadTranscriptPage(
    direction: TranscriptPageDirection,
    requestedSessionPath?: string,
  ): Promise<void> {
    const sessionPath = this.requireOpenSessionPath('load transcript page', requestedSessionPath);
    if (!sessionPath) {
      return;
    }

    const archState = this.getArchState();
    const transcriptWindow = archState.transcript.windowBySession[sessionPath];
    if (!transcriptWindow) {
      return;
    }

    if (direction === 'older' && !transcriptWindow.hasOlder) {
      return;
    }

    if (direction === 'newer' && !transcriptWindow.hasNewer) {
      return;
    }

    if (direction === 'latest' && !transcriptWindow.isPartial) {
      return;
    }

    if (this.inFlightTranscriptPageBySession.has(sessionPath)) {
      return;
    }

    this.inFlightTranscriptPageBySession.add(sessionPath);

    const requestEpoch = this.state.getSessionDataEpoch(sessionPath);
    const requestWindow = {
      totalCount: transcriptWindow.totalCount,
      loadedStart: transcriptWindow.loadedStart,
      loadedEnd: transcriptWindow.loadedEnd,
    };
    const requestSeq = this.nextTranscriptPageRequestSeq(sessionPath);

    try {
      const payload = await this.backend.request<TranscriptPagePayload>('session.loadTranscriptPage', {
        sessionPath,
        ...buildTranscriptPageRequest(transcriptWindow, direction),
      });

      if (!this.isCurrentTranscriptPageRequest(payload.sessionPath, requestSeq)) {
        return;
      }

      if (this.state.getSessionDataEpoch(payload.sessionPath) !== requestEpoch) {
        return;
      }

      if (!this.getArchState().sessions.openTabPaths.includes(payload.sessionPath)) {
        return;
      }

      const currentWindow = this.getArchState().transcript.windowBySession[payload.sessionPath];
      if (
        !currentWindow
        || currentWindow.totalCount !== requestWindow.totalCount
        || currentWindow.loadedStart !== requestWindow.loadedStart
        || currentWindow.loadedEnd !== requestWindow.loadedEnd
      ) {
        return;
      }

      const resolution = resolveSessionOpenedTranscript({
        busy: payload.busy,
        incomingTranscript: payload.transcript,
        incomingTranscriptWindow: payload.transcriptWindow,
        localTranscript: this.getArchState().transcript.bySession[payload.sessionPath] ?? [],
      });

      this.dispatchArch({
        kind: 'TranscriptPageLoaded',
        sessionPath: payload.sessionPath,
        transcript: resolution.transcript,
        transcriptWindow: resolution.transcriptWindow,
      });

      this.state.touchSessionTranscript(payload.sessionPath);
      this.state.evictInactiveTranscriptWindows();
      this.scheduleRender();
    } catch (error) {
      this.dispatchArch({ kind: 'Error', sessionPath, error: `Failed to load transcript page: ${toErrorMessage(error)}` });
      this.scheduleRender();
    } finally {
      this.inFlightTranscriptPageBySession.delete(sessionPath);
    }
  }

  private nextTranscriptPageRequestSeq(sessionPath: string): number {
    const next = (this.transcriptPageRequestSeqBySession.get(sessionPath) ?? 0) + 1;
    this.transcriptPageRequestSeqBySession.set(sessionPath, next);
    return next;
  }

  private isCurrentTranscriptPageRequest(sessionPath: string, requestSeq: number): boolean {
    return (this.transcriptPageRequestSeqBySession.get(sessionPath) ?? 0) === requestSeq;
  }

  /**
   * Drop any per-session state owned by this actions instance. Called when a
   * session tab is closed, to keep the maps bounded and ensure sequence
   * numbers cannot collide with a later reopen of the same path.
   */
  dropSessionLocalState(sessionPath: string): void {
    this.transcriptPageRequestSeqBySession.delete(sessionPath);
  }

  private requireOpenSessionPath(actionName: string, sessionPath?: string): string | null {
    // STATE_CONTRACT: callers must supply an explicit sessionPath. We no longer
    // silently fall back to the active session, because that masked bugs where
    // a webview message addressed to session A would land on session B after
    // the user switched tabs mid-flight (R3 / B4). If sessionPath is missing,
    // treat it as a malformed request and refuse.
    if (!sessionPath) {
      this.dispatchArch({ kind: 'NoticeShown', notice: `Cannot ${actionName}: missing session reference.` });
      this.scheduleRender();
      return null;
    }
    const resolvedSessionPath = sessionPath;
    if (isPendingTabPath(resolvedSessionPath)) {
      this.dispatchArch({ kind: 'NoticeShown', notice: `Cannot ${actionName}: the session is still opening.` });
      this.scheduleRender();
      return null;
    }
    if (!this.getArchState().sessions.openTabPaths.includes(resolvedSessionPath)) {
      this.dispatchArch({ kind: 'NoticeShown', notice: `Cannot ${actionName}: the selected session is no longer open.` });
      this.scheduleRender();
      return null;
    }
    return resolvedSessionPath;
  }

  private resolveComposerTargetSessionPath(requestedSessionPath?: string): string | null {
    const existingPath = this.resolveExistingComposerTargetSessionPath(requestedSessionPath);
    if (existingPath) {
      return existingPath;
    }

    return this.createNewSession();
  }

  private resolveExistingComposerTargetSessionPath(requestedSessionPath?: string): string | null {
    const archState = this.getArchState();
    // STATE_CONTRACT: composer-target resolution must come from the webview's
    // explicit sessionPath. The previous `?? selectActiveSessionPath` fallback
    // could land composer edits on a different tab if the webview's view of
    // the active session lagged behind the host (R3).
    const sessionPath = requestedSessionPath;
    if (!sessionPath) {
      return null;
    }
    if (!archState.sessions.openTabPaths.includes(sessionPath)) {
      this.dispatchArch({ kind: 'NoticeShown', notice: 'Cannot update composer inputs: the selected session is no longer open.' });
      this.scheduleRender();
      return null;
    }
    return sessionPath;
  }
}
