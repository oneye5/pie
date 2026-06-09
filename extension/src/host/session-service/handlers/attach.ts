import * as vscode from 'vscode';
import type { RunObserver } from '../../stats-service';
import type { ArchState } from '../../core/arch-state';
import type { SessionServiceState } from '../state';
import type { BackendEvent } from '../../core/events';
import type { OnSessionPathResolved, OnSessionCompleted } from '../types';
import type { BusyChangedPayload, SessionOpenedPayload } from '../../../shared/protocol';
import { resolveSessionOpenedTranscript } from '../../core/session-opened-transcript';
import { deriveFileChangesFromTranscript } from '../../core/file-change-derivation';
import { deriveAvailableExtensions } from './session.js';
import { bootLog, auditLog } from '../../util/audit';
import { shouldFlashFinishedTab } from '../../sidebar/completion-notification';

interface ApplySessionOpenedDeps {
  getArchState: () => ArchState;
  mutateArchState: (recipe: (draft: ArchState) => void) => void;
  dispatchArch: (event: BackendEvent) => void;
  runObserver: RunObserver;
  scheduleRender: () => void;
  context: vscode.ExtensionContext;
  onSessionPathResolved?: OnSessionPathResolved;
  state: SessionServiceState;
}

export function applySessionOpenedPayload(
  payload: SessionOpenedPayload,
  deps: ApplySessionOpenedDeps,
): void {
  const { session, selectionToken } = payload;
  const flags = computeOpeningFlags(payload, deps);

  logSessionOpened(payload, deps, flags);

  handlePendingPathReplacement(deps, flags.selectionRequest, session.path);

  const transcriptResolution = resolveAndDispatch(payload, deps, session.path, flags.staleSessionData);

  applyPostDispatchState(deps, payload, session.path, flags, transcriptResolution.transcript);

  finalizeSessionOpening(deps, session.path, selectionToken, flags.selectionRequest);
}

function computeOpeningFlags(payload: SessionOpenedPayload, deps: ApplySessionOpenedDeps) {
  const { session, selectionToken } = payload;
  const selectionRequest = deps.state.getSelectionRequest(selectionToken);
  const staleSessionData = selectionRequest?.requestEpoch !== undefined
    && deps.state.getSessionDataEpoch(session.path) !== selectionRequest.requestEpoch;
  const shouldOpenTab = !!selectionRequest || deps.getArchState().sessions.openTabPaths.includes(session.path);
  const shouldActivate = selectionToken
    ? deps.state.isCurrentSelectionToken(selectionToken)
    : (deps.getArchState().sessions.activeSessionPath === session.path
        || (!!selectionRequest?.pendingPath
            && selectionRequest.pendingPath !== session.path
            && deps.getArchState().sessions.activeSessionPath === selectionRequest.pendingPath));

  return { selectionRequest, staleSessionData, shouldOpenTab, shouldActivate };
}

function logSessionOpened(
  payload: SessionOpenedPayload,
  deps: ApplySessionOpenedDeps,
  flags: ReturnType<typeof computeOpeningFlags>,
): void {
  const { session, selectionToken } = payload;
  bootLog('session-service', 'session.opened', {
    selectionToken: selectionToken ?? null,
    sessionPath: session.path,
    shouldActivate: flags.shouldActivate,
    shouldOpenTab: flags.shouldOpenTab,
    staleSessionData: flags.staleSessionData,
    activeSessionPath: deps.getArchState().sessions.activeSessionPath,
    isCurrentSelectionToken: selectionToken ? deps.state.isCurrentSelectionToken(selectionToken) : 'no-token',
  });

  bootLog('session-events', 'session.opened', {
    activeSessionPath: deps.getArchState().sessions.activeSessionPath,
    selectionToken: selectionToken ?? null,
    sessionPath: session.path,
    shouldActivate: flags.shouldActivate,
    shouldOpenTab: flags.shouldOpenTab,
    transcriptLoaded: true,
  });
}

