import * as path from 'node:path';

import * as vscode from 'vscode';

import { BackendClient } from '../backend/client';
import { resolveSessionOpenedTranscript } from './session-opened-transcript';
import { type RunObserver } from '../stats-service';
import { auditLog } from '../util/audit';
import {
  getSessionByPath,
  selectActiveSessionPath,
  sessionStateActions,
  settingsActions,
  sessionsActions,
  store,
  transcriptActions,
  uiActions,
} from '../store';
import { deriveSessionNameFromText } from '../../shared/session-name';
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
  buildOptimisticUserParts,
  buildPromptText,
  clearPendingImageInputs,
  modelSupportsInputKind,
  normalizeAttachUris,
  upsertPendingComposerInput,
  validateAndMaterializeComposerInput,
} from './composer';
import { buildTranscriptPageRequest } from './transcript-window';
import { SessionServiceState } from './state';
import type { PostImperative, ScheduleRender } from './types';

interface SessionMessageActionsOptions {
  context: vscode.ExtensionContext;
  backend: BackendClient;
  scheduleRender: ScheduleRender;
  postImperative: PostImperative;
  runObserver: RunObserver;
  state: SessionServiceState;
  createNewSession: () => string;
}

export class SessionMessageActions {
  private readonly context: vscode.ExtensionContext;
  private readonly backend: BackendClient;
  private readonly scheduleRender: ScheduleRender;
  private readonly postImperative: PostImperative;
  private readonly runObserver: RunObserver;
  private readonly state: SessionServiceState;
  private readonly createNewSession: () => string;
  private readonly transcriptPageRequestSeqBySession = new Map<string, number>();
  private readonly inFlightTranscriptPageBySession = new Set<string>();

