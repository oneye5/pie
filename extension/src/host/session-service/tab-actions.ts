import * as vscode from 'vscode';

import { BackendClient } from '../backend/client';
import { type RunObserver } from '../stats-service';
import { auditLog, bootLog } from '../util/audit';
import {
  getNextVisibleTabPathOnClose,
  isPendingTabPath,
  moveOpenTabPath,
} from '../../shared/tab-behavior';
import type { SessionOpenedPayload, SessionSummary } from '../../shared/protocol';
import type { ScheduleRender } from './types';
import { SessionServiceState } from './state';
import type { ArchState } from '../core/arch-state';

interface SessionTabActionsOptions {
  context: vscode.ExtensionContext;
  backend: BackendClient;
  scheduleRender: ScheduleRender;
  runObserver: RunObserver;
  state: SessionServiceState;
  getArchState: () => ArchState;
  mutateArchState: (recipe: (draft: ArchState) => void) => void;
}

/**
 * Merge an existing summary with an incoming one. We preserve a real local name
 * over a backend-emitted placeholder so that "New Session" doesn't clobber a
 * user-meaningful tab label after a list refresh.
 */
function mergeSessionSummary(
  existing: SessionSummary | undefined,
  incoming: SessionSummary,
): SessionSummary {
  if (!existing) return incoming;
  const keepExistingName =
    !existing.isPlaceholder &&
    incoming.isPlaceholder === true;
  return {
    ...incoming,
    name: keepExistingName ? existing.name : incoming.name,
    isPlaceholder: keepExistingName ? false : incoming.isPlaceholder,
    modelId: incoming.modelId ?? existing.modelId,
    thinkingLevel: incoming.thinkingLevel ?? existing.thinkingLevel,
  };
}

export class SessionTabActions {
  private readonly context: vscode.ExtensionContext;
  private readonly backend: BackendClient;
  private readonly scheduleRender: ScheduleRender;
  private readonly runObserver: RunObserver;
  private readonly state: SessionServiceState;
  private readonly getArchState: () => ArchState;
  private readonly mutateArchState: (recipe: (draft: ArchState) => void) => void;

  constructor(options: SessionTabActionsOptions) {
    this.context = options.context;
    this.backend = options.backend;
    this.scheduleRender = options.scheduleRender;
    this.runObserver = options.runObserver;
    this.state = options.state;
    this.getArchState = options.getArchState;
    this.mutateArchState = options.mutateArchState;
  }

  createNewSession(): string {
    const pendingPath = this.state.createPendingSessionPath();
    const cwd = this.getArchState().sessions.workspaceCwd ?? '';
    const selectionToken = this.state.beginSelectionRequest(pendingPath, pendingPath);

    auditLog(this.context, 'session-service', 'session.create.requested', {
      cwd,
      pendingPath,
      selectionToken,
    });

    this.mutateArchState((draft) => {
      // upsertSession
      const incoming: SessionSummary = {
        path: pendingPath,
        name: 'New Session',
        cwd,
        modifiedAt: new Date().toISOString(),
        messageCount: 0,
        isPlaceholder: true,
      };
      const idx = draft.sessions.sessions.findIndex((s) => s.path === incoming.path);
      if (idx === -1) {
        draft.sessions.sessions = [incoming, ...draft.sessions.sessions];
      } else {
        draft.sessions.sessions[idx] = mergeSessionSummary(draft.sessions.sessions[idx], incoming);
      }
      // ensureOpenTab
      if (!draft.sessions.openTabPaths.includes(pendingPath)) {
        draft.sessions.openTabPaths = [...draft.sessions.openTabPaths, pendingPath];
      }
      // setActiveSessionPath
      draft.sessions.activeSessionPath = pendingPath;
      draft.sessions.runningSessionPaths = draft.sessions.runningSessionPaths
        .filter((p) => p !== pendingPath);
      draft.sessions.unreadFinishedSessionPaths = draft.sessions.unreadFinishedSessionPaths
        .filter((p) => p !== pendingPath);
      draft.composer.activeRunSummaryBySession[pendingPath] = null;
    });
    this.state.saveOpenTabs();
    this.scheduleRender();

    void this.state.enqueueLifecycle(async () => {
      await this.backend.request<{ requestId?: string }>('session.create', {
        cwd,
        selectionToken,
      });
    }).catch((err) => {
      this.state.handleSelectionFailure(
        selectionToken,
        `Failed to create session: ${(err as Error).message}`,
      );
    });

    return pendingPath;
  }

