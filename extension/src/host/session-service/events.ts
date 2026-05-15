import * as vscode from 'vscode';

import { BackendClient } from '../backend-client';
import { shouldFlashFinishedTab } from '../completion-notification';
import { resolveSessionOpenedTranscript } from '../session-opened-transcript';
import { type RunObserver } from '../stats-service';
import { auditLog } from '../state-audit';
import {
  getCanonicalMessageId,
  getSessionByPath,
  selectActiveSessionPath,
  sessionStateActions,
  settingsActions,
  sessionsActions,
  store,
  transcriptActions,
  uiActions,
} from '../store';
import type {
  BusyChangedPayload,
  ContextUsageChangedPayload,
  ErrorPayload,
  EventEnvelope,
  MessageAbortedPayload,
  MessageDeltaPayload,
  MessageFinishedPayload,
  MessageStartedPayload,
  MessageThinkingPayload,
  PatchOp,
  SessionListChangedPayload,
  SessionOpenedPayload,
  ToolFinishedPayload,
  ToolProgressPayload,
  ToolStartedPayload,
} from '../../shared/protocol';
import { dispatchSessionBackendEvent } from './event-dispatch';
import type { OnSessionCompleted, ScheduleRender } from './types';
import { SessionServiceState } from './state';

interface SessionServiceEventsOptions {
  context: vscode.ExtensionContext;
  scheduleRender: ScheduleRender;
  postPatch: (op: PatchOp) => void;
  onSessionCompleted?: OnSessionCompleted;
  runObserver: RunObserver;
  state: SessionServiceState;
}

export class SessionServiceEvents {
  private readonly context: vscode.ExtensionContext;
  private readonly scheduleRender: ScheduleRender;
  private readonly postPatch: (op: PatchOp) => void;
  private readonly onSessionCompleted?: OnSessionCompleted;
  private readonly runObserver: RunObserver;
  private readonly state: SessionServiceState;
  private eventDisposable?: vscode.Disposable;
  private exitDisposable?: vscode.Disposable;

  constructor(options: SessionServiceEventsOptions) {
    this.context = options.context;
    this.scheduleRender = options.scheduleRender;
    this.postPatch = options.postPatch;
    this.onSessionCompleted = options.onSessionCompleted;
    this.runObserver = options.runObserver;
    this.state = options.state;
  }

  attach(backend: BackendClient): void {
    this.eventDisposable = backend.onEvent((event: EventEnvelope) => {
      this.handleBackendEvent(event);
    });

    this.exitDisposable = backend.onExit(({ code, stderr }) => {
      const notice =
        `PI backend stopped${code !== null ? ` (code ${code})` : ''}` +
        (stderr ? `: ${stderr.slice(0, 300)}` : '');
      store.dispatch(uiActions.setNotice(notice));
      store.dispatch(uiActions.setBackendReady(false));
      store.dispatch(sessionsActions.clearRunningPaths());
      this.scheduleRender();
    });
  }

  detach(): void {
    this.eventDisposable?.dispose();
    this.exitDisposable?.dispose();
    this.eventDisposable = undefined;
    this.exitDisposable = undefined;
  }

