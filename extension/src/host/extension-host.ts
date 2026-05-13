import * as vscode from 'vscode';

import { BackendClient } from './backend-client';
import {
  requestWindowAttention,
  shouldShowCompletionNotification,
  type SessionCompletionEvent,
} from './completion-notification';
import { selectActiveSessionPath, selectViewState, store } from './store';
import { SidebarViewProvider } from './sidebar-provider';
import { SessionService } from './session-service';
import { StatsService } from './stats-service';
import type { WebviewToHostMessage } from '../shared/protocol';

export const SIDEBAR_VIEW_TYPE = 'pie.sessionsView';

function getWorkspaceAnalyticsId(): string {
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    return folders.map((folder) => folder.uri.toString()).join('|');
  }
  return vscode.workspace.name ?? 'no-workspace';
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
    this.statsService = new StatsService({
      globalStoragePath: context.globalStorageUri.fsPath,
      workspaceId: getWorkspaceAnalyticsId(),
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
      vscode.commands.registerCommand('pie.exportRunAnalytics', async () => {
        await this.exportRunAnalytics();
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

  private async exportRunAnalytics(): Promise<void> {
    const defaultFileName = `pie-run-analytics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    const defaultUri = vscode.Uri.joinPath(this.context.globalStorageUri, defaultFileName);
    const target = await vscode.window.showSaveDialog({
      defaultUri,
      filters: { JSON: ['json'] },
      saveLabel: 'Export pie run analytics',
      title: 'Export pie run analytics',
    });
    if (!target) {
      return;
    }

    try {
      const payload = await this.statsService.exportRunAnalytics(target.fsPath);
      void vscode.window.showInformationMessage(
        `Exported ${payload.completedRuns.length} completed run(s) and ${payload.openRuns.length} open run(s).`,
      );
    } catch (error) {
      void vscode.window.showErrorMessage(`Failed to export pie run analytics: ${(error as Error).message}`);
    }
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

      case 'exportRunAnalytics':
        await this.exportRunAnalytics();
        return;

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
        return;

      case 'openSession':
        this.service.openSession(msg.sessionPath);
        this.sidebarProvider.reveal();
        return;

      case 'closeSession':
        await this.service.closeSession(msg.sessionPath);
        return;

      case 'moveSessionTab':
        this.service.moveSessionTab(msg.sessionPath, msg.fromIndex, msg.toIndex);
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
