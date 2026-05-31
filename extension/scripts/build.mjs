import { watch as fsWatch } from 'node:fs';
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import esbuild from 'esbuild';
import tailwindPlugin from 'esbuild-plugin-tailwindcss';

const rootDir = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const srcDir = path.join(rootDir, 'src');
const outDir = path.join(rootDir, 'out');

const watchMode = process.argv.includes('--watch');
const skipTypecheck = process.argv.includes('--skip-typecheck');
const webviewViewName = 'panel';
const webviewRelativeDir = path.join('webview', webviewViewName);
const sourceWebviewAssetFileNames = new Set([
  'index.html',
]);
const hotReloadWebviewFileNames = new Set([
  'index.html',
  `${webviewViewName}.css`,
  `${webviewViewName}.js`,
]);
const copiedAssetRelativePaths = [
  path.join(webviewRelativeDir, 'index.html'),
];

let syncTimer;
let syncQueue = Promise.resolve();
let pendingAssetCopyTimer;
const pendingAssetCopies = new Set();

function createNodeBuildOptions(entryPoint, outfile, extraOptions = {}) {
  return {
    entryPoints: [path.join(srcDir, entryPoint)],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: path.join(outDir, outfile),
    sourcemap: true,
    target: 'node20',
    ...extraOptions,
  };
}

function createWebviewBuildOptions() {
  return {
    entryPoints: [path.join(srcDir, 'webview', webviewViewName, `${webviewViewName}.tsx`)],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    outfile: path.join(outDir, 'webview', webviewViewName, `${webviewViewName}.js`),
    sourcemap: true,
    target: 'es2022',
    jsx: 'automatic',
    jsxImportSource: 'preact',
  };
}

function createWebviewCssBuildOptions() {
  return {
    entryPoints: [path.join(srcDir, 'webview', webviewViewName, 'styles', 'index.css')],
    bundle: true,
    outfile: path.join(outDir, 'webview', webviewViewName, `${webviewViewName}.css`),
    sourcemap: true,
    target: 'es2022',
    plugins: [tailwindPlugin()],
  };
}

function createBuildConfigurations() {
  return [
    createNodeBuildOptions('extension.ts', 'extension.js', { external: ['vscode'] }),
    createNodeBuildOptions(path.join('backend', 'index.ts'), 'backend.js'),
    createWebviewBuildOptions(),
    createWebviewCssBuildOptions(),
  ];
}

const LEGACY_EXTENSION_IDS = Object.freeze([
  'pi-config.pi-assistant',
]);

async function listInstalledExtensionDirs(extensionRoot) {
  try {
    const entries = await readdir(extensionRoot, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(extensionRoot, entry.name));
  } catch {
    return [];
  }
}

async function chooseInstalledExtensionDir(pkg) {
  const extensionRoots = [
    path.join(os.homedir(), '.vscode', 'extensions'),
    path.join(os.homedir(), '.vscode-insiders', 'extensions'),
  ];
  const currentExtensionId = `${pkg.publisher}.${pkg.name}`;
  const knownExtensionIds = [currentExtensionId, ...LEGACY_EXTENSION_IDS];

  for (const extensionRoot of extensionRoots) {
    const exactCurrent = path.join(extensionRoot, `${currentExtensionId}-${pkg.version}`);
    try {
      await stat(exactCurrent);
      return exactCurrent;
    } catch {
      // fall through to prefix/package inspection
    }

    const installedDirs = await listInstalledExtensionDirs(extensionRoot);
    const prefixMatches = installedDirs.filter((dir) => {
      const baseName = path.basename(dir);
      return knownExtensionIds.some((extensionId) => baseName === extensionId || baseName.startsWith(`${extensionId}-`));
    });
    if (prefixMatches.length > 0) {
      return prefixMatches.sort((left, right) => right.localeCompare(left))[0];
    }

    for (const extDir of installedDirs) {
      try {
        const installedPkg = JSON.parse(await readFile(path.join(extDir, 'package.json'), 'utf8'));
        const installedExtensionId = `${installedPkg.publisher}.${installedPkg.name}`;
        if (knownExtensionIds.includes(installedExtensionId)) {
          return extDir;
        }
      } catch {
        // ignore directories without a readable extension manifest
      }
    }
  }

  return null;
}

/** Sync runtime output and manifest files to the locally installed extension so GUI-only edits can refresh in-place. */
async function syncToInstalledExtension() {
  const pkg = JSON.parse(await readFile(path.join(rootDir, 'package.json'), 'utf8'));
  const extDir = await chooseInstalledExtensionDir(pkg);
  if (!extDir) {
    const currentExtensionId = `${pkg.publisher}.${pkg.name}`;
    console.warn(
      `[build] No installed VS Code extension directory found for ${currentExtensionId} (legacy fallback: ${LEGACY_EXTENSION_IDS.join(', ')}).`,
    );
    return;
  }

  const dest = path.join(extDir, 'out');
  await mkdir(dest, { recursive: true });
  await cp(outDir, dest, { recursive: true, force: true });
  await writeFile(path.join(extDir, 'package.json'), JSON.stringify(pkg, null, 2));
  console.log(`Synced → ${extDir}`);
}