  constructor(options: SessionMessageActionsOptions) {
    this.context = options.context;
    this.backend = options.backend;
    this.scheduleRender = options.scheduleRender;
    this.postImperative = options.postImperative;
    this.runObserver = options.runObserver;
    this.state = options.state;
    this.createNewSession = options.createNewSession;
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
      );
      if (!input) {
        continue;
      }
      upsertPendingComposerInput(sessionPath, input);
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
    );
    if (!input) {
      return;
    }

    upsertPendingComposerInput(sessionPath, input);
    this.scheduleRender();
  }

  removeComposerInput(requestedSessionPath: string | undefined, inputId: string): void {
    const sessionPath = this.resolveExistingComposerTargetSessionPath(requestedSessionPath);
    if (!sessionPath || !inputId.trim()) {
      return;
    }

    store.dispatch(sessionStateActions.removePendingComposerInput({
      sessionPath,
      inputId,
    }));
    this.scheduleRender();
  }

  /**
   * @deprecated Phase 4 migration: send is now routed through the CQRS
   * reducer + EffectRunner in extension-host.ts. See ARCH-MIGRATION-PLAN.md §Phase 4.
   */
  async send(requestedSessionPath: string, text: string): Promise<void> {
    const attemptedSessionPath = requestedSessionPath;
    const sessionPath = this.requireOpenSessionPath('send', requestedSessionPath);
    if (!sessionPath) {
      this.postImperative({ type: 'sendRejected', sessionPath: attemptedSessionPath, text });
      return;
    }

    const inputs = [
      ...(store.getState().sessionState.pendingComposerInputsBySession[sessionPath] ?? []),
    ];
    if (!text.trim() && inputs.length === 0) {
      return;
    }

    this.state.bumpSessionDataEpoch(sessionPath);
    this.runObserver.prepareForSend(sessionPath, inputs);

    const composedText = buildPromptText(text, inputs);
    const optimisticUserParts = buildOptimisticUserParts(text, inputs);

    auditLog(this.context, 'session-service', 'message.send.requested', {
      attachedInputCount: inputs.length,
      attachedPathCount: inputs.filter((input) => input.kind === 'filesystemPathRef').length,
      attachedImageCount: inputs.filter((input) => input.kind === 'imageBlob').length,
      sessionPath,
      textLength: text.length,
    });

    const previousSummary = this.maybeApplyOptimisticSessionName(sessionPath, composedText);

    const localId = `local:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    store.dispatch(
      transcriptActions.appendLocalUserMessage({
        sessionPath,
        id: localId,
        text: composedText,
        userParts: optimisticUserParts,
      }),
    );
    this.scheduleRender();

    try {
      await this.state.enqueueLifecycle(async () => {
        await this.state.enqueueSessionOperation(sessionPath, async () => {
          const response = await this.backend.request<{ requestId?: string }>('message.send', {
            sessionPath,
            text,
            inputs,
          });
          if (response.requestId) {
            this.state.bindRequestSessionPath(response.requestId, sessionPath);
          }
        });
      });
      store.dispatch(sessionStateActions.clearPendingComposerInputs(sessionPath));
      this.scheduleRender();
    } catch (err) {
      this.runObserver.onBackendError(sessionPath, 'MESSAGE_SEND_FAILED');
      store.dispatch(transcriptActions.removeMessage({ sessionPath, messageId: localId }));
      if (previousSummary) {
        store.dispatch(sessionsActions.setSessionSummary(previousSummary));
        this.state.saveOpenTabs();
      }
      this.postImperative({ type: 'sendRejected', sessionPath, text });
      store.dispatch(
        uiActions.setNotice(`Failed to send message: ${(err as Error).message}`),
      );
      this.scheduleRender();
    }
  }

  /**
   * @deprecated Phase 4 migration: editMessage is now routed through the CQRS
   * reducer + EffectRunner in extension-host.ts. See ARCH-MIGRATION-PLAN.md §Phase 4.
   */
  async editMessage(requestedSessionPath: string, messageId: string, text: string): Promise<void> {
    const sessionPath = this.requireOpenSessionPath('edit', requestedSessionPath);
    if (!sessionPath) {
      return;
    }

    let localId: string | null = null;

    this.state.bumpSessionDataEpoch(sessionPath);
    auditLog(this.context, 'session-service', 'message.edit.requested', {
      messageId,
      sessionPath,
      textLength: text.length,
    });

    try {
      await this.state.enqueueLifecycle(async () => {
        await this.state.enqueueSessionOperation(sessionPath, async () => {
          await this.backend.request('session.truncateAfter', {
            sessionPath,
            entryId: messageId,
          });
          this.runObserver.onTruncatedAfter(sessionPath, messageId);
          this.runObserver.onMessageEdited(sessionPath, messageId);

          localId = `local:edit:${Date.now()}:${Math.random().toString(36).slice(2)}`;
          store.dispatch(
            transcriptActions.appendLocalUserMessage({
              sessionPath,
              id: localId,
              text,
            }),
          );
          this.scheduleRender();

          this.runObserver.prepareForSend(sessionPath, []);
          const response = await this.backend.request<{ requestId?: string }>('message.send', {
            sessionPath,
            text,
          });
          if (response.requestId) {
            this.state.bindRequestSessionPath(response.requestId, sessionPath);
          }
        });
      });
    } catch (err) {
      if (localId) {
        store.dispatch(transcriptActions.removeMessage({ sessionPath, messageId: localId }));
      }
      this.runObserver.onBackendError(sessionPath, 'MESSAGE_EDIT_FAILED');
      store.dispatch(
        uiActions.setNotice(`Failed to edit message: ${(err as Error).message}`),
      );
      this.scheduleRender();
    }
  }

  /**
   * @deprecated Phase 3 migration: interrupt is now routed through the CQRS
   * reducer + EffectRunner in extension-host.ts. This method remains only as a
   * fallback until all callers are verified removed. See ARCH-MIGRATION-PLAN.md §Phase 3.
   */
  async interrupt(requestedSessionPath: string): Promise<void> {
    const sessionPath = this.requireOpenSessionPath('interrupt', requestedSessionPath);
    if (!sessionPath) {
      return;
    }

    auditLog(this.context, 'session-service', 'message.interrupt.requested', {
      sessionPath,
    });

    try {
      await this.state.enqueueLifecycle(async () => {
        await this.state.enqueueSessionOperation(sessionPath, async () => {
          await this.backend.request('message.interrupt', {
            sessionPath,
          });
        });
      });
      this.state.suppressNextCompletionNotificationFor(sessionPath);
    } catch (err) {
      store.dispatch(
        uiActions.setNotice(`Failed to interrupt: ${(err as Error).message}`),
      );
      this.scheduleRender();
    }
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

    const pendingInputs = store.getState().sessionState.pendingComposerInputsBySession[sessionPath] ?? [];
    const hasPendingImageInputs = pendingInputs.some((input) => input.kind === 'imageBlob');
    const requestedModelSupportsImages = modelSupportsInputKind(sessionPath, defaultModel, 'image');
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
        const result = await this.backend.request<ModelSettings>('settings.set', {
          sessionPath,
          defaultModel,
          defaultThinkingLevel,
        });
        store.dispatch(settingsActions.setModelSettings(result));
        store.dispatch(settingsActions.clearContextUsage(sessionPath));
        this.state.bumpSessionDataEpoch(sessionPath);

        const session = getSessionByPath(store.getState(), sessionPath);
        if (session) {
          store.dispatch(sessionsActions.upsertSession({
            ...session,
            modelId: defaultModel,
            thinkingLevel: defaultThinkingLevel,
          }));
        }

        if (shouldClearPendingImages) {
          clearPendingImageInputs(sessionPath);
        }

        this.runObserver.onModelConfigChanged(sessionPath, defaultModel, defaultThinkingLevel);
        this.scheduleRender();
      });
    } catch (err) {
      store.dispatch(
        uiActions.setNotice(`Failed to set model: ${(err as Error).message}`),
      );
      this.scheduleRender();
    }
  }

  async hydrateModelState(sessionPath: string): Promise<void> {
    try {
      const [modelSettings, models] = await Promise.all([
        this.backend.request<ModelSettings>('settings.get'),
        this.backend.request<ModelInfo[]>('models.list', { sessionPath }),
      ]);
      store.dispatch(
        settingsActions.setModelAndAvailable({
          sessionPath,
          modelSettings,
          availableModels: models,
        }),
      );
      this.scheduleRender();
    } catch {
      // Non-fatal: model hydration failure does not break the extension.
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

    const transcriptWindow = store.getState().transcript.windowBySession[sessionPath];
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

      if (!store.getState().sessions.openTabPaths.includes(payload.sessionPath)) {
        return;
      }

      const currentWindow = store.getState().transcript.windowBySession[payload.sessionPath];
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
        localTranscript: store.getState().transcript.bySession[payload.sessionPath] ?? [],
      });

      store.dispatch(transcriptActions.setTranscript({
        sessionPath: payload.sessionPath,
        transcript: resolution.transcript,
        transcriptWindow: resolution.transcriptWindow,
        preserveCurrentTurn: payload.busy,
        preserveAliases: payload.busy,
      }));

      this.state.touchSessionTranscript(payload.sessionPath);
      this.state.evictInactiveTranscriptWindows();
      this.scheduleRender();
    } catch (error) {
      store.dispatch(uiActions.setNotice(`Failed to load transcript page: ${(error as Error).message}`));
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

  private requireOpenSessionPath(actionName: string, sessionPath?: string): string | null {
    const resolvedSessionPath = sessionPath ?? selectActiveSessionPath(store.getState());
    if (!resolvedSessionPath) {
      store.dispatch(uiActions.setNotice(`Cannot ${actionName}: no active session.`));
      this.scheduleRender();
      return null;
    }
    if (isPendingTabPath(resolvedSessionPath)) {
      store.dispatch(uiActions.setNotice(`Cannot ${actionName}: the session is still opening.`));
      this.scheduleRender();
      return null;
    }
    if (!store.getState().sessions.openTabPaths.includes(resolvedSessionPath)) {
      store.dispatch(uiActions.setNotice(`Cannot ${actionName}: the selected session is no longer open.`));
      this.scheduleRender();
      return null;
    }
    return resolvedSessionPath;
  }

  private maybeApplyOptimisticSessionName(sessionPath: string, text: string) {
    const session = getSessionByPath(store.getState(), sessionPath);
    if (!session || session.isPlaceholder !== true) {
      return null;
    }

    const derived = deriveSessionNameFromText(text);
    if (derived.isPlaceholder || derived.name === session.name) {
      return null;
    }

    store.dispatch(sessionsActions.upsertSession({
      ...session,
      name: derived.name,
      isPlaceholder: false,
    }));
    this.state.saveOpenTabs();
    return session;
  }

  private resolveComposerTargetSessionPath(requestedSessionPath?: string): string | null {
    const existingPath = this.resolveExistingComposerTargetSessionPath(requestedSessionPath);
    if (existingPath) {
      return existingPath;
    }

    return this.createNewSession();
  }

  private resolveExistingComposerTargetSessionPath(requestedSessionPath?: string): string | null {
    const state = store.getState();
    const sessionPath = requestedSessionPath ?? selectActiveSessionPath(state);
    if (!sessionPath) {
      return null;
    }
    if (!state.sessions.openTabPaths.includes(sessionPath)) {
      store.dispatch(uiActions.setNotice('Cannot update composer inputs: the selected session is no longer open.'));
      this.scheduleRender();
      return null;
    }
    return sessionPath;
  }
}
