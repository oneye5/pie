import * as vscode from 'vscode';

import { BackendClient } from '../backend/client';
import { assertInvariant, auditLog } from '../util/audit';
import {
  fileChangesActions,
  sessionStateActions,
  sessionsActions,
  settingsActions,
  selectActiveSessionPath,
  store,
  transcriptActions,
  uiActions,
} from '../store';
import {
  PENDING_SESSION_PREFIX,
  isPendingTabPath,
} from '../../shared/tab-behavior';
import { TRANSCRIPT_WINDOW_BUDGETS } from '../../shared/transcript-window';
import type { SessionOpenedPayload } from '../../shared/protocol';
import type { ScheduleRender, SelectionRequest } from './types';

const OPEN_TABS_STORAGE_KEY = 'openTabPaths';
const ACTIVE_SESSION_STORAGE_KEY = 'activeSessionPath';

export class SessionServiceState {
  private readonly busySeqMap = new Map<string, number>();
  private lifecycleQueue = Promise.resolve();
  private readonly sessionOperationQueues = new Map<string, Promise<void>>();
  private readonly selectionRequests = new Map<string, SelectionRequest>();
  private readonly sessionDataEpochs = new Map<string, number>();
  private readonly preloadingSessionPaths = new Set<string>();
  private readonly suppressNextCompletionNotification = new Set<string>();
  private readonly requestSessionPathById = new Map<string, string>();
  private readonly transcriptTouchedAtBySession = new Map<string, number>();
  private pendingSessionCounter = 0;
  private composerInputCounter = 0;
  private selectionRequestCounter = 0;
  private currentSelectionToken: string | null = null;
  private onPreloadedSessionOpened?: (payload: SessionOpenedPayload) => void;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly backend: BackendClient,
    private readonly scheduleRender: ScheduleRender,
  ) {}

  setPreloadedSessionOpenedHandler(handler: (payload: SessionOpenedPayload) => void): void {
    this.onPreloadedSessionOpened = handler;
  }

  resetRuntimeState(): void {
    this.busySeqMap.clear();
    this.lifecycleQueue = Promise.resolve();
    this.sessionOperationQueues.clear();
    this.selectionRequests.clear();
    this.sessionDataEpochs.clear();
    this.preloadingSessionPaths.clear();
    this.suppressNextCompletionNotification.clear();
    this.requestSessionPathById.clear();
    this.transcriptTouchedAtBySession.clear();
    this.currentSelectionToken = null;
  }

  createPendingSessionPath(): string {
    this.pendingSessionCounter += 1;
    return `${PENDING_SESSION_PREFIX}${Date.now()}-${this.pendingSessionCounter}-${Math.random().toString(36).slice(2, 8)}`;
  }

  createComposerInputId(): string {
    this.composerInputCounter += 1;
    return `input:${Date.now()}:${this.composerInputCounter}`;
  }

  beginSelectionRequest(
    requestedPath: string,
    pendingPath?: string,
    wasOpenTab = false,
    insertedPlaceholder = false,
    requestEpoch?: number,
  ): string {
    this.selectionRequestCounter += 1;
    const token = `selection:${this.selectionRequestCounter}`;
    this.selectionRequests.set(token, {
      insertedPlaceholder,
      token,
      requestedPath,
      pendingPath,
      previousActivePath: selectActiveSessionPath(store.getState()),
      wasOpenTab,
      requestEpoch,
    });
    this.currentSelectionToken = token;
    return token;
  }

  getSelectionRequest(selectionToken?: string): SelectionRequest | null {
    if (!selectionToken) {
      return null;
    }
    return this.selectionRequests.get(selectionToken) ?? null;
  }

  isCurrentSelectionToken(selectionToken?: string): boolean {
    return !!selectionToken && this.currentSelectionToken === selectionToken;
  }

  finishSelectionRequest(selectionToken?: string): void {
    if (!selectionToken) {
      return;
    }

    this.selectionRequests.delete(selectionToken);
    if (this.currentSelectionToken === selectionToken) {
      this.currentSelectionToken = null;
    }
  }

  clearSelectionRequestsForPath(sessionPath: string): void {
    for (const [token, request] of this.selectionRequests) {
      if (request.pendingPath === sessionPath) {
        if (this.currentSelectionToken === token) {
          this.currentSelectionToken = null;
        }
        continue;
      }
      if (request.requestedPath === sessionPath) {
        this.selectionRequests.delete(token);
        if (this.currentSelectionToken === token) {
          this.currentSelectionToken = null;
        }
      }
    }
  }

  handleSelectionFailure(selectionToken: string, notice: string): void {
    const request = this.selectionRequests.get(selectionToken);
    const ownsSelection = this.currentSelectionToken === selectionToken;
    this.finishSelectionRequest(selectionToken);

    if (request) {
      if (request.pendingPath) {
        this.clearSessionScope(request.pendingPath, true);
      } else if (!request.wasOpenTab) {
        store.dispatch(sessionsActions.removeOpenTab(request.requestedPath));
        this.clearSessionScope(request.requestedPath, request.insertedPlaceholder);
      }

      if (ownsSelection) {
        const fallbackPath = request.previousActivePath && store.getState().sessions.openTabPaths.includes(request.previousActivePath)
          ? request.previousActivePath
          : store.getState().sessions.openTabPaths[0] ?? null;
        store.dispatch(sessionsActions.setActiveSessionPath(fallbackPath));
      }
      this.saveOpenTabs();
    }

    store.dispatch(uiActions.setNotice(notice));
    this.assertSelectionInvariant('handleSelectionFailure');
    this.scheduleRender();
  }

  enqueueLifecycle<T>(task: () => Promise<T>): Promise<T> {
    const next = this.lifecycleQueue.catch(() => undefined).then(task);
    this.lifecycleQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  enqueueSessionOperation<T>(sessionPath: string, task: () => Promise<T>): Promise<T> {
    const previous = this.sessionOperationQueues.get(sessionPath) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(task);
    const barrier = result.then(() => undefined, () => undefined);

    this.sessionOperationQueues.set(sessionPath, barrier);
    void barrier.finally(() => {
      if (this.sessionOperationQueues.get(sessionPath) === barrier) {
        this.sessionOperationQueues.delete(sessionPath);
      }
    });

    return result;
  }

  getSessionDataEpoch(sessionPath: string): number {
    return this.sessionDataEpochs.get(sessionPath) ?? 0;
  }

  bumpSessionDataEpoch(sessionPath: string): number {
    const next = this.getSessionDataEpoch(sessionPath) + 1;
    this.sessionDataEpochs.set(sessionPath, next);
    return next;
  }

  bindRequestSessionPath(requestId: string, sessionPath: string): void {
    this.requestSessionPathById.set(requestId, sessionPath);
  }

  unbindRequestSessionPath(requestId: string): void {
    this.requestSessionPathById.delete(requestId);
  }

  resolveRequestSessionPath(requestId: string | undefined): string | undefined {
    return requestId ? this.requestSessionPathById.get(requestId) : undefined;
  }

  acceptBusySeq(sessionPath: string, seq: number | undefined): boolean {
    if (typeof seq !== 'number') {
      return true;
    }

    const last = this.busySeqMap.get(sessionPath) ?? 0;
    if (seq <= last) {
      return false;
    }
    this.busySeqMap.set(sessionPath, seq);
    return true;
  }

  suppressNextCompletionNotificationFor(sessionPath: string): void {
    this.suppressNextCompletionNotification.add(sessionPath);
  }

  clearCompletionSuppression(sessionPath: string): void {
    this.suppressNextCompletionNotification.delete(sessionPath);
  }

  consumeCompletionSuppression(sessionPath: string): boolean {
    return this.suppressNextCompletionNotification.delete(sessionPath);
  }

  touchSessionTranscript(sessionPath: string): void {
    this.transcriptTouchedAtBySession.set(sessionPath, Date.now());
  }

  evictInactiveTranscriptWindows(): void {
    const currentState = store.getState();
    const activeSessionPath = currentState.sessions.activeSessionPath;
    const runningPaths = new Set(currentState.sessions.runningSessionPaths);
    const now = Date.now();

    const inactivePaths = currentState.sessions.openTabPaths
      .filter((sessionPath) => (
        !!sessionPath
        && sessionPath !== activeSessionPath
        && !isPendingTabPath(sessionPath)
        && !runningPaths.has(sessionPath)
      ))
      .sort((left, right) => (
        (this.transcriptTouchedAtBySession.get(right) ?? 0)
        - (this.transcriptTouchedAtBySession.get(left) ?? 0)
      ));

    const warmKeepCount = 1;

    inactivePaths.forEach((sessionPath, index) => {
      const transcript = store.getState().transcript.bySession[sessionPath] ?? [];
      if (transcript.length === 0) {
        return;
      }

      const touchedAt = this.transcriptTouchedAtBySession.get(sessionPath) ?? 0;
      const staleByTtl = now - touchedAt >= TRANSCRIPT_WINDOW_BUDGETS.inactiveTtlMs;
      const shouldTrimTail = transcript.length > TRANSCRIPT_WINDOW_BUDGETS.inactiveTailCount;
      if (!shouldTrimTail) {
        return;
      }
      if (!staleByTtl && index < warmKeepCount) {
        return;
      }

      store.dispatch(transcriptActions.trimTranscriptForInactivity({
        sessionPath,
        keepTailCount: TRANSCRIPT_WINDOW_BUDGETS.inactiveTailCount,
      }));
    });
  }

  clearSessionScope(sessionPath: string, removeSessionSummary = false): void {
    this.busySeqMap.delete(sessionPath);
    this.sessionOperationQueues.delete(sessionPath);
    this.sessionDataEpochs.delete(sessionPath);
    this.preloadingSessionPaths.delete(sessionPath);
    this.suppressNextCompletionNotification.delete(sessionPath);
    this.transcriptTouchedAtBySession.delete(sessionPath);
    for (const [requestId, mappedSessionPath] of this.requestSessionPathById) {
      if (mappedSessionPath === sessionPath) {
        this.requestSessionPathById.delete(requestId);
      }
    }
    store.dispatch(transcriptActions.clearSessionState(sessionPath));
    store.dispatch(settingsActions.clearAvailableModels(sessionPath));
    store.dispatch(settingsActions.clearContextUsage(sessionPath));
    store.dispatch(sessionStateActions.clearSessionState(sessionPath));
    store.dispatch(fileChangesActions.clearFileChanges(sessionPath));
    if (removeSessionSummary) {
      store.dispatch(sessionsActions.removeSession(sessionPath));
    }
  }

  assertSelectionInvariant(source: string): void {
    const state = store.getState();
    const activeSessionPath = selectActiveSessionPath(state);
    assertInvariant(
      this.context,
      'session-service',
      !activeSessionPath || state.sessions.openTabPaths.includes(activeSessionPath),
      'Active session path must always reference an open tab.',
      {
        activeSessionPath,
        openTabPaths: state.sessions.openTabPaths,
        source,
      },
    );
  }

  isActiveSession(sessionPath: string): boolean {
    return selectActiveSessionPath(store.getState()) === sessionPath;
  }

  saveOpenTabs(): void {
    const { openTabPaths, sessions, activeSessionPath } = store.getState().sessions;

    const tabObjects = openTabPaths
      .filter((p) => !isPendingTabPath(p))
      .map((p) => {
        const session = sessions.find((s) => s.path === p);
        return session ? { path: p, name: session.name } : { path: p };
      });

    const persistedActiveSessionPath =
      activeSessionPath
      && !isPendingTabPath(activeSessionPath)
      && openTabPaths.includes(activeSessionPath)
        ? activeSessionPath
        : undefined;

    void this.context.globalState.update(OPEN_TABS_STORAGE_KEY, tabObjects);
    void this.context.globalState.update(ACTIVE_SESSION_STORAGE_KEY, persistedActiveSessionPath);
  }

  preloadSessions(sessionPaths: readonly string[]): void {
    for (const sessionPath of sessionPaths) {
      this.preloadSession(sessionPath);
    }
  }

  preloadSession(sessionPath: string): void {
    if (!sessionPath || isPendingTabPath(sessionPath)) {
      return;
    }

    if (this.preloadingSessionPaths.has(sessionPath)) {
      return;
    }

    if (Object.prototype.hasOwnProperty.call(store.getState().transcript.bySession, sessionPath)) {
      return;
    }

    this.preloadingSessionPaths.add(sessionPath);
    const requestEpoch = this.getSessionDataEpoch(sessionPath);
    void this.backend.request<SessionOpenedPayload>('session.preload', { sessionPath })
      .then((payload) => {
        if (this.getSessionDataEpoch(sessionPath) !== requestEpoch) {
          return;
        }
        if (!store.getState().sessions.openTabPaths.includes(sessionPath)) {
          return;
        }
        this.onPreloadedSessionOpened?.(payload);
      })
      .catch((error) => {
        auditLog(this.context, 'session-service', 'session.preload.failed', {
          sessionPath,
          message: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        this.preloadingSessionPaths.delete(sessionPath);
      });
  }
}
