import * as vscode from 'vscode';

import { BackendClient } from '../backend/client';
import { shouldFlashFinishedTab, requestWindowAttention } from '../sidebar/completion-notification';
import { resolveSessionOpenedTranscript } from './session-opened-transcript';
import { type RunObserver } from '../stats-service';
import { auditLog, bootLog } from '../util/audit';
import {
  fileChangesActions,
  getSessionByPath,
  selectActiveSessionPath,
  sessionStateActions,
  settingsActions,
  sessionsActions,
  store,
  transcriptActions,
  uiActions,
} from '../store';
import { deriveFileChangeFromToolCall, deriveFileChangesFromTranscript } from '../store/file-changes-slice';
import type {
  BusyChangedPayload,
  ContextUsageChangedPayload,
  CustomMessagePayload,
  ErrorPayload,
  EventEnvelope,
  ExtensionInfo,
  ExtensionUIRequestPayload,
  MessageAbortedPayload,
  MessageDeltaPayload,
  MessageFinishedPayload,
  MessageStartedPayload,
  MessageThinkingPayload,
  SessionListChangedPayload,
  SessionOpenedPayload,
  ToolFinishedPayload,
  ToolProgressPayload,
  ToolStartedPayload,
} from '../../shared/protocol';
import { dispatchSessionBackendEvent } from './event-dispatch';
import type { DispatchArchEvent, OnSessionCompleted, OnSessionPathResolved, ScheduleRender } from './types';
import { SessionServiceState } from './state';

interface SessionServiceEventsOptions {
  context: vscode.ExtensionContext;
  scheduleRender: ScheduleRender;
  onSessionCompleted?: OnSessionCompleted;
  onSessionPathResolved?: OnSessionPathResolved;
  runObserver: RunObserver;
  state: SessionServiceState;
}

export class SessionServiceEvents {
  private readonly context: vscode.ExtensionContext;
  private readonly scheduleRender: ScheduleRender;
  private readonly onSessionCompleted?: OnSessionCompleted;
  private readonly onSessionPathResolved?: OnSessionPathResolved;
  private readonly runObserver: RunObserver;
  private readonly state: SessionServiceState;
  private eventDisposable?: vscode.Disposable;
  private exitDisposable?: vscode.Disposable;
  private dispatchArch?: DispatchArchEvent;

  constructor(options: SessionServiceEventsOptions) {
    this.context = options.context;
    this.scheduleRender = options.scheduleRender;
    this.onSessionCompleted = options.onSessionCompleted;
    this.onSessionPathResolved = options.onSessionPathResolved;
    this.runObserver = options.runObserver;
    this.state = options.state;
  }

  setArchDispatch(dispatch: DispatchArchEvent): void {
    this.dispatchArch = dispatch;
  }

