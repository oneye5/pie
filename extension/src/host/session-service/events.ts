import * as vscode from 'vscode';
import { produce } from 'immer';

import { BackendClient } from '../backend/client';
import { shouldFlashFinishedTab, requestWindowAttention } from '../sidebar/completion-notification';
import { resolveSessionOpenedTranscript } from '../core/session-opened-transcript';
import { type RunObserver } from '../stats-service';
import { auditLog, bootLog } from '../util/audit';
import { deriveFileChangeFromToolCall, deriveFileChangesFromTranscript } from '../core/file-change-derivation';
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
import { dispatchSessionBackendEvent } from '../core/event-dispatch';
import type { OnSessionCompleted, OnSessionPathResolved, ScheduleRender } from './types';
import type { BackendEvent } from '../core/events';
import type { ArchState } from '../core/arch-state';
import { SessionServiceState } from './state';

interface SessionServiceEventsOptions {
  context: vscode.ExtensionContext;
  scheduleRender: ScheduleRender;
  onSessionCompleted?: OnSessionCompleted;
  onSessionPathResolved?: OnSessionPathResolved;
  runObserver: RunObserver;
  state: SessionServiceState;
  dispatchArch: (event: BackendEvent) => void;
  getArchState: () => ArchState;
  mutateArchState: (recipe: (draft: ArchState) => void) => void;
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
  private readonly dispatchArch: (event: BackendEvent) => void;
  private readonly getArchState: () => ArchState;
  private readonly mutateArchState: (recipe: (draft: ArchState) => void) => void;

  constructor(options: SessionServiceEventsOptions) {
    this.context = options.context;
    this.scheduleRender = options.scheduleRender;
    this.onSessionCompleted = options.onSessionCompleted;
    this.onSessionPathResolved = options.onSessionPathResolved;
    this.runObserver = options.runObserver;
    this.dispatchArch = options.dispatchArch;
    this.state = options.state;
    this.getArchState = options.getArchState;
    this.mutateArchState = options.mutateArchState;
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
      this.mutateArchState((draft) => {
        draft.settings.notice = notice;
        draft.settings.backendReady = false;
        draft.sessions.runningSessionPaths = [];
      });
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
    const archState = this.getArchState();
    const selectionRequest = this.state.getSelectionRequest(selectionToken);
    const staleSessionData = selectionRequest?.requestEpoch !== undefined
      && this.state.getSessionDataEpoch(session.path) !== selectionRequest.requestEpoch;
    const shouldOpenTab = !!selectionRequest || archState.sessions.openTabPaths.includes(session.path);
    const shouldActivate = selectionToken
      ? this.state.isCurrentSelectionToken(selectionToken)
      : archState.sessions.activeSessionPath === session.path;

    auditLog(this.context, 'session-service', 'session.opened', {
      selectionToken: selectionToken ?? null,
      sessionPath: session.path,
      shouldActivate,
      shouldOpenTab,
      staleSessionData,
    });

    bootLog('session-events', 'session.opened', {
      activeSessionPath: archState.sessions.activeSessionPath,
      selectionToken: selectionToken ?? null,
      sessionPath: session.path,
      shouldActivate,
      shouldOpenTab,
      transcriptLoaded: true,
    });

    if (selectionRequest?.pendingPath && selectionRequest.pendingPath !== session.path) {
      const pendingPath = selectionRequest.pendingPath;
      this.mutateArchState((draft) => {
        // replaceOpenTabPath
        draft.sessions.openTabPaths = draft.sessions.openTabPaths.map(
          (p) => (p === pendingPath ? session.path : p),
        );
        draft.sessions.unreadFinishedSessionPaths = [
          ...new Set(draft.sessions.unreadFinishedSessionPaths
            .map((p) => (p === pendingPath ? session.path : p))),
        ];
        // replaceSessionPath for session state (composer inputs, run summaries, analytics)
        const oldInputs = draft.composer.pendingComposerInputsBySession[pendingPath];
        if (oldInputs) {
          const existingInputs = draft.composer.pendingComposerInputsBySession[session.path] ?? [];
          draft.composer.pendingComposerInputsBySession[session.path] = [...existingInputs, ...oldInputs];
          delete draft.composer.pendingComposerInputsBySession[pendingPath];
        }
        if (Object.prototype.hasOwnProperty.call(draft.composer.activeRunSummaryBySession, pendingPath)) {
          draft.composer.activeRunSummaryBySession[session.path] =
            draft.composer.activeRunSummaryBySession[pendingPath] ?? null;
          delete draft.composer.activeRunSummaryBySession[pendingPath];
        }
        if (Object.prototype.hasOwnProperty.call(draft.sessions.analyticsFactorsBySession, pendingPath)) {
          draft.sessions.analyticsFactorsBySession[session.path] =
            draft.sessions.analyticsFactorsBySession[pendingPath] ?? null;
          delete draft.sessions.analyticsFactorsBySession[pendingPath];
        }
      });
      this.runObserver.replaceSessionPath(pendingPath, session.path);
      this.state.clearSessionScope(pendingPath, true);
    }

    // Resolve transcript: merge local ephemeral state with incoming authoritative data.
    const localTranscript = archState.transcript.bySession[session.path] ?? [];
    const transcriptResolution = resolveSessionOpenedTranscript({
      busy: payload.busy || staleSessionData,
      incomingTranscript: transcript,
      incomingTranscriptWindow: transcriptWindow,
      localTranscript,
    });
    const preserveStreamingState = transcriptResolution.preserveLocal && (payload.busy || staleSessionData);

    // Build modified payload with resolved transcript and conditionally preserve system prompts.
    const resolvedPayload: SessionOpenedPayload = {
      ...payload,
      transcript: transcriptResolution.transcript,
      transcriptWindow: transcriptResolution.transcriptWindow,
      ...(preserveStreamingState && { systemPrompts: undefined }),
    };

    this.dispatchArch({
      kind: 'SessionOpened',
      sessionPath: session.path,
      payload: resolvedPayload,
    });

    // Post-dispatch: handle state the reducer doesn't manage.
    this.mutateArchState((draft) => {
      if (shouldOpenTab && !draft.sessions.openTabPaths.includes(session.path)) {
        draft.sessions.openTabPaths.push(session.path);
      }
      if (shouldActivate) {
        draft.sessions.activeSessionPath = session.path;
        draft.sessions.unreadFinishedSessionPaths = draft.sessions.unreadFinishedSessionPaths
          .filter((p) => p !== session.path);
      }
      if (payload.analyticsFactors) {
        draft.settings.availableExtensions = deriveAvailableExtensions(
          payload.analyticsFactors.selectedToolIds,
        );
      }
      // Derive file changes from the resolved transcript
      draft.fileChanges.bySession[session.path] = deriveFileChangesFromTranscript(
        transcriptResolution.transcript,
      );
    });

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
    this.dispatchArch({ kind: 'SessionListChanged', sessionSummaries: payload.sessions });
    this.scheduleRender();
  }

