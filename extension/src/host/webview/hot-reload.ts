import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export const DEFAULT_WEBVIEW_VIEW_NAME = 'panel';

export function getWebviewAssetDir(
  extensionPath: string,
  viewName = DEFAULT_WEBVIEW_VIEW_NAME,
): string {
  return path.join(extensionPath, 'out', 'webview', viewName);
}

export function getHotReloadAssetFileNames(
  viewName = DEFAULT_WEBVIEW_VIEW_NAME,
): readonly string[] {
  return Object.freeze([
    `${viewName}.js`,
    `${viewName}.css`,
    'index.html',
  ]);
}

export function isHotReloadAssetFileName(
  fileName: string | null | undefined,
  _viewName = DEFAULT_WEBVIEW_VIEW_NAME,
): boolean {
  if (!fileName) {
    return false;
  }

  // Any built asset or manifest change should trigger a webview reload.
  // Ignore sourcemaps, which churn on every build but do not affect runtime.
  return !fileName.endsWith('.map');
}

export async function readWebviewAssetVersion(
  baseDir: string,
  _viewName = DEFAULT_WEBVIEW_VIEW_NAME,
): Promise<string> {
  const manifestPath = path.join(baseDir, '.vite', 'manifest.json');
  try {
    const manifestText = await fs.readFile(manifestPath, 'utf8');
    return crypto.createHash('sha256').update(manifestText).digest('hex').slice(0, 16);
  } catch {
    return 'no-manifest';
  }
}