function handlePendingPathReplacement(
  deps: ApplySessionOpenedDeps,
  selectionRequest: ReturnType<typeof computeOpeningFlags>['selectionRequest'],
  sessionPath: string,
): void {
  if (!selectionRequest?.pendingPath || selectionRequest.pendingPath === sessionPath) {
    return;
  }

  const pendingPath = selectionRequest.pendingPath;

  deps.mutateArchState((draft) => {
    draft.sessions.openTabPaths = draft.sessions.openTabPaths.map(
      (p: string) => (p === pendingPath ? sessionPath : p),
    );
    draft.sessions.unreadFinishedSessionPaths = [
      ...new Set(draft.sessions.unreadFinishedSessionPaths
        .map((p: string) => (p === pendingPath ? sessionPath : p))),
    ];
    const oldInputs = draft.composer.pendingComposerInputsBySession[pendingPath];
    if (oldInputs) {
      const existingInputs = draft.composer.pendingComposerInputsBySession[sessionPath] ?? [];
      draft.composer.pendingComposerInputsBySession[sessionPath] = [...existingInputs, ...oldInputs];
      delete draft.composer.pendingComposerInputsBySession[pendingPath];
    }
    if (Object.prototype.hasOwnProperty.call(draft.composer.activeRunSummaryBySession, pendingPath)) {
      draft.composer.activeRunSummaryBySession[sessionPath] =
        draft.composer.activeRunSummaryBySession[pendingPath] ?? null;
      delete draft.composer.activeRunSummaryBySession[pendingPath];
    }
    if (Object.prototype.hasOwnProperty.call(draft.sessions.analyticsFactorsBySession, pendingPath)) {
      draft.sessions.analyticsFactorsBySession[sessionPath] =
        draft.sessions.analyticsFactorsBySession[pendingPath] ?? null;
      delete draft.sessions.analyticsFactorsBySession[pendingPath];
    }
  });

  deps.runObserver.replaceSessionPath(pendingPath, sessionPath);
  deps.state.clearSessionScope(pendingPath, true);
}

function resolveAndDispatch(
  payload: SessionOpenedPayload,
  deps: ApplySessionOpenedDeps,
  sessionPath: string,
  staleSessionData: boolean,
) {
  const localTranscript = deps.getArchState().transcript.bySession[sessionPath] ?? [];
  const transcriptResolution = resolveSessionOpenedTranscript({
    busy: payload.busy || staleSessionData,
    incomingTranscript: payload.transcript,
    incomingTranscriptWindow: payload.transcriptWindow,
    localTranscript,
  });
  const preserveStreamingState = transcriptResolution.preserveLocal && (payload.busy || staleSessionData);

  const resolvedPayload: SessionOpenedPayload = {
    ...payload,
    transcript: transcriptResolution.transcript,
    transcriptWindow: transcriptResolution.transcriptWindow,
    ...(preserveStreamingState && { systemPrompts: undefined }),
  };

  deps.dispatchArch({
    kind: 'SessionOpened',
    sessionPath,
    payload: resolvedPayload,
  });

  return transcriptResolution;
}

function applyPostDispatchState(
  deps: ApplySessionOpenedDeps,
  payload: SessionOpenedPayload,
  sessionPath: string,
  flags: ReturnType<typeof computeOpeningFlags>,
  transcript: any[],
): void {
  deps.mutateArchState((draft) => {
    if (flags.shouldOpenTab && !draft.sessions.openTabPaths.includes(sessionPath)) {
      draft.sessions.openTabPaths.push(sessionPath);
    }
    if (flags.shouldActivate) {
      draft.sessions.activeSessionPath = sessionPath;
      draft.sessions.unreadFinishedSessionPaths = draft.sessions.unreadFinishedSessionPaths
        .filter((p) => p !== sessionPath);
    }
    if (
      !flags.shouldActivate
      && flags.selectionRequest?.pendingPath
      && flags.selectionRequest.pendingPath !== sessionPath
      && draft.sessions.activeSessionPath === flags.selectionRequest.pendingPath
    ) {
      draft.sessions.activeSessionPath = sessionPath;
    }
    if (payload.analyticsFactors) {
      draft.settings.availableExtensions = deriveAvailableExtensions(
        payload.analyticsFactors.selectedToolIds,
      );
    }
    draft.fileChanges.bySession[sessionPath] = deriveFileChangesFromTranscript(transcript);
  });
}

