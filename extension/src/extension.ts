import * as vscode from 'vscode';

import { BackendClient } from './host/backend-client';
import { PieExtension } from './host/extension-host';

let extensionInstance: PieExtension | null = null;

export function activate(context: vscode.ExtensionContext): void {
  const extension = new PieExtension(context, new BackendClient());
  extensionInstance = extension;
  extension.register();
  context.subscriptions.push(extension);
  void extension.start();
}

export async function deactivate(): Promise<void> {
  const extension = extensionInstance;
  extensionInstance = null;
  await extension?.shutdown();
}