async function copyAsset(relativePath) {
  const sourcePath = path.join(srcDir, relativePath);
  const targetPath = path.join(outDir, relativePath);
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, await readFile(sourcePath));
}

function scheduleSyncToInstalledExtension() {
  if (syncTimer !== undefined) {
    return;
  }

  syncTimer = setTimeout(() => {
    syncTimer = undefined;
    syncQueue = syncQueue
      .then(() => syncToInstalledExtension())
      .catch((error) => {
        console.error('[build] Failed to sync installed extension output', error);
      });
  }, 120);
}

function scheduleAssetCopy(relativePath) {
  pendingAssetCopies.add(relativePath);
  if (pendingAssetCopyTimer !== undefined) {
    return;
  }

  pendingAssetCopyTimer = setTimeout(() => {
    const assetPaths = [...pendingAssetCopies];
    pendingAssetCopies.clear();
    pendingAssetCopyTimer = undefined;

    void Promise.all(assetPaths.map(async (assetPath) => {
      await copyAsset(assetPath);
      console.log(`Copied → ${assetPath}`);
    })).catch((error) => {
      console.error('[build] Failed to copy watched asset', error);
    });
  }, 40);
}

function createSourceAssetWatcher() {
  const sourceDir = path.join(srcDir, webviewRelativeDir);
  const watcher = fsWatch(sourceDir, (_eventType, fileName) => {
    const changedFile = typeof fileName === 'string' ? fileName : fileName?.toString();
    if (!changedFile || !sourceWebviewAssetFileNames.has(changedFile)) {
      return;
    }

    scheduleAssetCopy(path.join(webviewRelativeDir, changedFile));
  });

  watcher.on('error', (error) => {
    console.error('[build] Source asset watcher failed', error);
  });

  return watcher;
}

function createBuiltWebviewWatcher() {
  const builtDir = path.join(outDir, webviewRelativeDir);
  const watcher = fsWatch(builtDir, (_eventType, fileName) => {
    const changedFile = typeof fileName === 'string' ? fileName : fileName?.toString();
    if (!changedFile || !hotReloadWebviewFileNames.has(changedFile)) {
      return;
    }

    scheduleSyncToInstalledExtension();
  });

  watcher.on('error', (error) => {
    console.error('[build] Built webview watcher failed', error);
  });

  return watcher;
}

async function copyStaticAssets() {
  await Promise.all(copiedAssetRelativePaths.map((relativePath) => copyAsset(relativePath)));
}

async function buildOnce() {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  // Gate on typecheck: catch interface/usage mismatches before bundling.
  // This prevents silent runtime crashes from fields missing in shared types.
  // Use --skip-typecheck to bypass temporarily during iterative development.
  if (!skipTypecheck) {
    try {
      execSync('npx tsc --noEmit -p tsconfig.json', { cwd: rootDir, stdio: 'pipe' });
    } catch (err) {
      const output = err.stdout?.toString() || err.stderr?.toString() || '';
      console.error('[build] TypeScript errors detected — fix before building:\n');
      console.error(output);
      console.error('\n[build] Use --skip-typecheck to bypass (not recommended).');
      process.exit(1);
    }
  }

  await Promise.all(createBuildConfigurations().map((config) => esbuild.build(config)));
  await copyStaticAssets();
  await syncToInstalledExtension();
}

if (watchMode) {
  const contexts = await Promise.all(createBuildConfigurations().map((config) => esbuild.context(config)));

  await mkdir(path.join(outDir, webviewRelativeDir), { recursive: true });
  const sourceAssetWatcher = createSourceAssetWatcher();
  const builtWebviewWatcher = createBuiltWebviewWatcher();

  await Promise.all(contexts.map((context) => context.watch()));
  await copyStaticAssets();
  await syncToInstalledExtension();

  const shutdown = async () => {
    if (syncTimer !== undefined) {
      clearTimeout(syncTimer);
      syncTimer = undefined;
    }
    if (pendingAssetCopyTimer !== undefined) {
      clearTimeout(pendingAssetCopyTimer);
      pendingAssetCopyTimer = undefined;
    }

    sourceAssetWatcher.close();
    builtWebviewWatcher.close();
    await Promise.all(contexts.map((context) => context.dispose()));
  };

  process.once('SIGINT', () => {
    void shutdown();
  });
  process.once('SIGTERM', () => {
    void shutdown();
  });
} else {
  await buildOnce();
}
