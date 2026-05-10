import * as vscode from 'vscode';

import { BackendClient } from './host/backend-client';
import {
  selectViewState,
  sessionsActions,
  settingsActions,
  store,
  transcriptActions,
  uiActions,
} from './host/store';
import { SidebarViewProvider } from './host/sidebar-provider';
import { PiAssistantExtension, SIDEBAR_VIEW_TYPE } from './host/extension-host';

export function activate(context: vscode.ExtensionContext): void {
  const extension = new PiAssistantExtension(context, new BackendClient());
  extension.register();
  context.subscriptions.push(extension);
  void extension.start();
}

export function deactivate(): void {}
