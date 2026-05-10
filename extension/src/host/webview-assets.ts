import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import * as vscode from 'vscode';

export async function renderWebviewHtml(
  context: vscode.ExtensionContext,
  webview: vscode.Webview,
): Promise<string> {
  const viewName = 'panel';
  const baseDir = path.join(context.extensionPath, 'out', 'webview', viewName);
  const nonce = crypto.randomBytes(16).toString('hex');
  const html = await fs.readFile(path.join(baseDir, 'index.html'), 'utf8');

  const scriptUri = webview.asWebviewUri(vscode.Uri.file(path.join(baseDir, `${viewName}.js`)));
  const styleUri = webview.asWebviewUri(vscode.Uri.file(path.join(baseDir, `${viewName}.css`)));

  return html
    .replaceAll('{{cspSource}}', webview.cspSource)
    .replaceAll('{{nonce}}', nonce)
    .replaceAll('{{scriptUri}}', scriptUri.toString())
    .replaceAll('{{styleUri}}', styleUri.toString());
}

export function getWebviewRoots(context: vscode.ExtensionContext): vscode.Uri[] {
  const viewName = 'panel';
  return [vscode.Uri.joinPath(context.extensionUri, 'out', 'webview', viewName)];
}