  private onMessageStarted(payload: MessageStartedPayload): void {
    const sessionPath = this.requireEventSessionPath('message.started', payload.sessionPath);
    if (!sessionPath) {
      return;
    }

    this.dispatchArch({
      kind: 'MessageStarted',
      sessionPath,
      messageId: payload.messageId,
      requestId: payload.requestId,
      modelId: payload.modelId,
      thinkingLevel: payload.thinkingLevel,
    });

    this.state.bindRequestSessionPath(payload.requestId, sessionPath);
    this.runObserver.onAssistantTurnStarted(sessionPath, payload.messageId);

    if (payload.modelId) {
      const archState = this.getArchState();
      const session = archState.sessions.sessions.find((s) => s.path === sessionPath);
      if (session && (session.modelId !== payload.modelId || session.thinkingLevel !== payload.thinkingLevel)) {
        this.mutateArchState((draft) => {
          const idx = draft.sessions.sessions.findIndex((s) => s.path === sessionPath);
          if (idx !== -1) {
            draft.sessions.sessions[idx] = {
              ...draft.sessions.sessions[idx],
              modelId: payload.modelId,
              thinkingLevel: payload.thinkingLevel,
            };
          }
        });
      }
    }

    this.state.touchSessionTranscript(sessionPath);
  }

  private onMessageDelta(payload: MessageDeltaPayload): void {
    const sessionPath = this.requireEventSessionPath('message.delta', payload.sessionPath);
    if (!sessionPath) {
      return;
    }

    this.dispatchArch({
      kind: 'MessageDelta',
      sessionPath,
      messageId: payload.messageId,
      delta: payload.delta,
    });
  }

