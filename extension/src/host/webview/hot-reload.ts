import { stat } from 'node:fs/promises';
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
  viewName = DEFAULT_WEBVIEW_VIEW_NAME,
): boolean {
  if (!fileName) {
    return false;
  }

  const baseName = path.basename(fileName);
  return getHotReloadAssetFileNames(viewName).includes(baseName);
}

export async function readWebviewAssetVersion(
  baseDir: string,
  viewName = DEFAULT_WEBVIEW_VIEW_NAME,
): Promise<string> {
  const assetSignatures = await Promise.all(
    getHotReloadAssetFileNames(viewName).map(async (fileName) => {
      try {
        const filePath = path.join(baseDir, fileName);
        const fileStats = await stat(filePath);
        return `${fileName}:${fileStats.mtimeMs}:${fileStats.size}`;
      } catch {
        return `${fileName}:missing`;
      }
    }),
  );

  return assetSignatures.join('|');
}