  applySessionOpened(payload: SessionOpenedPayload): void {
    const {
      session,
      transcript,
      transcriptWindow,
      systemPrompts,
      modelSettings,
      availableModels,
      contextUsage,
      selectionToken,
    } = payload;
    const state = store.getState();
    const selectionRequest = this.state.getSelectionRequest(selectionToken);
    const shouldOpenTab = !!selectionRequest || state.sessions.openTabPaths.includes(session.path);
    const shouldActivate = selectionToken
      ? this.state.isCurrentSelectionToken(selectionToken)
      : selectActiveSessionPath(state) === session.path;

    auditLog(this.context, 'session-service', 'session.opened', {
      selectionToken: selectionToken ?? null,
      sessionPath: session.path,
      shouldActivate,
      shouldOpenTab,
    });

    if (selectionRequest?.pendingPath && selectionRequest.pendingPath !== session.path) {
      store.dispatch(
        sessionsActions.replaceOpenTabPath({
          oldPath: selectionRequest.pendingPath,
          newPath: session.path,
        }),
      );
      store.dispatch(sessionStateActions.replaceSessionPath({
        oldPath: selectionRequest.pendingPath,
        newPath: session.path,
      }));
      this.runObserver.replaceSessionPath(selectionRequest.pendingPath, session.path);
      this.state.clearSessionScope(selectionRequest.pendingPath, true);
    }

    store.dispatch(sessionsActions.upsertSession(session));
    if (shouldOpenTab) {
      store.dispatch(sessionsActions.ensureOpenTab(session.path));
    }

    if (shouldActivate) {
      store.dispatch(sessionsActions.setActiveSessionPath(session.path));
    }
    const transcriptResolution = resolveSessionOpenedTranscript({
      busy: payload.busy,
      incomingTranscript: transcript,
      incomingTranscriptWindow: transcriptWindow,
      localTranscript: store.getState().transcript.bySession[session.path] ?? [],
    });

    const preserveStreamingState = transcriptResolution.preserveLocal && payload.busy;
    store.dispatch(
      transcriptActions.setTranscript({
        sessionPath: session.path,
        transcript: transcriptResolution.transcript,
        transcriptWindow: transcriptResolution.transcriptWindow,
        systemPrompts,
        preserveCurrentTurn: preserveStreamingState,
        preserveAliases: preserveStreamingState,
      }),
    );

    store.dispatch(sessionStateActions.setAnalyticsFactors({
      sessionPath: session.path,
      factors: payload.analyticsFactors ?? null,
    }));
    this.runObserver.onSessionAnalyticsFactorsChanged(session.path, payload.analyticsFactors ?? null);

    if (modelSettings) {
      store.dispatch(settingsActions.setModelSettings(modelSettings));
    }
    if (availableModels) {
      store.dispatch(settingsActions.setAvailableModels({
        sessionPath: session.path,
        availableModels,
      }));
    }
    store.dispatch(settingsActions.setContextUsage({
      sessionPath: session.path,
      contextUsage: contextUsage ?? null,
    }));

    this.state.touchSessionTranscript(session.path);
    this.state.evictInactiveTranscriptWindows();

    this.state.finishSelectionRequest(selectionToken);
    this.state.assertSelectionInvariant('onSessionOpened');

    this.state.saveOpenTabs();
    this.scheduleRender();
  }

  private handleBackendEvent(event: EventEnvelope): void {
    dispatchSessionBackendEvent(event, {
      onSessionOpened: (payload) => this.applySessionOpened(payload),
      onSessionListChanged: (payload) => this.onSessionListChanged(payload),
      onMessageStarted: (payload) => this.onMessageStarted(payload),
      onMessageDelta: (payload) => this.onMessageDelta(payload),
      onMessageThinking: (payload) => this.onMessageThinking(payload),
      onToolStarted: (payload) => this.onToolStarted(payload),
      onToolFinished: (payload) => this.onToolFinished(payload),
      onToolProgress: (payload) => this.onToolProgress(payload),
      onMessageFinished: (payload) => this.onMessageFinished(payload),
      onMessageAborted: (payload) => this.onMessageAborted(payload),
      onBusyChanged: (payload) => this.onBusyChanged(payload),
      onContextUsageChanged: (payload) => this.onContextUsageChanged(payload),
      onError: (payload) => this.onError(payload),
    });
  }

  private onSessionListChanged(payload: SessionListChangedPayload): void {
    store.dispatch(sessionsActions.replaceSessionSummaries(payload.sessions));
    this.scheduleRender();
  }

  private onMessageStarted(payload: MessageStartedPayload): void {
    const sessionPath = this.requireEventSessionPath('message.started', payload.sessionPath);
    if (!sessionPath) {
      return;
    }

    store.dispatch(
      transcriptActions.ensureAssistantMessage({
        sessionPath,
        messageId: payload.messageId,
        requestId: payload.requestId,
        modelId: payload.modelId,
        thinkingLevel: payload.thinkingLevel,
      }),
    );
    this.state.bindRequestSessionPath(payload.requestId, sessionPath);
    this.runObserver.onAssistantTurnStarted(sessionPath, payload.messageId);

    if (payload.modelId) {
      const session = getSessionByPath(store.getState(), sessionPath);
      if (session && (session.modelId !== payload.modelId || session.thinkingLevel !== payload.thinkingLevel)) {
        store.dispatch(sessionsActions.upsertSession({
          ...session,
          modelId: payload.modelId,
          thinkingLevel: payload.thinkingLevel,
        }));
      }
    }

    this.state.touchSessionTranscript(sessionPath);
    this.scheduleRender();
  }