  private onMessageThinking(payload: MessageThinkingPayload): void {
    const sessionPath = this.requireEventSessionPath('message.thinking', payload.sessionPath);
    if (!sessionPath) {
      return;
    }

    this.dispatchArch({
      kind: 'MessageThinking',
      sessionPath,
      messageId: payload.messageId,
      thinking: payload.thinking,
    });
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

    this.dispatchArch({
      kind: 'ToolCall',
      sessionPath,
      messageId: payload.messageId,
      toolCall,
    });
    this.runObserver.onToolStarted(sessionPath, toolCall);

    // Track file changes from file-modifying tools
    const fileChange = deriveFileChangeFromToolCall(
      { id: payload.toolCallId, name: payload.name, input: payload.input },
      payload.messageId,
      new Date().toISOString(),
    );
    console.log('[pie:fileChanges] onToolStarted', { name: payload.name, hasInput: !!payload.input, inputType: typeof payload.input, fileChange: fileChange ? fileChange.path : null });
    if (fileChange) {
      this.mutateArchState((draft) => {
        const list = (draft.fileChanges.bySession[sessionPath] ??= []);
        const existingIdx = list.findIndex((entry) => entry.path === fileChange.path);
        if (existingIdx !== -1) {
          const existing = list[existingIdx];
          const change = fileChange;
          if (change.kind === 'deleted' && existing.kind === 'created') {
            list.splice(existingIdx, 1);
            return;
          }
          const additions = (existing.additions ?? 0) + (change.additions ?? 0);
          const deletions = (existing.deletions ?? 0) + (change.deletions ?? 0);
          list[existingIdx] = {
            ...change,
            ...(additions > 0 && { additions }),
            ...(deletions > 0 && { deletions }),
          };
        } else {
          list.push(fileChange);
        }
      });
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
    const existing = this.getArchState()
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

    this.dispatchArch({
      kind: 'ToolCall',
      sessionPath,
      messageId: payload.messageId,
      toolCall,
    });
    this.runObserver.onToolFinished(sessionPath, toolCall);

    this.state.touchSessionTranscript(sessionPath);
  }

  private onToolProgress(payload: ToolProgressPayload): void {
    const sessionPath = this.requireEventSessionPath('tool.progress', payload.sessionPath);
    if (!sessionPath) {
      return;
    }

    // Look up existing tool call by toolCallId to carry forward name/input.
    const existing = this.getArchState()
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

    this.dispatchArch({
      kind: 'ToolCall',
      sessionPath,
      messageId: payload.messageId,
      toolCall,
    });

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
      const notice = this.getArchState().settings.notice;
      if (notice) {
        message.errorDetail = notice;
      }
    }

    this.dispatchArch({
      kind: 'MessageFinished',
      sessionPath,
      message,
    });
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

    this.dispatchArch({
      kind: 'CustomMessage',
      sessionPath,
      message: payload.message,
    });
    this.scheduleRender();
    this.state.touchSessionTranscript(sessionPath);
  }

  private onMessageAborted(payload: MessageAbortedPayload): void {
    const sessionPath = this.requireEventSessionPath('message.aborted', payload.sessionPath);
    if (!sessionPath) {
      return;
    }

    this.dispatchArch({
      kind: 'MessageAborted',
      sessionPath,
      messageId: payload.messageId,
    });

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

    const archState = this.getArchState();
    const wasRunning = archState.sessions.runningSessionPaths.includes(sessionPath);

    if (payload.busy) {
      this.state.clearCompletionSuppression(sessionPath);
    }

    this.dispatchArch({
      kind: 'BusyChanged',
      sessionPath,
      running: payload.busy,
    });
    this.runObserver.onBusyChanged(sessionPath, payload.busy);

    // Clear pending extension UI request when the session finishes.
    if (!payload.busy) {
      const postState = this.getArchState();
      if (postState.settings.pendingExtensionUIRequest) {
        this.mutateArchState((draft) => {
          draft.settings.pendingExtensionUIRequest = null;
        });
      }
    }

    if (wasRunning && !payload.busy && !this.state.consumeCompletionSuppression(sessionPath)) {
      const postState = this.getArchState();
      if (
        postState.sessions.openTabPaths.includes(sessionPath) &&
        shouldFlashFinishedTab({
          suppressNotifications: postState.settings.prefs.suppressCompletionNotifications,
          sessionIsActive: postState.sessions.activeSessionPath === sessionPath,
        })
      ) {
        this.mutateArchState((draft) => {
          if (!draft.sessions.unreadFinishedSessionPaths.includes(sessionPath)) {
            draft.sessions.unreadFinishedSessionPaths.push(sessionPath);
          }
        });
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

    this.dispatchArch({
      kind: 'ContextUsageChanged',
      sessionPath,
      contextUsage: payload.contextUsage ?? null,
    });
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
      this.dispatchArch({ kind: 'Error', sessionPath: '', error: `${prefix}: ${payload.message}` });
      return;
    }
    this.dispatchArch({ kind: 'ExtensionUIRequest', sessionPath: '', request: payload });

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
    this.dispatchArch({ kind: 'Error', sessionPath: sessionPath ?? '', error: payload.message });
    if (sessionPath) {
      this.mutateArchState((draft) => {
        const list = draft.transcript.bySession[sessionPath];
        if (!list) return;
        const reversed = [...list].reverse();
        const msg = reversed.find(
          (m) => m.role === 'assistant' && (m.status === 'streaming' || m.status === 'error'),
        ) ?? reversed.find((m) => m.role === 'assistant');
        if (msg) {
          msg.status = 'error';
          msg.errorDetail = payload.message;
        }
      });
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
    this.dispatchArch({
      kind: 'Error',
      sessionPath: '',
      error: `Protocol defect: ${eventName} arrived without a sessionPath.`,
    });
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
