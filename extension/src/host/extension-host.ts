import * as cp from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import * as vscode from 'vscode';

const EMPTY_DIFF_SCHEME = 'pie-empty-diff';

class EmptyDiffContentProvider implements vscode.TextDocumentContentProvider {
  provideTextDocumentContent(): string {
    return '';
  }
}

import {
  buildWorkspaceAnalyticsId,
  getDataOutcomesRootPath,
  getDefaultRunAnalyticsExportPath,
} from './run-analytics/storage';
import { BackendClient } from './backend/client';
import {
  requestWindowAttention,
  shouldShowCompletionNotification,
  type SessionCompletionEvent,
} from './sidebar/completion-notification';
import { type RunAnalyticsExportPayload } from './run-analytics/query';
import { fileChangesActions, selectActiveSessionPath, selectViewState, sessionsActions, sessionStateActions, store, transcriptActions, uiActions } from './store';
import { SidebarViewProvider } from './sidebar/provider';
import { SessionService } from './session-service';
import { StatsService } from './stats-service';
import type { WebviewToHostMessage } from '../shared/protocol';
import { EffectRunner } from './core/effect-runner';
import type { SyncEffect } from './core/effects';
import { reducer, initialArchState, type ArchState } from './core/reducer';
import type { Event } from './core/events';
import { auditLog, bootLog } from './util/audit';
import { buildOptimisticUserParts, buildPromptText } from './session-service/composer';
import { deriveSessionNameFromText } from '../shared/session-name';
import { isPendingTabPath } from '../shared/tab-behavior';
import { getSessionByPath } from './store';

export const SIDEBAR_VIEW_TYPE = 'pie.sessionsView';

const NO_WORKSPACE_ANALYTICS_ID_KEY = 'pie.analytics.noWorkspaceId';

function getWorkspaceAnalyticsId(context: vscode.ExtensionContext): string {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  const workspaceFile = vscode.workspace.workspaceFile;

  if (workspaceFolders?.length || workspaceFile) {
    return buildWorkspaceAnalyticsId({
      workspaceFolders,
      workspaceFile,
      noWorkspaceId: 'workspace',
    });
  }

  const existingNoWorkspaceId = context.workspaceState.get<string>(NO_WORKSPACE_ANALYTICS_ID_KEY)?.trim();
  const noWorkspaceId = existingNoWorkspaceId || crypto.randomUUID();

  if (!existingNoWorkspaceId) {
    void context.workspaceState.update(NO_WORKSPACE_ANALYTICS_ID_KEY, noWorkspaceId);
  }

  return buildWorkspaceAnalyticsId({
    workspaceFolders,
    workspaceFile,
    noWorkspaceId,
  });
}

function getLegacyWorkspaceAnalyticsIds(): string[] {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (workspaceFolders?.length) {
    return [
      workspaceFolders
        .map((folder) => folder.uri.toString())
        .sort((left, right) => left.localeCompare(right))
        .join('|'),
    ];
  }

  return [vscode.workspace.name ?? 'no-workspace'];
}

export class PieExtension implements vscode.Disposable {
  private readonly statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  private readonly sidebarProvider: SidebarViewProvider;
  private readonly statsService: StatsService;
  private readonly service: SessionService;
  private shutdownPromise: Promise<void> | null = null;

  // Queue sends that arrive while the session is still in pending (being created).
  private readonly pendingSendQueue = new Map<string, { text: string; localId?: string }[]>();

  // Queue sends that arrive before the backend is ready (restored sessions).
  private readonly backendReadyQueue: { sessionPath: string; text: string; localId?: string; queuedAt: number }[] = [];

  /**
   * Watchdog: how long a queued send may sit in `backendReadyQueue` before we
   * give up, drop it, and notify the user. Without this, a backend that never
   * signals ready would leave the composer in a permanently disabled "Waiting
   * for backend…" state with the user's message silently held captive (B3).
   */
  private static readonly BACKEND_READY_QUEUE_TIMEOUT_MS = 30_000;
  private backendReadyQueueWatchdog: NodeJS.Timeout | null = null;