  private onMessageDelta(payload: MessageDeltaPayload): void {
    const sessionPath = this.requireEventSessionPath('message.delta', payload.sessionPath);
    if (!sessionPath) {
      return;
    }

    store.dispatch(
      transcriptActions.appendDelta({
        sessionPath,
        messageId: payload.messageId,
        delta: payload.delta,
      }),
    );

    if (this.state.isActiveSession(sessionPath)) {
      const canonicalId = getCanonicalMessageId(payload.messageId, store.getState());
      this.postPatch({ kind: 'messageDelta', messageId: canonicalId, delta: payload.delta });
    }
  }

  private onMessageThinking(payload: MessageThinkingPayload): void {
    const sessionPath = this.requireEventSessionPath('message.thinking', payload.sessionPath);
    if (!sessionPath) {
      return;
    }

    store.dispatch(
      transcriptActions.appendThinking({
        sessionPath,
        messageId: payload.messageId,
        thinking: payload.thinking,
      }),
    );

    if (this.state.isActiveSession(sessionPath)) {
      const canonicalId = getCanonicalMessageId(payload.messageId, store.getState());
      this.postPatch({
        kind: 'messageThinking',
        messageId: canonicalId,
        thinking: payload.thinking,
      });
    }
  }

  private onToolStarted(payload: ToolStartedPayload): void {
    const sessionPath = this.requireEventSessionPath('tool.started', payload.sessionPath);
    if (!sessionPath) {
      return;
    }

    const canonicalId = getCanonicalMessageId(payload.messageId, store.getState());
    const toolCall = {
      id: payload.toolCallId,
      name: payload.name,
      input: payload.input,
      status: 'running' as const,
    };

    store.dispatch(
      transcriptActions.upsertToolCall({ sessionPath, messageId: canonicalId, toolCall }),
    );
    this.runObserver.onToolStarted(sessionPath, toolCall);

    if (this.state.isActiveSession(sessionPath)) {
      this.postPatch({ kind: 'toolCall', messageId: canonicalId, toolCall });
    }
    this.state.touchSessionTranscript(sessionPath);
    this.scheduleRender();
  }

  private onToolFinished(payload: ToolFinishedPayload): void {
    const sessionPath = this.requireEventSessionPath('tool.finished', payload.sessionPath);
    if (!sessionPath) {
      return;
    }

    const canonicalId = getCanonicalMessageId(payload.messageId, store.getState());
    const existing = store
      .getState()
      .transcript.bySession[sessionPath]
      ?.find((message) => message.id === canonicalId)
      ?.toolCalls?.find((toolCall) => toolCall.id === payload.toolCallId);

    const toolCall = {
      id: payload.toolCallId,
      name: existing?.name ?? '',
      input: existing?.input,
      result: payload.result,
      status: payload.status,
    };

    store.dispatch(
      transcriptActions.upsertToolCall({ sessionPath, messageId: canonicalId, toolCall }),
    );
    this.runObserver.onToolFinished(sessionPath, toolCall);

    if (this.state.isActiveSession(sessionPath)) {
      this.postPatch({ kind: 'toolCall', messageId: canonicalId, toolCall });
    }
    this.state.touchSessionTranscript(sessionPath);
    this.scheduleRender();
  }

  private onToolProgress(payload: ToolProgressPayload): void {
    const sessionPath = this.requireEventSessionPath('tool.progress', payload.sessionPath);
    if (!sessionPath) {
      return;
    }

    const canonicalId = getCanonicalMessageId(payload.messageId, store.getState());
    const existing = store
      .getState()
      .transcript.bySession[sessionPath]
      ?.find((message) => message.id === canonicalId)
      ?.toolCalls?.find((toolCall) => toolCall.id === payload.toolCallId);

    const toolCall = {
      id: payload.toolCallId,
      name: existing?.name ?? '',
      input: existing?.input,
      result: payload.partialResult,
      status: 'running' as const,
    };

    store.dispatch(
      transcriptActions.upsertToolCall({ sessionPath, messageId: canonicalId, toolCall }),
    );

    if (this.state.isActiveSession(sessionPath)) {
      this.postPatch({ kind: 'toolCall', messageId: canonicalId, toolCall });
    }
    this.state.touchSessionTranscript(sessionPath);
    this.scheduleRender();
  }

