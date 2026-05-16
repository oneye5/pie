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
} from './analytics-storage';
import { BackendClient } from './backend-client';
import {
  requestWindowAttention,
  shouldShowCompletionNotification,
  type SessionCompletionEvent,
} from './completion-notification';
import { type RunAnalyticsExportPayload } from './run-analytics-query';
import { fileChangesActions, selectActiveSessionPath, selectViewState, store } from './store';
import { SidebarViewProvider } from './sidebar-provider';
import { SessionService } from './session-service';
import { StatsService } from './stats-service';
import type { WebviewToHostMessage } from '../shared/protocol';

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
      (op) => this.sidebarProvider.postPatch(op),
      (message) => this.sidebarProvider.postImperative(message),
      (event) => {
        this.handleSessionCompleted(event);
      },
      this.statsService,
    );

    this.sidebarProvider = new SidebarViewProvider(
      context,
      () => selectViewState(store.getState()),
      (message) => {
        void this.handleWebviewMessage(message);
      },
    );

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

  private scheduleRender(): void {
    this.sidebarProvider.scheduleState();
    queueMicrotask(() => {
      const state = selectViewState(store.getState());
      this.updateStatusBar(
        state.notice ? 'Error' : state.runningSessionPaths.length > 0 ? 'Thinking' : 'Idle',
      );
    });
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
    } catch (err) {
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
    switch (msg.type) {
      case 'ready':
        this.sidebarProvider.postState();
        return;

      case 'refreshState': {
        const activeSessionPath = selectActiveSessionPath(store.getState());
        if (activeSessionPath) {
          await this.service.hydrateModelState(activeSessionPath);
        }
        this.scheduleRender();
        return;
      }

      case 'requestSnapshot':
        this.sidebarProvider.postState();
        return;

      case 'send': {
        const text = typeof msg.text === 'string' ? msg.text : '';
        const hasPendingInputs = selectViewState(store.getState()).pendingComposerInputs.length > 0;
        if (text.trim() || hasPendingInputs) {
          await this.service.send(text);
        }
        return;
      }

      case 'editMessage': {
        const text = typeof msg.text === 'string' ? msg.text : '';
        const messageId = typeof msg.messageId === 'string' ? msg.messageId : '';
        if (text.trim() && messageId) await this.service.editMessage(messageId, text);
        return;
      }

      case 'interrupt':
        await this.service.interrupt();
        return;

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
        this.service.openSession(msg.sessionPath);
        this.sidebarProvider.reveal();
        this.sidebarProvider.postState();
        return;

      case 'closeSession':
        await this.service.closeSession(msg.sessionPath);
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