  // Phase 3: CQRS architecture spine
  private archState: ArchState = initialArchState;
  private readonly effectRunner: EffectRunner;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly backend: BackendClient,
  ) {
    const dataOutcomesRootPath = getDataOutcomesRootPath(
      process.env.PI_CODING_AGENT_DIR,
      context.globalStorageUri.fsPath,
    );

    this.statsService = new StatsService({
      dataOutcomesRootPath,
      legacyUsageDataRootPath: context.globalStorageUri.fsPath,
      workspaceId: getWorkspaceAnalyticsId(context),
      legacyWorkspaceIds: getLegacyWorkspaceAnalyticsIds(),
      scheduleRender: () => this.scheduleRender(),
      getExperimentAssignment: () => this.getExperimentAssignment(),
    });

    this.service = new SessionService(
      context,
      backend,
      () => this.scheduleRender(),
      (message) => this.sidebarProvider.postImperative(message),
      (event) => {
        this.handleSessionCompleted(event);
      },
      this.statsService,
      (pendingPath, resolvedPath) => {
        this.drainPendingSendQueue(pendingPath, resolvedPath);
      },
    );

    this.sidebarProvider = new SidebarViewProvider(
      context,
      () => selectViewState(store.getState()),
      (message) => {
        void this.handleWebviewMessage(message);
      },
    );

    this.effectRunner = new EffectRunner({
      backend: this.backend,
      queues: this.service.queues,
      tabs: {
        async persistTabs() {
          // PersistTabs not yet wired — Phase 4+.
        },
      },
      log: {
        log: (level, message, data) => {
          auditLog(context, 'arch-effect-runner', message, (data as Record<string, unknown>) ?? {});
          if (level === 'error') console.error('[arch]', message, data);
        },
      },
      sync: { execute: (effect) => this.executeSyncEffect(effect) },
      dispatch: (event) => this.dispatchArchEvent(event),
    });

    // Wire backend events through the arch-reducer dispatch path (Phase 5).
    this.service.setArchDispatch((event) => this.dispatchArchEvent(event));

    // Drain queued sends once the backend becomes ready.
    let wasReady = store.getState().ui.backendReady;
    store.subscribe(() => {
      const isReady = store.getState().ui.backendReady;
      if (isReady && !wasReady) {
        this.drainBackendReadyQueue();
      }
      wasReady = isReady;
    });

    this.statusBar.command = 'pie.openChat';
    this.statusBar.show();
  }

  async start(): Promise<void> {
    this.updateStatusBar('Starting');
    await this.statsService.start();
    await this.service.start();
  }

  async restart(): Promise<void> {
    this.updateStatusBar('Starting');
    await this.service.restart();
  }

  /**
   * Phase 3: dispatch an event through the arch reducer and execute resulting effects.
   * This is the single point where the new CQRS spine integrates with the extension.
   */
  private dispatchArchEvent(event: Event): void {
    // Pre-reducer side effects for specific event types.
    if (event.kind === 'SendResult' && event.ok && event.requestId) {
      this.service.bindRequestSessionPath(event.requestId, event.sessionPath);
    }

    const result = reducer(this.archState, event);
    this.archState = result.state;
    for (const effect of result.effects) {
      this.effectRunner.run(effect);
    }
  }

  /**
   * Phase 4: execute synchronous imperative effects. These bridge the new
   * architecture to the legacy Redux store and webview imperative API while
   * transcript state still lives outside the reducer.
   */
  private executeSyncEffect(effect: SyncEffect): void {
    switch (effect.kind) {
      case 'InsertOptimisticMessage':
        store.dispatch(transcriptActions.appendLocalUserMessage({
          sessionPath: effect.sessionPath,
          id: effect.localId,
          text: effect.text,
          userParts: effect.userParts,
        }));
        // Optimistically mark the session as running so the composer immediately
        // switches to a Stop button and the typing indicator appears, even before
        // the backend emits its first `agent.busy` event. Cleared either by the
        // backend's busy=false event on completion or by RemoveOptimisticMessage
        // on send failure.
        store.dispatch(sessionsActions.setSessionRunning({
          sessionPath: effect.sessionPath,
          running: true,
        }));
        this.flushRender();
        break;
      case 'RemoveOptimisticMessage':
        store.dispatch(transcriptActions.removeMessage({
          sessionPath: effect.sessionPath,
          messageId: effect.localId,
        }));
        // Clear the optimistic running state if the send was rejected before
        // the backend started processing.
        store.dispatch(sessionsActions.setSessionRunning({
          sessionPath: effect.sessionPath,
          running: false,
        }));
        this.scheduleRender();
        break;
      case 'ClearComposerInputs':
        store.dispatch(sessionStateActions.clearPendingComposerInputs(effect.sessionPath));
        this.scheduleRender();
        break;
      case 'SetNotice':
        store.dispatch(uiActions.setNotice(effect.message));
        this.scheduleRender();
        break;
      case 'PostImperative':
        this.sidebarProvider.postImperative(effect.imperativeMessage as import('../shared/protocol').HostToWebviewMessage);
        break;
      case 'SetSessionName': {
        const current = getSessionByPath(store.getState(), effect.sessionPath);
        if (current) {
          store.dispatch(sessionsActions.upsertSession({
            ...current,
            name: effect.name,
            isPlaceholder: effect.isPlaceholder,
          }));
          this.scheduleRender();
        }
        break;
      }
      case 'RestoreSessionSummary':
        store.dispatch(sessionsActions.setSessionSummary(effect.summary));
        this.scheduleRender();
        break;
      case 'AppendDelta':
        store.dispatch(transcriptActions.appendDelta({
          sessionPath: effect.sessionPath,
          messageId: effect.messageId,
          delta: effect.delta,
        }));
        break;
      case 'AppendThinking':
        store.dispatch(transcriptActions.appendThinking({
          sessionPath: effect.sessionPath,
          messageId: effect.messageId,
          thinking: effect.thinking,
        }));
        break;
      case 'UpsertToolCall':
        store.dispatch(transcriptActions.upsertToolCall({
          sessionPath: effect.sessionPath,
          messageId: effect.messageId,
          toolCall: effect.toolCall,
        }));
        break;
      case 'UpsertMessage':
        store.dispatch(transcriptActions.upsertMessage({
          sessionPath: effect.sessionPath,
          message: effect.message,
          canonicalMessageId: effect.canonicalMessageId,
        }));
        break;
      case 'EnsureAssistantMessage':
        store.dispatch(transcriptActions.ensureAssistantMessage({
          sessionPath: effect.sessionPath,
          messageId: effect.canonicalMessageId,
          isAlias: effect.isAlias,
          modelId: effect.modelId,
          thinkingLevel: effect.thinkingLevel,
        }));
        this.flushRender();
        break;
      case 'SetMessageStatus':
        store.dispatch(transcriptActions.setMessageStatus({
          sessionPath: effect.sessionPath,
          messageId: effect.messageId,
          status: effect.status,
        }));
        break;
      case 'SetSessionRunning':
        // Watchdog escape: clears a session's running flag without waiting for
        // backend busy.changed. Used by the reducer after a successful interrupt
        // so the composer doesn't stick on "Stop" if the backend never emits
        // busy=false for the aborted stream.
        store.dispatch(sessionsActions.setSessionRunning({
          sessionPath: effect.sessionPath,
          running: effect.running,
        }));
        break;
      case 'ScheduleRender':
        this.scheduleRender();
        break;
    }
  }

  register(): void {
    this.context.subscriptions.push(
      this.backend,
      this.service,
      this.statusBar,
      vscode.workspace.registerTextDocumentContentProvider(EMPTY_DIFF_SCHEME, new EmptyDiffContentProvider()),
      vscode.window.registerWebviewViewProvider(SIDEBAR_VIEW_TYPE, this.sidebarProvider, {
        webviewOptions: { retainContextWhenHidden: true },
      }),
      vscode.commands.registerCommand('pie.openChat', () => {
        this.sidebarProvider.reveal();
      }),
      vscode.commands.registerCommand('pie.dumpDebugState', async () => {
        return await this.dumpDebugState();
      }),
      vscode.commands.registerCommand('pie.newSession', async () => {
        this.service.createNewSession();
        this.sidebarProvider.reveal();
      }),
      vscode.commands.registerCommand('pie.restartBackend', async () => {
        await this.restart();
      }),
      vscode.commands.registerCommand('pie.exportRunAnalytics', async (
        target?: vscode.Uri | string,
      ) => {
        return await this.exportRunAnalytics(target);
      }),
      vscode.commands.registerCommand('pie.attachFiles', async (
        resource?: vscode.Uri,
        resources?: vscode.Uri[],
      ) => {
        const uris = [
          ...(Array.isArray(resources) ? resources : []),
          ...(resource ? [resource] : []),
        ];
        await this.attachFiles(uris, 'picker');
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('pie.experimentAssignment')) {
          this.statsService.onExperimentAssignmentChanged(this.getExperimentAssignment());
        }
      }),
    );
  }

  private getExperimentAssignment(): string | null {
    const configured = vscode.workspace
      .getConfiguration('pie')
      .get<string>('experimentAssignment', '')
      .trim();
    return configured.length > 0 ? configured : null;
  }

  private async attachFiles(
    uris: vscode.Uri[],
    source: 'picker' | 'drop' = 'picker',
  ): Promise<void> {
    const targets = this.service.normalizeAttachUris(uris);
    if (targets.length === 0) {
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: true,
        canSelectFiles: true,
        canSelectFolders: true,
        openLabel: 'Attach to pie',
        title: 'Attach file path(s) to pie',
      });
      if (!picked || picked.length === 0) return;
      await this.attachFiles(picked, 'picker');
      return;
    }

    this.sidebarProvider.reveal();
    await this.service.addFilesystemPaths(
      undefined,
      targets.map((uri) => uri.fsPath),
      source,
    );
  }

  private async exportRunAnalytics(
    target?: vscode.Uri | string,
  ): Promise<RunAnalyticsExportPayload | undefined> {
    const shouldNotify = !target;
    const resolvedTarget = typeof target === 'string'
      ? vscode.Uri.file(target)
      : target ?? await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(getDefaultRunAnalyticsExportPath(
          process.env.PI_CODING_AGENT_DIR,
          this.context.globalStorageUri.fsPath,
          vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd(),
        )),
        filters: {
          JSON: ['json'],
        },
        saveLabel: 'Export Run Analytics',
        title: 'Export pie run analytics',
      });

    if (!resolvedTarget) {
      return undefined;
    }

    try {
      const payload = await this.statsService.exportRunAnalytics(resolvedTarget.fsPath);
      if (shouldNotify) {
        void vscode.window.showInformationMessage(
          `pie: Exported run analytics to ${resolvedTarget.fsPath}`,
        );
      }
      return payload;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (shouldNotify) {
        void vscode.window.showErrorMessage(`pie: Failed to export run analytics: ${message}`);
      }
      throw error;
    }
  }

  private async dumpDebugState(): Promise<string> {
    const dumpPath = path.join(this.context.globalStorageUri.fsPath, 'pie-debug-state.json');
    const payload = {
      capturedAt: new Date().toISOString(),
      sidebar: this.sidebarProvider.getDebugState(),
      viewState: selectViewState(store.getState()),
    };

    await fs.mkdir(path.dirname(dumpPath), { recursive: true });
    await fs.writeFile(dumpPath, JSON.stringify(payload, null, 2), 'utf8');
    return dumpPath;
  }

  private scheduleRender(): void {
    const viewState = selectViewState(store.getState());
    bootLog('extension-host', 'render.schedule', {
      activeSessionPath: viewState.activeSession?.path ?? null,
      backendReady: viewState.backendReady,
      notice: viewState.notice,
      openTabCount: viewState.openTabPaths.length,
      transcriptLoaded: viewState.transcriptLoaded,
    });
    this.sidebarProvider.scheduleState();
    queueMicrotask(() => {
      const state = selectViewState(store.getState());
      this.updateStatusBar(
        state.notice ? 'Error' : state.runningSessionPaths.length > 0 ? 'Thinking' : 'Idle',
      );
    });
  }

  /**
   * Immediately post state to the webview without debouncing.
   * Use for user-initiated actions (optimistic inserts, message edits)
   * and the first streaming event of a turn so feedback is instant.
   */
  private flushRender(): void {
    const viewState = selectViewState(store.getState());
    bootLog('extension-host', 'render.flush', {
      activeSessionPath: viewState.activeSession?.path ?? null,
      backendReady: viewState.backendReady,
      notice: viewState.notice,
      openTabCount: viewState.openTabPaths.length,
      transcriptLoaded: viewState.transcriptLoaded,
    });
    this.sidebarProvider.postState();
    const state = selectViewState(store.getState());
    this.updateStatusBar(
      state.notice ? 'Error' : state.runningSessionPaths.length > 0 ? 'Thinking' : 'Idle',
    );
  }

  private updateStatusBar(state: 'Starting' | 'Idle' | 'Thinking' | 'Error'): void {
    const runningCount = store.getState().sessions.runningSessionPaths.length;
    const notice = store.getState().ui.notice;
    const text =
      state === 'Thinking'
        ? runningCount > 1
          ? `pie: ${runningCount} Running`
          : 'pie: Running'
        : state === 'Error'
          ? 'pie: Error'
          : state === 'Starting'
            ? 'pie: Starting'
            : 'pie: Idle';

    this.statusBar.text = text;
    this.statusBar.tooltip = notice ?? 'Open pie chat';
  }

  private handleSessionCompleted(_event: SessionCompletionEvent): void {
    const state = store.getState();
    const suppressNotifications = state.ui.prefs.suppressCompletionNotifications;
    const windowFocused = vscode.window.state.focused;

    if (!shouldShowCompletionNotification({
      suppressNotifications,
      windowFocused,
    })) {
      return;
    }

    requestWindowAttention(
      vscode.env.appName,
      vscode.workspace.name ?? vscode.workspace.workspaceFolders?.[0]?.name,
    );
  }

  /**
   * Drain queued sends that arrived while the session was still pending.
   * Called when a pending session path resolves to a real backend session path.
   */
  private drainPendingSendQueue(pendingPath: string, resolvedPath: string): void {
    const queued = this.pendingSendQueue.get(pendingPath);
    this.pendingSendQueue.delete(pendingPath);
    if (!queued || queued.length === 0) return;

    for (const entry of queued) {
      // Re-dispatch through the normal send flow now that the session has a real path.
      // Pass through the original localId so the CQRS spine reuses it and the
      // webview's optimistic overlay de-duplicates correctly.
      void this.handleWebviewMessage({ type: 'send', sessionPath: resolvedPath, text: entry.text, localId: entry.localId });
    }
  }

  /**
   * Drain queued sends that arrived before the backend was ready.
   * Called when `backendReady` transitions from false to true.
   */
  private drainBackendReadyQueue(): void {
    const queued = this.backendReadyQueue.splice(0);
    this.clearBackendReadyQueueWatchdog();
    if (queued.length === 0) return;

    for (const entry of queued) {
      // Pass through the original localId so the CQRS spine reuses it and the
      // webview's optimistic overlay de-duplicates correctly.
      void this.handleWebviewMessage({ type: 'send', sessionPath: entry.sessionPath, text: entry.text, localId: entry.localId });
    }
  }

  /**
   * Arm the watchdog (idempotent). If the queue is still non-empty when the
   * timer fires, we treat the backend as wedged: roll back the optimistic
   * messages, surface a notice, and let the user retry.
   */
  private ensureBackendReadyQueueWatchdog(): void {
    if (this.backendReadyQueueWatchdog) return;
    this.backendReadyQueueWatchdog = setTimeout(() => {
      this.backendReadyQueueWatchdog = null;
      const queued = this.backendReadyQueue.splice(0);
      if (queued.length === 0) return;
      for (const entry of queued) {
        if (entry.localId) {
          store.dispatch(transcriptActions.removeMessage({
            sessionPath: entry.sessionPath,
            messageId: entry.localId,
          }));
        }
      }
      store.dispatch(uiActions.setNotice(
        `Backend did not become ready within ${PieExtension.BACKEND_READY_QUEUE_TIMEOUT_MS / 1000}s. ${queued.length} queued message${queued.length === 1 ? '' : 's'} dropped — please retry.`,
      ));
      this.scheduleRender();
    }, PieExtension.BACKEND_READY_QUEUE_TIMEOUT_MS);
  }

  private clearBackendReadyQueueWatchdog(): void {
    if (this.backendReadyQueueWatchdog) {
      clearTimeout(this.backendReadyQueueWatchdog);
      this.backendReadyQueueWatchdog = null;
    }
  }

  /** Drop any per-session host state held outside the CQRS reducer (B4 cleanup). */
  private purgeHostStateForSession(sessionPath: string): void {
    this.pendingSendQueue.delete(sessionPath);
    // Rebuild the backendReadyQueue without entries for the closing session.
    for (let i = this.backendReadyQueue.length - 1; i >= 0; i--) {
      if (this.backendReadyQueue[i]?.sessionPath === sessionPath) {
        this.backendReadyQueue.splice(i, 1);
      }
    }
    if (this.backendReadyQueue.length === 0) this.clearBackendReadyQueueWatchdog();
    // Also clear per-session bookkeeping the session-service holds.
    this.service.dropSessionLocalState(sessionPath);
  }

  private resolveFileChangePath(sessionPath: string, filePath: string): string {
    if (path.isAbsolute(filePath)) {
      return filePath;
    }

    const state = store.getState();
    const sessionCwd = state.sessions.sessions.find((session) => session.path === sessionPath)?.cwd;
    const basePath = sessionCwd || state.sessions.workspaceCwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return basePath ? path.resolve(basePath, filePath) : filePath;
  }

  private getFileChangeKind(
    sessionPath: string,
    filePath: string,
    resolvedPath: string,
  ): 'created' | 'modified' | 'deleted' {
    const changes = store.getState().fileChanges.bySession[sessionPath] ?? [];
    const change = changes.find((entry) => {
      const entryPath = this.resolveFileChangePath(sessionPath, entry.path);
      return entry.path === filePath || entryPath === resolvedPath;
    });
    return change?.kind ?? 'modified';
  }

  private toGitUri(uri: vscode.Uri, ref: string): vscode.Uri {
    return uri.with({
      scheme: 'git',
      query: JSON.stringify({ path: uri.fsPath, ref }),
    });
  }

  private toEmptyDiffUri(uri: vscode.Uri): vscode.Uri {
    return uri.with({
      scheme: EMPTY_DIFF_SCHEME,
      query: '',
      fragment: '',
    });
  }

  private async openFileDiff(sessionPath: string, filePath: string): Promise<void> {
    const resolvedPath = this.resolveFileChangePath(sessionPath, filePath);
    const uri = vscode.Uri.file(resolvedPath);
    const kind = this.getFileChangeKind(sessionPath, filePath, resolvedPath);
    const emptyUri = this.toEmptyDiffUri(uri);
    const originalUri = kind === 'created' ? emptyUri : this.toGitUri(uri, 'HEAD');
    const modifiedUri = kind === 'deleted' ? emptyUri : uri;

    try {
      await vscode.commands.executeCommand(
        'vscode.diff',
        originalUri,
        modifiedUri,
        `${path.basename(resolvedPath)} — agent changes`,
        { preview: true },
      );
    } catch {
      await vscode.commands.executeCommand('git.openChange', uri);
    }
  }

  private async revertFile(sessionPath: string, filePath: string): Promise<void> {
    const resolvedPath = this.resolveFileChangePath(sessionPath, filePath);

    try {
      // Check whether the file is known to git (tracked or staged).
      const tracked = await new Promise<boolean>((resolve) => {
        cp.execFile(
          'git',
          ['ls-files', '--error-unmatch', resolvedPath],
          { cwd: path.dirname(resolvedPath) },
          (err) => resolve(!err),
        );
      });

      if (tracked) {
        // Restore to last committed version.
        await new Promise<void>((resolve, reject) => {
          cp.execFile(
            'git',
            ['checkout', 'HEAD', '--', resolvedPath],
            { cwd: path.dirname(resolvedPath) },
            (err) => (err ? reject(err) : resolve()),
          );
        });
      } else {
        // Untracked file created by the agent – delete it.
        await fs.unlink(resolvedPath);
      }
    } catch {
      // Last resort: if the file still exists, warn the user.
      const exists = await fs.access(resolvedPath).then(() => true, () => false);
      if (exists) {
        void vscode.window.showWarningMessage(
          `Could not revert ${filePath}. The file may not be under source control.`,
        );
        return;
      }
      // File is already gone – treat as success and remove the entry.
    }

    store.dispatch(fileChangesActions.removeFileChange({ sessionPath, path: filePath }));
    this.scheduleRender();
  }
  private async handleWebviewMessage(msg: WebviewToHostMessage): Promise<void> {
    if (msg.type === 'ready' || msg.type === 'refreshState' || msg.type === 'requestSnapshot') {
      const viewState = selectViewState(store.getState());
      bootLog('extension-host', `webview.${msg.type}`, {
        activeSessionPath: viewState.activeSession?.path ?? null,
        backendReady: viewState.backendReady,
        notice: viewState.notice,
        openTabCount: viewState.openTabPaths.length,
        transcriptLoaded: viewState.transcriptLoaded,
      });
    }

    switch (msg.type) {
      case 'ready':
        this.sidebarProvider.postState();
        return;

      case 'refreshState': {
        const activeSessionPath = selectActiveSessionPath(store.getState());
        if (activeSessionPath) {
          await this.service.hydrateModelState(activeSessionPath);
        }
        this.sidebarProvider.postState();
        return;
      }

      case 'requestSnapshot':
        this.sidebarProvider.postState();
        return;

      case 'send': {
        const sessionPath = typeof msg.sessionPath === 'string' ? msg.sessionPath : null;
        const text = typeof msg.text === 'string' ? msg.text : '';
        const webviewLocalId = msg.localId;
        if (!sessionPath) {
          store.dispatch(uiActions.setNotice('Protocol defect: send arrived without a sessionPath.'));
          this.scheduleRender();
          return;
        }

        // If the session is still being created, queue the send and show optimistic UI.
        if (isPendingTabPath(sessionPath)) {
          if (!text.trim()) return;
          const queue = this.pendingSendQueue.get(sessionPath) ?? [];
          // Insert optimistic user message so the user sees instant feedback.
          // Use the webview-provided localId when available so the webview can
          // correlate its local overlay with the host-confirmed message.
          const localId = webviewLocalId ?? `local:${Date.now()}:${Math.random().toString(36).slice(2)}`;
          queue.push({ text, localId });
          this.pendingSendQueue.set(sessionPath, queue);

          store.dispatch(transcriptActions.appendLocalUserMessage({
            sessionPath,
            id: localId,
            text,
          }));

          // Derive optimistic session name from the first message.
          const session = getSessionByPath(store.getState(), sessionPath);
          if (session?.isPlaceholder) {
            const derived = deriveSessionNameFromText(text);
            if (!derived.isPlaceholder && derived.name !== session.name) {
              store.dispatch(sessionsActions.upsertSession({ ...session, name: derived.name, isPlaceholder: false }));
            }
          }

          this.flushRender();
          return;
        }
        // If the backend is still starting, queue the send and show optimistic UI.
        if (!store.getState().ui.backendReady) {
          if (!text.trim()) return;
          // Use the webview-provided localId when available so the drain can
          // reuse it and the webview's overlay de-duplicates correctly.
          const localId = webviewLocalId ?? `local:${Date.now()}:${Math.random().toString(36).slice(2)}`;
          this.backendReadyQueue.push({ sessionPath, text, localId, queuedAt: Date.now() });
          this.ensureBackendReadyQueueWatchdog();

          // Insert optimistic user message so the user sees instant feedback.
          store.dispatch(transcriptActions.appendLocalUserMessage({
            sessionPath,
            id: localId,
            text,
          }));

          // Derive optimistic session name.
          const session = getSessionByPath(store.getState(), sessionPath);
          if (session?.isPlaceholder) {
            const derived = deriveSessionNameFromText(text);
            if (!derived.isPlaceholder && derived.name !== session.name) {
              store.dispatch(sessionsActions.upsertSession({ ...session, name: derived.name, isPlaceholder: false }));
            }
          }

          this.flushRender();
          return;
        }

        if (!store.getState().sessions.openTabPaths.includes(sessionPath)) {
          store.dispatch(uiActions.setNotice('Cannot send: the selected session is no longer open.'));
          this.scheduleRender();
          return;
        }

        const inputs = [
          ...(store.getState().sessionState.pendingComposerInputsBySession[sessionPath] ?? []),
        ];
        if (!text.trim() && inputs.length === 0) return;

        // Pre-compute values the reducer needs.
        this.service.bumpSessionDataEpoch(sessionPath);
        this.statsService.prepareForSend(sessionPath, inputs);
        const composedText = buildPromptText(text, inputs);
        const userParts = buildOptimisticUserParts(text, inputs);
        const localId = webviewLocalId ?? `local:${Date.now()}:${Math.random().toString(36).slice(2)}`;

        // Optimistic session name.
        let previousSummary = null as import('../shared/protocol').SessionSummary | null;
        const session = getSessionByPath(store.getState(), sessionPath);
        if (session?.isPlaceholder) {
          const derived = deriveSessionNameFromText(composedText);
          if (!derived.isPlaceholder && derived.name !== session.name) {
            previousSummary = session;
            store.dispatch(sessionsActions.upsertSession({ ...session, name: derived.name, isPlaceholder: false }));
            this.scheduleRender();
          }
        }

        // Dispatch through CQRS spine.
        const corrId = crypto.randomUUID();
        this.dispatchArchEvent({
          kind: 'Command',
          cmd: { kind: 'Send', corrId, sessionPath, text, inputs, composedText, localId, userParts, previousSummary },
        });
        return;
      }

      case 'editMessage': {
        const sessionPath = typeof msg.sessionPath === 'string' ? msg.sessionPath : null;
        const text = typeof msg.text === 'string' ? msg.text : '';
        const messageId = typeof msg.messageId === 'string' ? msg.messageId : '';
        if (!sessionPath) {
          store.dispatch(uiActions.setNotice('Protocol defect: editMessage arrived without a sessionPath.'));
          this.scheduleRender();
          return;
        }
        if (!text.trim() || !messageId) return;

        // Pre-flight validation.
        if (isPendingTabPath(sessionPath)) {
          store.dispatch(uiActions.setNotice('Cannot edit: the session is still opening.'));
          this.scheduleRender();
          return;
        }
        if (!store.getState().sessions.openTabPaths.includes(sessionPath)) {
          store.dispatch(uiActions.setNotice('Cannot edit: the selected session is no longer open.'));
          this.scheduleRender();
          return;
        }

        this.service.bumpSessionDataEpoch(sessionPath);
        this.statsService.onTruncatedAfter(sessionPath, messageId);
        this.statsService.onMessageEdited(sessionPath, messageId);
        this.statsService.prepareForSend(sessionPath, []);
        const localId = `local:edit:${Date.now()}:${Math.random().toString(36).slice(2)}`;

        // Dispatch through CQRS spine.
        const corrId = crypto.randomUUID();
        store.dispatch(uiActions.setEditingMessageId(null));
        this.dispatchArchEvent({
          kind: 'Command',
          cmd: { kind: 'Edit', corrId, sessionPath, messageId, text, localId },
        });
        return;
      }

      case 'interrupt': {
        const sessionPath = typeof msg.sessionPath === 'string' ? msg.sessionPath : null;
        if (!sessionPath) {
          store.dispatch(uiActions.setNotice('Protocol defect: interrupt arrived without a sessionPath.'));
          this.scheduleRender();
          return;
        }
        // Phase 3: route through the CQRS reducer + effect runner.
        const corrId = crypto.randomUUID();
        this.dispatchArchEvent({
          kind: 'Command',
          cmd: { kind: 'Interrupt', corrId, sessionPath },
        });
        this.service.suppressNextCompletionNotificationFor(sessionPath);
        return;
      }

      case 'openFilePicker': {
        const uris = await vscode.window.showOpenDialog({
          canSelectMany: true,
          canSelectFiles: true,
          canSelectFolders: true,
          openLabel: 'Attach',
          title: 'Attach file path(s) to message',
        });
        if (!uris || uris.length === 0) return;
        await this.service.addFilesystemPaths(undefined, uris.map((u) => u.fsPath), 'picker');
        return;
      }

      case 'addComposerInput':
        await this.service.addComposerInput(msg.sessionPath, msg.input);
        return;

      case 'removeComposerInput':
        this.service.removeComposerInput(msg.sessionPath, msg.inputId);
        return;

      case 'openFile':
        if (typeof msg.path !== 'string' || !msg.path.trim()) return;
        await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(msg.path));
        return;

      case 'newSession':
        this.service.createNewSession();
        this.sidebarProvider.postState();
        return;

      case 'openSession':
        store.dispatch(uiActions.setEditingMessageId(null));
        store.dispatch(uiActions.setShowOutcomeDialog(false));
        this.service.openSession(msg.sessionPath);
        this.sidebarProvider.reveal();
        this.sidebarProvider.postState();
        return;

      case 'closeSession':
        await this.service.closeSession(msg.sessionPath);
        // Cleanup per-session bookkeeping that lives outside the SessionService.
        // - Arch reducer state (pending RPCs, currentTurn map) via SessionClosed event.
        // - UI singletons (editing/outcome/extensionUI) when they belonged to this session.
        // - Host-owned queues + service-side per-session maps via purgeHostStateForSession.
        // This is the central fix for B4 cross-session bleed.
        this.dispatchArchEvent({ kind: 'SessionClosed', sessionPath: msg.sessionPath });
        this.purgeHostStateForSession(msg.sessionPath);
        {
          const ui = store.getState().ui;
          if (ui.editingMessageId !== null) {
            store.dispatch(uiActions.setEditingMessageId(null));
          }
          if (ui.showOutcomeDialog) {
            store.dispatch(uiActions.setShowOutcomeDialog(false));
          }
          if (ui.pendingExtensionUIRequest) {
            // pendingExtensionUIRequest is a singleton (payload has no
            // sessionPath today). Conservatively clear it when any tab closes
            // so it can't be answered against a new session. The architectural
            // fix is to attach sessionPath to the payload (TODO).
            store.dispatch(uiActions.setPendingExtensionUIRequest(null));
          }
        }
        this.sidebarProvider.postState();
        return;

      case 'moveSessionTab':
        this.service.moveSessionTab(msg.sessionPath, msg.fromIndex, msg.toIndex);
        this.sidebarProvider.postState();
        return;

      case 'loadOlderTranscript':
        await this.service.loadOlderTranscript(msg.sessionPath);
        return;

      case 'loadNewerTranscript':
        await this.service.loadNewerTranscript(msg.sessionPath);
        return;

      case 'jumpToLatestTranscript':
        await this.service.jumpToLatestTranscript(msg.sessionPath);
        return;

      case 'recordOutcome':
        this.statsService.recordOutcome(msg.sessionPath, msg.outcome);
        return;

      case 'startNewTask':
        this.statsService.startNewTask(msg.sessionPath);
        return;

      case 'continueTask':
        this.statsService.continueTask(msg.sessionPath);
        return;

      case 'setModel':
        await this.service.setModel(msg.sessionPath, msg.defaultModel, msg.defaultThinkingLevel);
        return;

      case 'openFileDiff':
        await this.openFileDiff(msg.sessionPath, msg.filePath);
        return;

      case 'revertFile':
        await this.revertFile(msg.sessionPath, msg.filePath);
        return;

      case 'setPrefs':
        this.service.setPrefs(msg.prefs);
        this.sidebarProvider.postState();
        return;

      case 'setPruningSettings':
        await this.service.setPruningSettings(msg.settings);
        this.scheduleRender();
        return;

      case 'startEdit':
        store.dispatch(uiActions.setEditingMessageId(msg.messageId));
        this.scheduleRender();
        return;

      case 'cancelEdit':
        store.dispatch(uiActions.setEditingMessageId(null));
        this.scheduleRender();
        return;

      case 'dismissNotice':
        store.dispatch(uiActions.setNotice(null));
        this.scheduleRender();
        return;

      case 'openOutcomeDialog':
        store.dispatch(uiActions.setShowOutcomeDialog(true));
        this.scheduleRender();
        return;

      case 'closeOutcomeDialog':
        store.dispatch(uiActions.setShowOutcomeDialog(false));
        this.scheduleRender();
        return;

      case 'stateApplied':
        bootLog('webview', 'state.applied', { ...msg.payload });
        return;

      case 'extensionUiResponse': {
        // STATE_CONTRACT: webview must address its response to a specific session.
        // Falling back to the active session would let a prompt opened in tab A be
        // resolved against tab B if the user switched tabs before clicking.
        const sessionPath = typeof msg.sessionPath === 'string' ? msg.sessionPath : null;
        if (!sessionPath) {
          store.dispatch(uiActions.setNotice('Protocol defect: extensionUiResponse arrived without a sessionPath.'));
          this.scheduleRender();
          return;
        }
        store.dispatch(uiActions.setPendingExtensionUIRequest(null));
        this.scheduleRender();
        await this.backend.request('extension_ui.response', {
          sessionPath,
          response: msg.response,
        });
        return;
      }

      default:
        return;
    }
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) {
      await this.shutdownPromise;
      return;
    }

    this.shutdownPromise = (async () => {
      // Clear any pending timers first so they cannot fire into a torn-down
      // store / sidebar provider after dispose.
      this.clearBackendReadyQueueWatchdog();
      await this.statsService.shutdown();
      this.service.dispose();
      this.sidebarProvider.dispose();
      this.backend.dispose();
      this.statusBar.dispose();
    })();

    await this.shutdownPromise;
  }

  dispose(): void {
    void this.shutdown();
  }
}
