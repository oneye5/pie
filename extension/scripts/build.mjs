import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import esbuild from 'esbuild';

const rootDir = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const srcDir = path.join(rootDir, 'src');
const outDir = path.join(rootDir, 'out');

const watch = process.argv.includes('--watch');

/** Sync runtime output and manifest files to the locally installed extension so Reload Window picks up contributed view changes too. */
async function syncToInstalledExtension() {
  const pkg = JSON.parse(await readFile(path.join(rootDir, 'package.json'), 'utf8'));
  const extId = `${pkg.publisher}.${pkg.name}-${pkg.version}`;
  const candidates = [
    path.join(os.homedir(), '.vscode', 'extensions', extId),
    path.join(os.homedir(), '.vscode-insiders', 'extensions', extId),
  ];

  for (const extDir of candidates) {
    try {
      await stat(extDir);
      const dest = path.join(extDir, 'out');
      await rm(dest, { recursive: true, force: true });
      await cp(outDir, dest, { recursive: true, force: true });
      await writeFile(path.join(extDir, 'package.json'), JSON.stringify(pkg, null, 2));
      console.log(`Synced → ${extDir}`);
      return;
    } catch {
      // not found, try next
    }
  }
}

async function copyAsset(relativePath) {
  const sourcePath = path.join(srcDir, relativePath);
  const targetPath = path.join(outDir, relativePath.replace(/^webview\//, 'webview/'));
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, await readFile(sourcePath));
}

async function buildOnce() {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  await Promise.all([
    esbuild.build({
      entryPoints: [path.join(srcDir, 'extension.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: path.join(outDir, 'extension.js'),
      sourcemap: true,
      target: 'node20',
      external: ['vscode'],
    }),
    esbuild.build({
      entryPoints: [path.join(srcDir, 'backend', 'index.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: path.join(outDir, 'backend.js'),
      sourcemap: true,
      target: 'node20',
    }),
    esbuild.build({
      entryPoints: [path.join(srcDir, 'webview', 'panel', 'panel.tsx')],
      bundle: true,
      platform: 'browser',
      format: 'iife',
      outfile: path.join(outDir, 'webview', 'panel', 'panel.js'),
      sourcemap: true,
      target: 'es2022',
      jsx: 'automatic',
      jsxImportSource: 'preact',
    }),
  ]);

  await Promise.all([
    copyAsset(path.join('webview', 'panel', 'index.html')),
    copyAsset(path.join('webview', 'panel', 'panel.css')),
  ]);

  await syncToInstalledExtension();
}

if (watch) {
  const contexts = await Promise.all([
    esbuild.context({
      entryPoints: [path.join(srcDir, 'extension.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: path.join(outDir, 'extension.js'),
      sourcemap: true,
      target: 'node20',
      external: ['vscode'],
    }),
    esbuild.context({
      entryPoints: [path.join(srcDir, 'backend', 'index.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: path.join(outDir, 'backend.js'),
      sourcemap: true,
      target: 'node20',
    }),
    esbuild.context({
      entryPoints: [path.join(srcDir, 'webview', 'panel', 'panel.tsx')],
      bundle: true,
      platform: 'browser',
      format: 'iife',
      outfile: path.join(outDir, 'webview', 'panel', 'panel.js'),
      sourcemap: true,
      target: 'es2022',
      jsx: 'automatic',
      jsxImportSource: 'preact',
    }),
  ]);

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  await Promise.all(contexts.map((context) => context.watch()));
  await Promise.all([
    copyAsset(path.join('webview', 'panel', 'index.html')),
    copyAsset(path.join('webview', 'panel', 'panel.css')),
  ]);
} else {
  await buildOnce();
}
