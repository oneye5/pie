import { watch as fsWatch } from 'node:fs';
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import esbuild from 'esbuild';

const rootDir = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const srcDir = path.join(rootDir, 'src');
const outDir = path.join(rootDir, 'out');

const watchMode = process.argv.includes('--watch');
const skipTypecheck = process.argv.includes('--skip-typecheck');
const noSync = process.argv.includes('--no-sync');
const webviewViewName = 'panel';
const webviewRelativeDir = path.join('webview', webviewViewName);

let syncTimer;
let syncQueue = Promise.resolve();

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

function createBuildConfigurations() {
  return [
    createNodeBuildOptions('extension.ts', 'extension.js', { external: ['vscode'] }),
    createNodeBuildOptions(path.join('backend', 'index.ts'), 'backend.js'),
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

async function syncToInstalledExtension() {
  if (noSync) {
    return;
  }

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
  await rm(dest, { recursive: true, force: true });
  await mkdir(path.dirname(dest), { recursive: true });
  await cp(outDir, dest, { recursive: true, force: true });
  await writeFile(path.join(extDir, 'package.json'), JSON.stringify(pkg, null, 2));
  console.log(`Synced → ${extDir}`);
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

async function buildWebview() {
  console.log('[build] Building webview with Vite...');
  execSync('npx vite build', { cwd: rootDir, stdio: 'inherit' });
}

function runViteWatch() {
  console.log('[build] Starting Vite watch for webview...');
  const child = spawn('npx vite build --watch', {
    cwd: rootDir,
    stdio: 'inherit',
    shell: true,
  });

  child.on('error', (error) => {
    console.error('[build] Vite watch process failed to start', error);
  });

  return child;
}

function createBuiltWebviewWatcher() {
  const builtDir = path.join(outDir, webviewRelativeDir);
  const watcher = fsWatch(builtDir, { recursive: true }, (_eventType, fileName) => {
    const changedFile = typeof fileName === 'string' ? fileName : fileName?.toString();
    if (!changedFile || changedFile.endsWith('.map')) {
      return;
    }

    scheduleSyncToInstalledExtension();
  });

  watcher.on('error', (error) => {
    console.error('[build] Built webview watcher failed', error);
  });

  return watcher;
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
  await buildWebview();
  await syncToInstalledExtension();
}

if (watchMode) {
  const contexts = await Promise.all(createBuildConfigurations().map((config) => esbuild.context(config)));
  const viteProcess = runViteWatch();
  const builtWebviewWatcher = createBuiltWebviewWatcher();

  await Promise.all(contexts.map((context) => context.watch()));
  await syncToInstalledExtension();

  const shutdown = async () => {
    if (syncTimer !== undefined) {
      clearTimeout(syncTimer);
      syncTimer = undefined;
    }

    builtWebviewWatcher.close();
    viteProcess.kill();
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
