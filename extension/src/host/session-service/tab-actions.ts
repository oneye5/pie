import * as vscode from 'vscode';

import { BackendClient } from '../backend/client';
import { type RunObserver } from '../stats-service';
import { auditLog } from '../util/audit';
import {
  getSessionByPath,
  sessionsActions,
  store,
} from '../store';
import {
  getNextVisibleTabPathOnClose,
  isPendingTabPath,
} from '../../shared/tab-behavior';
import type { SessionSummary } from '../../shared/protocol';
import type { ScheduleRender } from './types';
import { SessionServiceState } from './state';

interface SessionTabActionsOptions {
  context: vscode.ExtensionContext;
  backend: BackendClient;
  scheduleRender: ScheduleRender;
  runObserver: RunObserver;
  state: SessionServiceState;
}

export class SessionTabActions {
  private readonly context: vscode.ExtensionContext;
  private readonly backend: BackendClient;
  private readonly scheduleRender: ScheduleRender;
  private readonly runObserver: RunObserver;
  private readonly state: SessionServiceState;

  constructor(options: SessionTabActionsOptions) {
    this.context = options.context;
    this.backend = options.backend;
    this.scheduleRender = options.scheduleRender;
    this.runObserver = options.runObserver;
    this.state = options.state;
  }

  createNewSession(): string {
    const pendingPath = this.state.createPendingSessionPath();
    const cwd = store.getState().sessions.workspaceCwd ?? '';
    const selectionToken = this.state.beginSelectionRequest(pendingPath, pendingPath);

    auditLog(this.context, 'session-service', 'session.create.requested', {
      cwd,
      pendingPath,
      selectionToken,
    });

    store.dispatch(
      sessionsActions.upsertSession({
        path: pendingPath,
        name: 'New Session',
        cwd,
        modifiedAt: new Date().toISOString(),
        messageCount: 0,
        isPlaceholder: true,
      }),
    );
    store.dispatch(sessionsActions.ensureOpenTab(pendingPath));
    store.dispatch(sessionsActions.setActiveSessionPath(pendingPath));
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
    const existing = getSessionByPath(store.getState(), sessionPath);
    const wasOpenTab = store.getState().sessions.openTabPaths.includes(sessionPath);
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

    if (!existing) {
      store.dispatch(
        sessionsActions.upsertSession({
          path: sessionPath,
          name: 'Loading...',
          isPlaceholder: true,
          cwd: store.getState().sessions.workspaceCwd ?? '',
          modifiedAt: new Date().toISOString(),
          messageCount: 0,
        }),
      );
    }
    store.dispatch(sessionsActions.setActiveSessionPath(sessionPath));
    store.dispatch(sessionsActions.ensureOpenTab(sessionPath));
    this.state.touchSessionTranscript(sessionPath);
    this.state.evictInactiveTranscriptWindows();
    this.state.saveOpenTabs();
    this.scheduleRender();

    void this.state.enqueueLifecycle(async () => {
      await this.backend.request('session.open', { sessionPath, selectionToken });
    }).catch((err) => {
      this.state.handleSelectionFailure(
        selectionToken,
        `Failed to open session: ${(err as Error).message}`,
      );
    });
  }

  async closeSession(sessionPath: string): Promise<void> {
    const state = store.getState();
    const nextPath = getNextVisibleTabPathOnClose({
      closingPath: sessionPath,
      openTabPaths: state.sessions.openTabPaths,
      sessions: state.sessions.sessions,
      workspaceCwd: state.sessions.workspaceCwd,
      activeSessionPath: state.sessions.activeSessionPath,
    });

    auditLog(this.context, 'session-service', 'session.close.requested', {
      nextPath,
      sessionPath,
    });

    this.state.clearSelectionRequestsForPath(sessionPath);

    this.runObserver.onSessionClosed(sessionPath);
    store.dispatch(sessionsActions.removeOpenTab(sessionPath));
    this.state.clearSessionScope(sessionPath);
    this.state.saveOpenTabs();

    if (state.sessions.activeSessionPath === sessionPath) {
      if (nextPath) {
        if (isPendingTabPath(nextPath)) {
          store.dispatch(sessionsActions.setActiveSessionPath(nextPath));
        } else {
          const existing = getSessionByPath(state, nextPath);
          if (existing) {
            store.dispatch(sessionsActions.setActiveSessionPath(existing.path));
          } else {
            const placeholder: SessionSummary = {
              path: nextPath,
              name: 'Loading...',
              isPlaceholder: true,
              cwd: state.sessions.workspaceCwd ?? '',
              modifiedAt: new Date().toISOString(),
              messageCount: 0,
            };
            store.dispatch(sessionsActions.upsertSession(placeholder));
            store.dispatch(sessionsActions.setActiveSessionPath(placeholder.path));
          }

          void this.openSession(nextPath);
        }
      } else {
        store.dispatch(sessionsActions.clearActiveSession());
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

    store.dispatch(sessionsActions.moveOpenTab({ sessionPath, fromIndex, toIndex }));
    this.state.saveOpenTabs();
    this.state.assertSelectionInvariant('moveSessionTab');
    this.scheduleRender();
  }
}