  attach(backend: BackendClient): void {
    this.eventDisposable = backend.onEvent((event: EventEnvelope) => {
      this.handleBackendEvent(event);
    });

    this.exitDisposable = backend.onExit(({ code, stderr }) => {
      const notice =
        `PI backend stopped${code !== null ? ` (code ${code})` : ''}` +
        (stderr ? `: ${stderr.slice(0, 300)}` : '');
      bootLog('session-events', 'backend.exited', {
        code,
        notice,
      });
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
    const staleSessionData = selectionRequest?.requestEpoch !== undefined
      && this.state.getSessionDataEpoch(session.path) !== selectionRequest.requestEpoch;
    const shouldOpenTab = !!selectionRequest || state.sessions.openTabPaths.includes(session.path);
    const shouldActivate = selectionToken
      ? this.state.isCurrentSelectionToken(selectionToken)
      : selectActiveSessionPath(state) === session.path;

    auditLog(this.context, 'session-service', 'session.opened', {
      selectionToken: selectionToken ?? null,
      sessionPath: session.path,
      shouldActivate,
      shouldOpenTab,
      staleSessionData,
    });

    bootLog('session-events', 'session.opened', {
      activeSessionPath: selectActiveSessionPath(state),
      selectionToken: selectionToken ?? null,
      sessionPath: session.path,
      shouldActivate,
      shouldOpenTab,
      transcriptLoaded: true,
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
      busy: payload.busy || staleSessionData,
      incomingTranscript: transcript,
      incomingTranscriptWindow: transcriptWindow,
      localTranscript: store.getState().transcript.bySession[session.path] ?? [],
    });

    const preserveStreamingState = transcriptResolution.preserveLocal && (payload.busy || staleSessionData);
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

    if (payload.analyticsFactors) {
      store.dispatch(uiActions.setAvailableExtensions(
        deriveAvailableExtensions(payload.analyticsFactors.selectedToolIds),
      ));
    }

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

    // Derive file changes from the loaded transcript
    const derivedChanges = deriveFileChangesFromTranscript(transcriptResolution.transcript);
    store.dispatch(fileChangesActions.setFileChanges({
      sessionPath: session.path,
      changes: derivedChanges,
    }));

    this.state.touchSessionTranscript(session.path);
    this.state.evictInactiveTranscriptWindows();

    this.state.finishSelectionRequest(selectionToken);
    this.state.assertSelectionInvariant('onSessionOpened');

    this.state.saveOpenTabs();
    this.scheduleRender();

    // Drain any queued sends that arrived while the session was pending.
    if (selectionRequest?.pendingPath && selectionRequest.pendingPath !== session.path) {
      this.onSessionPathResolved?.(selectionRequest.pendingPath, session.path);
    }
  }

  handleBackendEvent(event: EventEnvelope): void {
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
      onCustomMessage: (payload) => this.onCustomMessage(payload),
      onMessageAborted: (payload) => this.onMessageAborted(payload),
      onBusyChanged: (payload) => this.onBusyChanged(payload),
      onContextUsageChanged: (payload) => this.onContextUsageChanged(payload),
      onExtensionUIRequest: (payload) => this.onExtensionUIRequest(payload),
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

    if (this.dispatchArch) {
      this.dispatchArch({
        kind: 'MessageStarted',
        sessionPath,
        messageId: payload.messageId,
        requestId: payload.requestId,
        modelId: payload.modelId,
        thinkingLevel: payload.thinkingLevel,
      });
    } else {
      store.dispatch(
        transcriptActions.ensureAssistantMessage({
          sessionPath,
          messageId: payload.messageId,
          requestId: payload.requestId,
          modelId: payload.modelId,
          thinkingLevel: payload.thinkingLevel,
        }),
      );
      this.scheduleRender();
    }

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
  }

  private onMessageDelta(payload: MessageDeltaPayload): void {
    const sessionPath = this.requireEventSessionPath('message.delta', payload.sessionPath);
    if (!sessionPath) {
      return;
    }

    if (this.dispatchArch) {
      this.dispatchArch({
        kind: 'MessageDelta',
        sessionPath,
        messageId: payload.messageId,
        delta: payload.delta,
      });
    } else {
      store.dispatch(
        transcriptActions.appendDelta({
          sessionPath,
          messageId: payload.messageId,
          delta: payload.delta,
        }),
      );
      this.scheduleRender();
    }
  }

  private onMessageThinking(payload: MessageThinkingPayload): void {
    const sessionPath = this.requireEventSessionPath('message.thinking', payload.sessionPath);
    if (!sessionPath) {
      return;
    }

    if (this.dispatchArch) {
      this.dispatchArch({
        kind: 'MessageThinking',
        sessionPath,
        messageId: payload.messageId,
        thinking: payload.thinking,
      });
    } else {
      store.dispatch(
        transcriptActions.appendThinking({
          sessionPath,
          messageId: payload.messageId,
          thinking: payload.thinking,
        }),
      );
      this.scheduleRender();
    }
  }

  private onToolStarted(payload: ToolStartedPayload): void {
    const sessionPath = this.requireEventSessionPath('tool.started', payload.sessionPath);
    if (!sessionPath) {
      return;
    }

    const toolCall = {
      id: payload.toolCallId,
      name: payload.name,
      input: payload.input,
      status: 'running' as const,
      startedAt: payload.startedAt,
    };

    if (this.dispatchArch) {
      this.dispatchArch({
        kind: 'ToolCall',
        sessionPath,
        messageId: payload.messageId,
        toolCall,
      });
    } else {
      store.dispatch(
        transcriptActions.upsertToolCall({ sessionPath, messageId: payload.messageId, toolCall }),
      );
      this.scheduleRender();
    }
    this.runObserver.onToolStarted(sessionPath, toolCall);

    // Track file changes from file-modifying tools
    const fileChange = deriveFileChangeFromToolCall(
      { id: payload.toolCallId, name: payload.name, input: payload.input },
      payload.messageId,
      new Date().toISOString(),
    );
    console.log('[pie:fileChanges] onToolStarted', { name: payload.name, hasInput: !!payload.input, inputType: typeof payload.input, fileChange: fileChange ? fileChange.path : null });
    if (fileChange) {
      store.dispatch(fileChangesActions.addFileChange({ sessionPath, change: fileChange }));
      // Ensure the webview receives the file-change update even when the arch
      // dispatch path has already scheduled its own render (the debounce timer
      // from that ScheduleRender effect may have already been set before this
      // dispatch, leaving the store update invisible to the next snapshot).
      this.scheduleRender();
    }

    this.state.touchSessionTranscript(sessionPath);
  }

  private onToolFinished(payload: ToolFinishedPayload): void{
    const sessionPath = this.requireEventSessionPath('tool.finished', payload.sessionPath);
    if (!sessionPath) {
      return;
    }

    // Look up existing tool call by toolCallId to carry forward name/input.
    const existing = store
      .getState()
      .transcript.bySession[sessionPath]
      ?.flatMap((message) => message.toolCalls ?? [])
      .find((toolCall) => toolCall.id === payload.toolCallId);

    const toolCall = {
      id: payload.toolCallId,
      name: existing?.name ?? '',
      input: existing?.input,
      result: payload.result,
      status: payload.status,
      startedAt: existing?.startedAt,
      durationMs: payload.durationMs,
    };

    if (this.dispatchArch) {
      this.dispatchArch({
        kind: 'ToolCall',
        sessionPath,
        messageId: payload.messageId,
        toolCall,
      });
    } else {
      store.dispatch(
        transcriptActions.upsertToolCall({ sessionPath, messageId: payload.messageId, toolCall }),
      );
      this.scheduleRender();
    }
    this.runObserver.onToolFinished(sessionPath, toolCall);

    this.state.touchSessionTranscript(sessionPath);
  }

  private onToolProgress(payload: ToolProgressPayload): void {
    const sessionPath = this.requireEventSessionPath('tool.progress', payload.sessionPath);
    if (!sessionPath) {
      return;
    }

    // Look up existing tool call by toolCallId to carry forward name/input.
    const existing = store
      .getState()
      .transcript.bySession[sessionPath]
      ?.flatMap((message) => message.toolCalls ?? [])
      .find((toolCall) => toolCall.id === payload.toolCallId);

    const toolCall = {
      id: payload.toolCallId,
      name: existing?.name ?? '',
      input: existing?.input,
      result: payload.partialResult,
      status: 'running' as const,
      startedAt: existing?.startedAt,
    };

    if (this.dispatchArch) {
      this.dispatchArch({
        kind: 'ToolCall',
        sessionPath,
        messageId: payload.messageId,
        toolCall,
      });
    } else {
      store.dispatch(
        transcriptActions.upsertToolCall({ sessionPath, messageId: payload.messageId, toolCall }),
      );
      this.scheduleRender();
    }

    this.state.touchSessionTranscript(sessionPath);
  }

  private onMessageFinished(payload: MessageFinishedPayload): void {
    const sessionPath = this.requireEventSessionPath('message.finished', payload.sessionPath);
    if (!sessionPath) {
      return;
    }

    // Stamp errorDetail on error messages so the webview can display the reason.
    const message = payload.message;
    if (message.status === 'error' && !message.errorDetail) {
      const notice = store.getState().ui.notice;
      if (notice) {
        message.errorDetail = notice;
      }
    }

    if (this.dispatchArch) {
      this.dispatchArch({
        kind: 'MessageFinished',
        sessionPath,
        message,
      });
    } else {
      store.dispatch(
        transcriptActions.upsertMessage({ sessionPath, message }),
      );
      this.scheduleRender();
    }
    this.runObserver.onAssistantTurnEnded(
      sessionPath,
      message.id,
      message.durationMs ?? 0,
      message.usage,
    );
    this.state.unbindRequestSessionPath(payload.requestId);

    // MessageFinished replaces the streaming entry with its authoritative form.
    // The next snapshot diff naturally produces the content replacement.
    this.state.touchSessionTranscript(sessionPath);
  }

  private onCustomMessage(payload: CustomMessagePayload): void {
    const sessionPath = this.requireEventSessionPath('message.custom', payload.sessionPath);
    if (!sessionPath) {
      return;
    }

    store.dispatch(
      transcriptActions.upsertMessage({ sessionPath, message: payload.message }),
    );
    this.scheduleRender();
    this.state.touchSessionTranscript(sessionPath);
  }

  private onMessageAborted(payload: MessageAbortedPayload): void {
    const sessionPath = this.requireEventSessionPath('message.aborted', payload.sessionPath);
    if (!sessionPath) {
      return;
    }

    if (this.dispatchArch) {
      this.dispatchArch({
        kind: 'MessageAborted',
        sessionPath,
        messageId: payload.messageId,
      });
    } else if (payload.messageId) {
      store.dispatch(
        transcriptActions.setMessageStatus({
          sessionPath,
          messageId: payload.messageId,
          status: 'interrupted',
        }),
      );
      this.scheduleRender();
    }

    this.runObserver.onInterrupted(sessionPath);
    this.state.touchSessionTranscript(sessionPath);
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

    // Clear pending extension UI request when the session finishes.
    if (!payload.busy && store.getState().ui.pendingExtensionUIRequest) {
      store.dispatch(uiActions.setPendingExtensionUIRequest(null));
    }

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

  private onExtensionUIRequest(payload: ExtensionUIRequestPayload): void {
    if (payload.method === 'notify') {
      // Notify is fire-and-forget; use the notice banner instead of blocking the prompt slot.
      const prefix = payload.notifyType === 'error' ? 'Error' : payload.notifyType === 'warning' ? 'Warning' : 'Info';
      store.dispatch(uiActions.setNotice(`${prefix}: ${payload.message}`));
      return;
    }
    store.dispatch(uiActions.setPendingExtensionUIRequest(payload));

    // Flash the VS Code window to draw the user's attention to the question.
    requestWindowAttention(
      vscode.env.appName,
      vscode.workspace.name ?? vscode.workspace.workspaceFolders?.[0]?.name,
    );

    this.scheduleRender();
  }

  private onError(payload: ErrorPayload): void {
    // STATE_CONTRACT: errors must be addressed by the requestId binding alone.
    // We must NOT fall back to the active session, because the failing operation
    // may belong to a backgrounded tab; stamping the error on whatever is active
    // pollutes the wrong transcript and confuses the user.
    const sessionPath = this.state.resolveRequestSessionPath(payload.requestId);
    this.runObserver.onBackendError(sessionPath ?? undefined, payload.code);
    store.dispatch(uiActions.setNotice(payload.message));
    if (sessionPath) {
      store.dispatch(transcriptActions.setMessageError({ sessionPath, errorDetail: payload.message }));
    } else {
      auditLog(this.context, 'session-service', 'protocol.defect', {
        eventName: 'error',
        reason: 'missing or unresolved requestId',
        code: payload.code ?? null,
      });
    }
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

/**
 * Known pi extensions and the tool IDs they register.
 * Hook-only extensions (safeguard) are listed by name since they
 * don't register tools but still participate in every session.
 */
const KNOWN_EXTENSIONS: ExtensionInfo[] = [
  { id: 'subagent', label: 'Subagent', description: 'Delegate tasks to specialized sub-agents' },
  { id: 'safeguard', label: 'Safeguard', description: 'Block dangerous shell commands and file writes' },
  { id: 'cwd-skills', label: 'CWD Skills', description: 'Auto-discover skills from the working directory' },
  { id: 'skill-pruner', label: 'Skill Pruner', description: 'Score and prune skill descriptions by relevance' },
];

const TOOL_TO_EXTENSION: Record<string, string> = {
  subagent: 'subagent',
};

/** Derive available extensions from selected tool IDs + known hook-only extensions. */
function deriveAvailableExtensions(selectedToolIds: string[]): ExtensionInfo[] {
  const activeExtensionIds = new Set<string>();
  for (const toolId of selectedToolIds) {
    const extId = TOOL_TO_EXTENSION[toolId];
    if (extId) {
      activeExtensionIds.add(extId);
    }
  }
  // Always include known hook-only extensions (they're active if the extension is loaded).
  // The backend doesn't expose hook registration, so we include them by convention.
  activeExtensionIds.add('safeguard');
  activeExtensionIds.add('cwd-skills');
  activeExtensionIds.add('skill-pruner');

  return KNOWN_EXTENSIONS.filter((ext) => activeExtensionIds.has(ext.id));
}
