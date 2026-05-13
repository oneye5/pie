import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import * as vscode from 'vscode';

import {
  DEFAULT_WEBVIEW_VIEW_NAME,
  getWebviewAssetDir,
  readWebviewAssetVersion,
} from './webview-hot-reload';

export async function renderWebviewHtml(
  context: vscode.ExtensionContext,
  webview: vscode.Webview,
): Promise<string> {
  const viewName = DEFAULT_WEBVIEW_VIEW_NAME;
  const baseDir = getWebviewAssetDir(context.extensionPath, viewName);
  const nonce = crypto.randomBytes(16).toString('hex');
  const html = await fs.readFile(path.join(baseDir, 'index.html'), 'utf8');
  const assetVersion = encodeURIComponent(await readWebviewAssetVersion(baseDir, viewName));

  const scriptUri = webview.asWebviewUri(vscode.Uri.file(path.join(baseDir, `${viewName}.js`))).with({
    query: `v=${assetVersion}`,
  });
  const styleUri = webview.asWebviewUri(vscode.Uri.file(path.join(baseDir, `${viewName}.css`))).with({
    query: `v=${assetVersion}`,
  });

  return html
    .replaceAll('{{cspSource}}', webview.cspSource)
    .replaceAll('{{nonce}}', nonce)
    .replaceAll('{{scriptUri}}', scriptUri.toString())
    .replaceAll('{{styleUri}}', styleUri.toString());
}

export function getWebviewRoots(context: vscode.ExtensionContext): vscode.Uri[] {
  const viewName = DEFAULT_WEBVIEW_VIEW_NAME;
  return [vscode.Uri.joinPath(context.extensionUri, 'out', 'webview', viewName)];
}