  openSession(sessionPath: string): void {
    const archState = this.getArchState();
    const existing = archState.sessions.sessions.find((s) => s.path === sessionPath);
    const wasOpenTab = archState.sessions.openTabPaths.includes(sessionPath);
    const requestEpoch = this.state.bumpSessionDataEpoch(sessionPath);
    const selectionToken = this.state.beginSelectionRequest(
      sessionPath,
      undefined,
      wasOpenTab,
      !existing,
      requestEpoch,
    );

    auditLog(this.context, 'session-service', 'session.open.requested', {
      selectionToken,
      sessionPath,
    });

    bootLog('session-tabs', 'session.open.requested', {
      selectionToken,
      sessionPath,
      wasOpenTab,
      hadExistingSummary: !!existing,
    });

    this.mutateArchState((draft) => {
      if (!existing) {
        // upsertSession placeholder
        const incoming: SessionSummary = {
          path: sessionPath,
          name: 'Loading...',
          isPlaceholder: true,
          cwd: draft.sessions.workspaceCwd ?? '',
          modifiedAt: new Date().toISOString(),
          messageCount: 0,
        };
        const idx = draft.sessions.sessions.findIndex((s) => s.path === incoming.path);
        if (idx === -1) {
          draft.sessions.sessions = [incoming, ...draft.sessions.sessions];
        } else {
          draft.sessions.sessions[idx] = mergeSessionSummary(draft.sessions.sessions[idx], incoming);
        }
      }
      // setActiveSessionPath
      draft.sessions.activeSessionPath = sessionPath;
      draft.sessions.unreadFinishedSessionPaths = draft.sessions.unreadFinishedSessionPaths
        .filter((p) => p !== sessionPath);
      // ensureOpenTab
      if (!draft.sessions.openTabPaths.includes(sessionPath)) {
        draft.sessions.openTabPaths = [...draft.sessions.openTabPaths, sessionPath];
      }
    });
    this.state.touchSessionTranscript(sessionPath);
    this.state.evictInactiveTranscriptWindows();
    this.state.saveOpenTabs();
    this.scheduleRender();

    void this.state.enqueueLifecycle(async () => {
      await this.backend.request('session.open', { sessionPath, selectionToken });
    }).catch((err) => {
      bootLog('session-tabs', 'session.open.failed', {
        selectionToken,
        sessionPath,
        message: (err as Error).message,
      });
      this.state.handleSelectionFailure(
        selectionToken,
        `Failed to open session: ${(err as Error).message}`,
      );
    });
  }

  async closeSession(sessionPath: string): Promise<void> {
    const archState = this.getArchState();
    const nextPath = getNextVisibleTabPathOnClose({
      closingPath: sessionPath,
      openTabPaths: archState.sessions.openTabPaths,
      sessions: archState.sessions.sessions,
      workspaceCwd: archState.sessions.workspaceCwd,
      activeSessionPath: archState.sessions.activeSessionPath,
    });

    auditLog(this.context, 'session-service', 'session.close.requested', {
      nextPath,
      sessionPath,
    });

    this.state.clearSelectionRequestsForPath(sessionPath);

    this.runObserver.onSessionClosed(sessionPath);
    this.mutateArchState((draft) => {
      // removeOpenTab
      draft.sessions.openTabPaths = draft.sessions.openTabPaths.filter((p) => p !== sessionPath);
      draft.sessions.unreadFinishedSessionPaths = draft.sessions.unreadFinishedSessionPaths
        .filter((p) => p !== sessionPath);
    });
    this.state.clearSessionScope(sessionPath);
    this.state.saveOpenTabs();

    if (archState.sessions.activeSessionPath === sessionPath) {
      if (nextPath) {
        if (isPendingTabPath(nextPath)) {
          this.mutateArchState((draft) => {
            draft.sessions.activeSessionPath = nextPath;
            draft.sessions.unreadFinishedSessionPaths = draft.sessions.unreadFinishedSessionPaths
              .filter((p) => p !== nextPath);
          });
        } else {
          const existing = archState.sessions.sessions.find((s) => s.path === nextPath);
          if (existing) {
            this.mutateArchState((draft) => {
              draft.sessions.activeSessionPath = existing.path;
              draft.sessions.unreadFinishedSessionPaths = draft.sessions.unreadFinishedSessionPaths
                .filter((p) => p !== existing.path);
            });
          } else {
            const placeholder: SessionSummary = {
              path: nextPath,
              name: 'Loading...',
              isPlaceholder: true,
              cwd: archState.sessions.workspaceCwd ?? '',
              modifiedAt: new Date().toISOString(),
              messageCount: 0,
            };
            this.mutateArchState((draft) => {
              // upsertSession
              const idx = draft.sessions.sessions.findIndex((s) => s.path === placeholder.path);
              if (idx === -1) {
                draft.sessions.sessions = [placeholder, ...draft.sessions.sessions];
              } else {
                draft.sessions.sessions[idx] = mergeSessionSummary(draft.sessions.sessions[idx], placeholder);
              }
              // setActiveSessionPath
              draft.sessions.activeSessionPath = placeholder.path;
              draft.sessions.unreadFinishedSessionPaths = draft.sessions.unreadFinishedSessionPaths
                .filter((p) => p !== placeholder.path);
            });
            void this.openSession(nextPath);
          }
        }
      } else {
        this.mutateArchState((draft) => {
          draft.sessions.activeSessionPath = null;
        });
      }
    }

    this.state.evictInactiveTranscriptWindows();
    this.state.assertSelectionInvariant('closeSession');
    this.scheduleRender();
  }