  private onMessageFinished(payload: MessageFinishedPayload): void {
    const sessionPath = this.requireEventSessionPath('message.finished', payload.sessionPath);
    if (!sessionPath) {
      return;
    }

    store.dispatch(
      transcriptActions.upsertMessage({ sessionPath, message: payload.message }),
    );
    this.runObserver.onAssistantTurnEnded(
      sessionPath,
      payload.message.id,
      payload.message.durationMs ?? 0,
      payload.message.usage,
    );
    this.state.unbindRequestSessionPath(payload.requestId);

    if (this.state.isActiveSession(sessionPath)) {
      const canonicalId = getCanonicalMessageId(payload.message.id, store.getState());
      this.postPatch({ kind: 'clearOverlay', messageIds: [canonicalId] });
    }

    this.state.touchSessionTranscript(sessionPath);
    this.scheduleRender();
  }

  private onMessageAborted(payload: MessageAbortedPayload): void {
    const sessionPath = this.requireEventSessionPath('message.aborted', payload.sessionPath);
    if (!sessionPath) {
      return;
    }

    if (payload.messageId) {
      store.dispatch(
        transcriptActions.setMessageStatus({
          sessionPath,
          messageId: payload.messageId,
          status: 'interrupted',
        }),
      );
    }
    this.runObserver.onInterrupted(sessionPath);
    this.state.touchSessionTranscript(sessionPath);
    this.scheduleRender();
  }

  private onBusyChanged(payload: BusyChangedPayload): void {
    const sessionPath = this.requireEventSessionPath('busy.changed', payload.sessionPath);
    if (!sessionPath) {
      return;
    }

    auditLog(this.context, 'session-service', 'busy.changed', {
      busy: payload.busy,
      seq: payload.seq ?? null,
      sessionPath,
    });

    if (!this.state.acceptBusySeq(sessionPath, payload.seq)) {
      return;
    }

    const state = store.getState();
    const wasRunning = state.sessions.runningSessionPaths.includes(sessionPath);

    if (payload.busy) {
      this.state.clearCompletionSuppression(sessionPath);
    }

    store.dispatch(
      sessionsActions.setSessionRunning({ sessionPath, running: payload.busy }),
    );
    this.runObserver.onBusyChanged(sessionPath, payload.busy);

    if (wasRunning && !payload.busy && !this.state.consumeCompletionSuppression(sessionPath)) {
      if (
        state.sessions.openTabPaths.includes(sessionPath) &&
        shouldFlashFinishedTab({
          suppressNotifications: state.ui.prefs.suppressCompletionNotifications,
          sessionIsActive: state.sessions.activeSessionPath === sessionPath,
        })
      ) {
        store.dispatch(sessionsActions.markSessionFinishedUnread(sessionPath));
      }

      this.onSessionCompleted?.({
        sessionPath,
      });
    }

    this.state.evictInactiveTranscriptWindows();
    this.scheduleRender();
  }

  private onContextUsageChanged(payload: ContextUsageChangedPayload): void {
    const sessionPath = this.requireEventSessionPath('contextUsage.changed', payload.sessionPath);
    if (!sessionPath) {
      return;
    }

    store.dispatch(settingsActions.setContextUsage({
      sessionPath,
      contextUsage: payload.contextUsage ?? null,
    }));
    if (payload.contextUsage) {
      this.runObserver.onContextUsageChanged(
        sessionPath,
        payload.contextUsage.tokens,
        payload.contextUsage.contextWindow,
      );
    }
    this.scheduleRender();
  }

  private onError(payload: ErrorPayload): void {
    this.runObserver.onBackendError(
      this.state.resolveRequestSessionPath(payload.requestId),
      payload.code,
    );
    store.dispatch(uiActions.setNotice(payload.message));
    this.scheduleRender();
  }

  private requireEventSessionPath(eventName: string, sessionPath: string | undefined): string | null {
    if (sessionPath) {
      return sessionPath;
    }

    auditLog(this.context, 'session-service', 'protocol.defect', {
      eventName,
      reason: 'missing sessionPath',
    });
    store.dispatch(uiActions.setNotice(`Protocol defect: ${eventName} arrived without a sessionPath.`));
    this.scheduleRender();
    return null;
  }
}
