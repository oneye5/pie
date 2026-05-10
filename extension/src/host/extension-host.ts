import * as vscode from 'vscode';

import { BackendClient } from './backend-client';
import { selectViewState, store } from './store';
import { SidebarViewProvider } from './sidebar-provider';
import { SessionService } from './session-service';
import type { WebviewToHostMessage } from '../shared/protocol';

export const SIDEBAR_VIEW_TYPE = 'pi-assistant.sessionsView';

export class PiAssistantExtension implements vscode.Disposable {
  private readonly statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  private readonly sidebarProvider: SidebarViewProvider;
  private readonly service: SessionService;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly backend: BackendClient,
  ) {
    this.service = new SessionService(
      context,
      backend,
      () => this.scheduleRender(),
      (op) => this.sidebarProvider.postPatch(op),
    );

    this.sidebarProvider = new SidebarViewProvider(
      context,
      () => selectViewState(store.getState()),
      (message) => {
        void this.handleWebviewMessage(message);
      },
    );

    this.statusBar.command = 'pi-assistant.openChat';
    this.statusBar.show();
  }

  async start(): Promise<void> {
    this.updateStatusBar('Starting');
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
      vscode.commands.registerCommand('pi-assistant.openChat', () => {
        this.sidebarProvider.reveal();
      }),
      vscode.commands.registerCommand('pi-assistant.newSession', async () => {
        this.service.createNewSession();
        this.sidebarProvider.reveal();
      }),
      vscode.commands.registerCommand('pi-assistant.restartBackend', async () => {
        await this.restart();
      }),
      vscode.commands.registerCommand('pi-assistant.attachFiles', async (
        resource?: vscode.Uri,
        resources?: vscode.Uri[],
      ) => {
        const uris = [
          ...(Array.isArray(resources) ? resources : []),
          ...(resource ? [resource] : []),
        ];
        await this.attachFiles(uris);
      }),
    );
  }

  private async attachFiles(uris: vscode.Uri[]): Promise<void> {
    const targets = this.service.normalizeAttachUris(uris);
    if (targets.length === 0) {
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: true,
        canSelectFiles: true,
        canSelectFolders: true,
        openLabel: 'Attach to PI Assistant',
        title: 'Attach file path(s) to PI Assistant',
      });
      if (!picked || picked.length === 0) return;
      await this.attachFiles(picked);
      return;
    }

    this.sidebarProvider.reveal();
    this.sidebarProvider.postImperative({
      type: 'filePickerResult',
      paths: targets.map((uri) => uri.fsPath),
    });
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
          ? `PI: ${runningCount} Running`
          : 'PI: Running'
        : state === 'Error'
          ? 'PI: Error'
          : state === 'Starting'
            ? 'PI: Starting'
            : 'PI: Idle';

    this.statusBar.text = text;
    this.statusBar.tooltip = notice ?? 'Open PI Assistant chat';
  }

  private async handleWebviewMessage(msg: WebviewToHostMessage): Promise<void> {
    switch (msg.type) {
      case 'ready':
        this.sidebarProvider.postState();
        return;

      case 'refreshState': {
        const activeSession = store.getState().sessions.activeSession;
        if (activeSession) {
          await this.service.hydrateModelState(activeSession.path);
        }
        this.scheduleRender();
        return;
      }

      case 'requestSnapshot':
        this.sidebarProvider.postState();
        return;

      case 'send': {
        const text = typeof msg.text === 'string' ? msg.text.trim() : '';
        if (text) await this.service.send(text);
        return;
      }

      case 'editMessage': {
        const text = typeof msg.text === 'string' ? msg.text.trim() : '';
        const messageId = typeof msg.messageId === 'string' ? msg.messageId : '';
        if (text && messageId) await this.service.editMessage(messageId, text);
        return;
      }

      case 'interrupt':
        await this.service.interrupt();
        return;

      case 'openFilePicker': {
        const uris = await vscode.window.showOpenDialog({
          canSelectMany: true,
          openLabel: 'Insert',
          title: 'Insert file path(s) into message',
        });
        if (!uris || uris.length === 0) return;
        this.sidebarProvider.postImperative({ type: 'filePickerResult', paths: uris.map((u) => u.fsPath) });
        return;
      }

      case 'newSession':
        this.service.createNewSession();
        return;

      case 'openSession':
        await this.service.openSession(msg.sessionPath);
        this.sidebarProvider.reveal();
        return;

      case 'closeSession':
        await this.service.closeSession(msg.sessionPath);
        return;

      case 'setModel':
        await this.service.setModel(msg.defaultModel, msg.defaultThinkingLevel);
        return;

      case 'setPrefs':
        this.service.setPrefs(msg.prefs);
        this.sidebarProvider.postState();
        return;

      default:
        return;
    }
  }

  dispose(): void {
    this.backend.dispose();
    this.statusBar.dispose();
  }
}