function finalizeSessionOpening(
  deps: ApplySessionOpenedDeps,
  sessionPath: string,
  selectionToken: SessionOpenedPayload['selectionToken'],
  selectionRequest: ReturnType<typeof computeOpeningFlags>['selectionRequest'],
): void {
  deps.state.touchSessionTranscript(sessionPath);
  deps.state.evictInactiveTranscriptWindows();
  deps.state.finishSelectionRequest(selectionToken);
  deps.state.assertSelectionInvariant('onSessionOpened');
  deps.state.saveOpenTabs();
  deps.scheduleRender();

  if (selectionRequest?.pendingPath && selectionRequest.pendingPath !== sessionPath) {
    deps.onSessionPathResolved?.(selectionRequest.pendingPath, sessionPath);
  }
}

export function handleBusyChangedPayload(
  payload: BusyChangedPayload,
  sessionPath: string,
  deps: {
    getArchState: () => ArchState;
    mutateArchState: (recipe: (draft: ArchState) => void) => void;
    dispatchArch: (event: BackendEvent) => void;
    runObserver: RunObserver;
    scheduleRender: () => void;
    context: vscode.ExtensionContext;
    state: SessionServiceState;
    onSessionCompleted?: OnSessionCompleted;
  },
): void {
  auditLog(deps.context, 'session-service', 'busy.changed', {
    busy: payload.busy,
    seq: payload.seq ?? null,
    sessionPath,
  });

  if (!deps.state.acceptBusySeq(sessionPath, payload.seq)) {
    return;
  }

  const wasRunning = deps.getArchState().sessions.runningSessionPaths.includes(sessionPath);

  if (payload.busy) {
    deps.state.clearCompletionSuppression(sessionPath);
  }

  deps.dispatchArch({
    kind: 'BusyChanged',
    sessionPath,
    running: payload.busy,
  });
  deps.runObserver.onBusyChanged(sessionPath, payload.busy);

  // Clear pending extension UI request when the session finishes.
  if (!payload.busy) {
    if (deps.getArchState().settings.pendingExtensionUIRequest) {
      deps.mutateArchState((draft) => {
        draft.settings.pendingExtensionUIRequest = null;
      });
    }
  }

  if (wasRunning && !payload.busy && !deps.state.consumeCompletionSuppression(sessionPath)) {
    if (
      deps.getArchState().sessions.openTabPaths.includes(sessionPath) &&
      shouldFlashFinishedTab({
        suppressNotifications: deps.getArchState().settings.prefs.suppressCompletionNotifications,
        sessionIsActive: deps.getArchState().sessions.activeSessionPath === sessionPath,
      })
    ) {
      deps.mutateArchState((draft) => {
        if (!draft.sessions.unreadFinishedSessionPaths.includes(sessionPath)) {
          draft.sessions.unreadFinishedSessionPaths.push(sessionPath);
        }
      });
    }

    deps.onSessionCompleted?.({
      sessionPath,
    });
  }

  deps.state.evictInactiveTranscriptWindows();
  deps.scheduleRender();
}

interface AttachDeps {
  context: vscode.ExtensionContext;
  scheduleRender: () => void;
  runObserver: RunObserver;
  mutateArchState: (recipe: (draft: ArchState) => void) => void;
  state: SessionServiceState;
  getArchState: () => ArchState;
  dispatchArch: (event: BackendEvent) => void;
  onSessionCompleted?: OnSessionCompleted;
}

export function attach(
  backend: {
    onEvent: (handler: (event: any) => void) => vscode.Disposable;
    onExit: (handler: (info: { code: number | null; stderr: string }) => void) => vscode.Disposable;
  },
  deps: AttachDeps,
  handlers: {
    handleBackendEvent: (event: any) => void;
  },
): vscode.Disposable[] {
  const eventDisposable = backend.onEvent((event: any) => {
    handlers.handleBackendEvent(event);
  });

  const exitDisposable = backend.onExit(({ code, stderr }) => {
    const notice =
      `PI backend stopped${code !== null ? ` (code ${code})` : ''}` +
      (stderr ? `: ${stderr.slice(0, 300)}` : '');
    bootLog('session-events', 'backend.exited', {
      code,
      notice,
    });
    deps.mutateArchState((draft) => {
      draft.settings.notice = notice;
      draft.settings.backendReady = false;
      draft.sessions.runningSessionPaths = [];
    });
    deps.scheduleRender();
  });

  return [eventDisposable, exitDisposable];
}

export function detach(disposables: vscode.Disposable[]): void {
  for (const d of disposables) {
    d.dispose();
  }
}