  moveSessionTab(sessionPath: string | undefined, fromIndex: number, toIndex: number): void {
    auditLog(this.context, 'session-service', 'session.tab.reorder.requested', {
      sessionPath,
      fromIndex,
      toIndex,
    });

    this.mutateArchState((draft) => {
      draft.sessions.openTabPaths = moveOpenTabPath(draft.sessions.openTabPaths, { sessionPath, fromIndex, toIndex });
    });
    this.state.saveOpenTabs();
    this.state.assertSelectionInvariant('moveSessionTab');
    this.scheduleRender();
  }

  duplicateSession(sourceSessionPath: string): void {
    const archState = this.getArchState();
    const source = archState.sessions.sessions.find((s) => s.path === sourceSessionPath);
    if (!source) {
      this.mutateArchState((draft) => {
        draft.settings.notice = 'Cannot duplicate: session not found.';
      });
      this.scheduleRender();
      return;
    }

    if (isPendingTabPath(sourceSessionPath)) {
      this.mutateArchState((draft) => {
        draft.settings.notice = 'Cannot duplicate: session is still being created.';
      });
      this.scheduleRender();
      return;
    }

    const pendingPath = this.state.createPendingSessionPath();
    const selectionToken = this.state.beginSelectionRequest(pendingPath, pendingPath);

    auditLog(this.context, 'session-service', 'session.duplicate.requested', {
      sourceSessionPath,
      pendingPath,
      selectionToken,
    });

    this.mutateArchState((draft) => {
      // Show a placeholder tab for the duplicate immediately.
      const incoming: SessionSummary = {
        path: pendingPath,
        name: `${source.name} (copy)`,
        cwd: source.cwd,
        modifiedAt: new Date().toISOString(),
        messageCount: source.messageCount,
        isPlaceholder: true,
      };
      // upsertSession
      const idx = draft.sessions.sessions.findIndex((s) => s.path === incoming.path);
      if (idx === -1) {
        draft.sessions.sessions = [incoming, ...draft.sessions.sessions];
      } else {
        draft.sessions.sessions[idx] = mergeSessionSummary(draft.sessions.sessions[idx], incoming);
      }

      // Insert duplicate tab right after the source tab.
      const afterIndex = draft.sessions.openTabPaths.indexOf(sourceSessionPath);
      if (afterIndex === -1) {
        draft.sessions.openTabPaths = [...draft.sessions.openTabPaths, pendingPath];
      } else {
        draft.sessions.openTabPaths = [
          ...draft.sessions.openTabPaths.slice(0, afterIndex + 1),
          pendingPath,
          ...draft.sessions.openTabPaths.slice(afterIndex + 1),
        ];
      }

      // setActiveSessionPath
      draft.sessions.activeSessionPath = pendingPath;
      draft.sessions.runningSessionPaths = draft.sessions.runningSessionPaths
        .filter((p) => p !== pendingPath);
      draft.sessions.unreadFinishedSessionPaths = draft.sessions.unreadFinishedSessionPaths
        .filter((p) => p !== pendingPath);
      draft.composer.activeRunSummaryBySession[pendingPath] = null;
    });

    this.state.saveOpenTabs();
    this.scheduleRender();

    void this.state.enqueueLifecycle(async () => {
      await this.backend.request<SessionOpenedPayload>('session.duplicate', {
        sessionPath: sourceSessionPath,
        selectionToken,
      });
    }).catch((err) => {
      this.state.handleSelectionFailure(
        selectionToken,
        `Failed to duplicate session: ${(err as Error).message}`,
      );
    });
  }
}
