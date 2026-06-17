import * as crypto from 'node:crypto';

import * as vscode from 'vscode';

import { type RunObserver } from '../stats-service';
import { auditLog, bootLog } from '../util/audit';
import {
  getNextVisibleTabPathOnClose,
  isPendingTabPath,
} from '../../shared/tab-behavior';
import type { SessionSummary } from '../../shared/protocol';
import type { ScheduleRender } from './types';
import { SessionServiceState } from './state';
import type { Event } from '../core/events';
import type { ArchState } from '../core/arch-state';

interface SessionTabActionsOptions {
  context: vscode.ExtensionContext;
  scheduleRender: ScheduleRender;
  runObserver: RunObserver;
  state: SessionServiceState;
  getArchState: () => ArchState;
  dispatchArch: (event: Event) => void;
}

export class SessionTabActions {
  private readonly context: vscode.ExtensionContext;
  private readonly scheduleRender: ScheduleRender;
  private readonly runObserver: RunObserver;
  private readonly state: SessionServiceState;
  private readonly getArchState: () => ArchState;
  private readonly dispatchArch: (event: Event) => void;

  constructor(options: SessionTabActionsOptions) {
    this.context = options.context;
    this.scheduleRender = options.scheduleRender;
    this.runObserver = options.runObserver;
    this.state = options.state;
    this.getArchState = options.getArchState;
    this.dispatchArch = options.dispatchArch;
  }

  createNewSession(): string {
    // Host-side entry: generate the impure bits the reducer can't (pending
    // path counter + Date.now/Math.random, placeholder modifiedAt, and the
    // selection token), then dispatch the CreateSession Command. The reducer
    // owns the optimistic tab setup (placeholder summary, tab open, select,
    // running state, active-run summary) and emits PersistTabs + CreateSession;
    // the runner owns the backend session.create RPC + failure recovery.
    //
    // beginSelectionRequest MUST run before the Command dispatch: it snapshots
    // `previousActivePath` (the active tab before the create) so failure
    // recovery can restore it. The reducer synchronously sets activeSessionPath
    // = pending during the dispatch, so calling beginSelectionRequest after
    // would snapshot the pending path instead. Returns the pending path
    // synchronously so the composer fallback caller can address the new
    // session immediately.
    const pendingPath = this.state.createPendingSessionPath();
    const cwd = this.getArchState().sessions.workspaceCwd ?? '';
    const selectionToken = this.state.beginSelectionRequest(pendingPath, pendingPath);

    const placeholderSummary: SessionSummary = {
      path: pendingPath,
      name: 'New Session',
      cwd,
      modifiedAt: new Date().toISOString(),
      messageCount: 0,
      isPlaceholder: true,
    };

    auditLog(this.context, 'session-service', 'session.create.requested', {
      cwd,
      pendingPath,
      selectionToken,
    });

    this.dispatchArch({
      kind: 'Command',
      cmd: {
        kind: 'CreateSession',
        corrId: crypto.randomUUID(),
        sessionPath: pendingPath,
        cwd,
        placeholderSummary,
        selectionToken,
      },
    });
    this.scheduleRender();

    return pendingPath;
  }

  openSession(sessionPath: string): void {
    // Host-side entry: generate the impure bits the reducer can't (the data
    // epoch + Date.now placeholder modifiedAt + the selection token), then
    // dispatch the OpenSession Command. The reducer owns the optimistic tab
    // setup (placeholder summary, tab open, select, unread-finished clear) and
    // emits PersistTabs + OpenSession; the runner owns the backend session.open
    // RPC + failure recovery.
    //
    // beginSelectionRequest MUST run before the Command dispatch: it snapshots
    // `previousActivePath` (the active tab before the open) so failure recovery
    // can restore it. The reducer synchronously sets activeSessionPath =
    // sessionPath during the dispatch, so calling beginSelectionRequest after
    // would snapshot the opened path instead. The epoch is bumped before the
    // token so attach.ts can detect stale session.opened payloads for this
    // open. Mirrors createNewSession.
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

    const placeholderSummary: SessionSummary | null = existing
      ? null
      : {
        path: sessionPath,
        name: 'Loading...',
        isPlaceholder: true,
        cwd: archState.sessions.workspaceCwd ?? '',
        modifiedAt: new Date().toISOString(),
        messageCount: 0,
      };

    this.dispatchArch({
      kind: 'Command',
      cmd: {
        kind: 'OpenSession',
        corrId: crypto.randomUUID(),
        sessionPath,
        placeholderSummary,
        selectionToken,
      },
    });

    // Host-side transcript-window LRU: touch the opened session + evict inactive
    // windows. Stays host-side (Phase 3/4 folds these reads into the reducer).
    this.state.touchSessionTranscript(sessionPath);
    this.state.evictInactiveTranscriptWindows();
    this.scheduleRender();
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
    // Host-side entry: generate the impure bits the reducer can't (pending
    // path counter + Date.now placeholder modifiedAt + the selection token),
    // then dispatch the DuplicateSession Command. The reducer owns the
    // optimistic tab setup (placeholder copy summary, tab open adjacent to the
    // source, select, running state, active-run summary) and emits PersistTabs
    // + DuplicateSession; the runner owns the backend session.duplicate RPC +
    // failure recovery. Mirrors createNewSession.
    //
    // beginSelectionRequest MUST run before the Command dispatch: it snapshots
    // `previousActivePath` (the active tab before the duplicate) so failure
    // recovery can restore it. The reducer synchronously sets activeSessionPath
    // = pending during the dispatch, so calling beginSelectionRequest after
    // would snapshot the pending path instead.
    //
    // Guards stay host-side: a missing/pending source can't build a
    // placeholder (the source's name/cwd/messageCount are read here) and
    // dispatches no Command, so there is no optimistic change to revert.
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

    const placeholderSummary: SessionSummary = {
      path: pendingPath,
      name: `${source.name} (copy)`,
      cwd: source.cwd,
      modifiedAt: new Date().toISOString(),
      messageCount: source.messageCount,
      isPlaceholder: true,
    };

    auditLog(this.context, 'session-service', 'session.duplicate.requested', {
      sourceSessionPath,
      pendingPath,
      selectionToken,
    });

    this.dispatchArch({
      kind: 'Command',
      cmd: {
        kind: 'DuplicateSession',
        corrId: crypto.randomUUID(),
        sessionPath: pendingPath,
        sourceSessionPath,
        placeholderSummary,
        selectionToken,
      },
    });
    this.scheduleRender();
  }
}
