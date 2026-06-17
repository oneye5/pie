import * as vscode from 'vscode';

import { BackendClient } from '../backend/client';
import { type RunObserver } from '../stats-service';
import { auditLog, bootLog } from '../util/audit';
import { toErrorMessage } from '../util/error-message';
import {
  getNextVisibleTabPathOnClose,
  isPendingTabPath,
} from '../../shared/tab-behavior';
import type { SessionOpenedPayload, SessionSummary } from '../../shared/protocol';
import type { ScheduleRender } from './types';
import { SessionServiceState } from './state';
import type { Event } from '../core/events';
import type { ArchState } from '../core/arch-state';

interface SessionTabActionsOptions {
  context: vscode.ExtensionContext;
  backend: BackendClient;
  scheduleRender: ScheduleRender;
  runObserver: RunObserver;
  state: SessionServiceState;
  getArchState: () => ArchState;
  dispatchArch: (event: Event) => void;
}

export class SessionTabActions {
  private readonly context: vscode.ExtensionContext;
  private readonly backend: BackendClient;
  private readonly scheduleRender: ScheduleRender;
  private readonly runObserver: RunObserver;
  private readonly state: SessionServiceState;
  private readonly getArchState: () => ArchState;
  private readonly dispatchArch: (event: Event) => void;

  constructor(options: SessionTabActionsOptions) {
    this.context = options.context;
    this.backend = options.backend;
    this.scheduleRender = options.scheduleRender;
    this.runObserver = options.runObserver;
    this.state = options.state;
    this.getArchState = options.getArchState;
    this.dispatchArch = options.dispatchArch;
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

    const incoming: SessionSummary = {
      path: pendingPath,
      name: 'New Session',
      cwd,
      modifiedAt: new Date().toISOString(),
      messageCount: 0,
      isPlaceholder: true,
    };
    this.dispatchArch({ kind: 'SessionSummaryUpserted', summary: incoming });
    this.dispatchArch({ kind: 'TabOpened', sessionPath: pendingPath });
    this.dispatchArch({ kind: 'Command', cmd: { kind: 'SelectSession', corrId: `select:${Date.now()}`, sessionPath: pendingPath } });
    const runningPaths = this.getArchState().sessions.runningSessionPaths.filter((p) => p !== pendingPath);
    this.dispatchArch({ kind: 'RunningSessionsChanged', sessionPaths: runningPaths });
    this.dispatchArch({ kind: 'ActiveRunSummaryChanged', sessionPath: pendingPath, summary: null });
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
        `Failed to create session: ${toErrorMessage(err)}`,
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

    if (!existing) {
      const incoming: SessionSummary = {
        path: sessionPath,
        name: 'Loading...',
        isPlaceholder: true,
        cwd: archState.sessions.workspaceCwd ?? '',
        modifiedAt: new Date().toISOString(),
        messageCount: 0,
      };
      this.dispatchArch({ kind: 'SessionSummaryUpserted', summary: incoming });
    }
    if (!wasOpenTab) {
      this.dispatchArch({ kind: 'TabOpened', sessionPath });
    }
    this.dispatchArch({ kind: 'Command', cmd: { kind: 'SelectSession', corrId: `select:${Date.now()}`, sessionPath } });
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
        message: toErrorMessage(err),
      });
      this.state.handleSelectionFailure(
        selectionToken,
        `Failed to open session: ${toErrorMessage(err)}`,
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
    this.dispatchArch({ kind: 'Command', cmd: { kind: 'CloseTab', corrId: `close:${Date.now()}`, sessionPath } });
    this.state.clearSessionScope(sessionPath);
    this.state.saveOpenTabs();

    if (archState.sessions.activeSessionPath === sessionPath) {
      if (nextPath) {
        if (isPendingTabPath(nextPath) || archState.sessions.sessions.find((s) => s.path === nextPath)) {
          this.dispatchArch({ kind: 'Command', cmd: { kind: 'SelectSession', corrId: `select:${Date.now()}`, sessionPath: nextPath } });
        } else {
          const placeholder: SessionSummary = {
            path: nextPath,
            name: 'Loading...',
            isPlaceholder: true,
            cwd: archState.sessions.workspaceCwd ?? '',
            modifiedAt: new Date().toISOString(),
            messageCount: 0,
          };
          this.dispatchArch({ kind: 'SessionSummaryUpserted', summary: placeholder });
          this.dispatchArch({ kind: 'Command', cmd: { kind: 'SelectSession', corrId: `select:${Date.now()}`, sessionPath: placeholder.path } });
          void this.openSession(nextPath);
        }
      } else {
        this.dispatchArch({ kind: 'Command', cmd: { kind: 'SelectSession', corrId: `select:${Date.now()}`, sessionPath: '' } });
      }
    }

    this.state.evictInactiveTranscriptWindows();
    this.state.assertSelectionInvariant('closeSession');
    this.scheduleRender();
  }

  duplicateSession(sourceSessionPath: string): void {
    const archState = this.getArchState();
    const source = archState.sessions.sessions.find((s) => s.path === sourceSessionPath);
    if (!source) {
      this.dispatchArch({ kind: 'NoticeShown', notice: 'Cannot duplicate: session not found.' });
      this.scheduleRender();
      return;
    }

    if (isPendingTabPath(sourceSessionPath)) {
      this.dispatchArch({ kind: 'NoticeShown', notice: 'Cannot duplicate: session is still being created.' });
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

    const incoming: SessionSummary = {
      path: pendingPath,
      name: `${source.name} (copy)`,
      cwd: source.cwd,
      modifiedAt: new Date().toISOString(),
      messageCount: source.messageCount,
      isPlaceholder: true,
    };
    this.dispatchArch({ kind: 'SessionSummaryUpserted', summary: incoming });
    this.dispatchArch({ kind: 'TabOpened', sessionPath: pendingPath, insertAfter: sourceSessionPath });
    this.dispatchArch({ kind: 'Command', cmd: { kind: 'SelectSession', corrId: `select:${Date.now()}`, sessionPath: pendingPath } });
    const runningPaths = this.getArchState().sessions.runningSessionPaths.filter((p) => p !== pendingPath);
    this.dispatchArch({ kind: 'RunningSessionsChanged', sessionPaths: runningPaths });
    this.dispatchArch({ kind: 'ActiveRunSummaryChanged', sessionPath: pendingPath, summary: null });

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
        `Failed to duplicate session: ${toErrorMessage(err)}`,
      );
    });
  }
}
