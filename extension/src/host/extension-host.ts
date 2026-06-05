import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { produce } from 'immer';
import * as vscode from 'vscode';

import { EMPTY_DIFF_SCHEME, EmptyDiffContentProvider, FileDiffService } from './core/file-diff-service';
import { MessageRouter } from './core/message-router';

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
import { SidebarViewProvider } from './sidebar/provider';
import { SessionService } from './session-service';
import { StatsService } from './stats-service';
import type { WebviewToHostMessage } from '../shared/protocol';
import { EffectRunner } from './core/effect-runner';
import { dispatch } from './core/dispatch';
import { initialArchState, type ArchState } from './core/reducer';
import type { Event } from './core/events';
import { selectViewState } from './core/projection';
import { subscribeToArchState } from './core/dispatch';
import { auditLog, bootLog } from './util/audit';
import { deriveSessionNameFromText } from '../shared/session-name';
import { isPendingTabPath } from '../shared/tab-behavior';


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

  private readonly messageRouter: MessageRouter;

  // Phase 3: CQRS architecture spine
  private archState: ArchState = initialArchState;
  private readonly effectRunner: EffectRunner;
  private readonly fileDiffService: FileDiffService;

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
      getArchState: () => this.archState,
      mutateArchState: (recipe) => {
        this.archState = produce(this.archState, recipe);
      },
    });

    this.service = new SessionService(
      context,
      backend,
      () => this.scheduleRender(),
      (message) => this.sidebarProvider.postImperative(message),
      (event) => this.dispatchArchEvent(event),
      () => this.archState,
      (recipe) => {
        this.archState = produce(this.archState, recipe);
      },
      (event) => {
        this.handleSessionCompleted(event);
      },
      this.statsService,
      (pendingPath, resolvedPath) => {
        this.messageRouter.drainPendingSendQueue(pendingPath, resolvedPath);
      },
    );

    this.sidebarProvider = new SidebarViewProvider(
      context,
      () => selectViewState(this.archState),
      (message) => {
        void this.handleWebviewMessage(message);
      },
    );

    this.fileDiffService = new FileDiffService(() => this.archState);

    this.messageRouter = new MessageRouter(
      (event) => this.dispatchArchEvent(event),
      () => this.archState,
      this.service,
      this.statsService,
      this.sidebarProvider,
      this.fileDiffService,
      this.backend,
      () => this.scheduleRender(),
      () => this.flushRender(),
      deriveSessionNameFromText,
      isPendingTabPath,
      context,
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
      postImperative: {
        postImperative: (message) => this.sidebarProvider.postImperative(message as import('../shared/protocol').HostToWebviewMessage),
      },
      dispatch: (event) => this.dispatchArchEvent(event),
    });

    // Auto-projection: schedule a render whenever archState changes.
    let wasReady = this.archState.settings.backendReady;
    subscribeToArchState((state) => {
      this.scheduleRender();
      const isReady = state.settings.backendReady;
      if (isReady && !wasReady) {
        this.messageRouter.drainBackendReadyQueue();
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

    const result = dispatch(this.archState, event);
    this.archState = result.state;
    for (const effect of result.effects) {
      this.effectRunner.run(effect);
    }
    // Auto-projection: scheduleRender() is called automatically by the
    // subscribeToArchState listener. No explicit render call needed here.
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
      viewState: selectViewState(this.archState),
    };

    await fs.mkdir(path.dirname(dumpPath), { recursive: true });
    await fs.writeFile(dumpPath, JSON.stringify(payload, null, 2), 'utf8');
    return dumpPath;
  }

  private scheduleRender(): void {
    const viewState = selectViewState(this.archState);
    bootLog('extension-host', 'render.schedule', {
      activeSessionPath: viewState.activeSession?.path ?? null,
      backendReady: viewState.backendReady,
      notice: viewState.notice,
      openTabCount: viewState.openTabPaths.length,
      transcriptLoaded: viewState.transcriptLoaded,
    });
    this.sidebarProvider.scheduleState();
    queueMicrotask(() => {
      const state = selectViewState(this.archState);
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
    const viewState = selectViewState(this.archState);
    bootLog('extension-host', 'render.flush', {
      activeSessionPath: viewState.activeSession?.path ?? null,
      backendReady: viewState.backendReady,
      notice: viewState.notice,
      openTabCount: viewState.openTabPaths.length,
      transcriptLoaded: viewState.transcriptLoaded,
    });
    this.sidebarProvider.postState();
    const state = selectViewState(this.archState);
    this.updateStatusBar(
      state.notice ? 'Error' : state.runningSessionPaths.length > 0 ? 'Thinking' : 'Idle',
    );
  }

  private updateStatusBar(state: 'Starting' | 'Idle' | 'Thinking' | 'Error'): void {
    const runningCount = this.archState.sessions.runningSessionPaths.length;
    const notice = this.archState.settings.notice;
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
    const suppressNotifications = this.archState.settings.prefs.suppressCompletionNotifications;
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



  /** Thin wrapper delegating to {@link MessageRouter.handle}. */
  private async handleWebviewMessage(msg: WebviewToHostMessage): Promise<void> {
    await this.messageRouter.handle(msg);
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) {
      await this.shutdownPromise;
      return;
    }

    this.shutdownPromise = (async () => {
      // Clear any pending timers first so they cannot fire into a torn-down
      // store / sidebar provider after dispose.
      this.messageRouter.clearBackendReadyQueueWatchdog();
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
