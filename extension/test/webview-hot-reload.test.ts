import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  getWebviewAssetDir,
  isHotReloadAssetFileName,
  readWebviewAssetVersion,
} from '../src/host/webview/hot-reload';

test('isHotReloadAssetFileName matches built assets and ignores sourcemaps', () => {
  assert.equal(isHotReloadAssetFileName('panel.js'), true);
  assert.equal(isHotReloadAssetFileName('panel-abc123.js'), true);
  assert.equal(isHotReloadAssetFileName('panel.css'), true);
  assert.equal(isHotReloadAssetFileName('index.html'), true);
  assert.equal(isHotReloadAssetFileName('.vite/manifest.json'), true);
  assert.equal(isHotReloadAssetFileName('/tmp/panel.js'), true);
  assert.equal(isHotReloadAssetFileName('panel.js.map'), false);
  assert.equal(isHotReloadAssetFileName(undefined), false);
});

test('readWebviewAssetVersion changes when the Vite manifest changes', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'pie-webview-hot-reload-'));
  const assetDir = getWebviewAssetDir(rootDir);

  try {
    const manifestDir = path.join(assetDir, '.vite');
    await mkdir(manifestDir, { recursive: true });
    await writeFile(
      path.join(manifestDir, 'manifest.json'),
      JSON.stringify({ 'src/webview/panel/panel.tsx': { file: 'assets/panel-aaa.js', isEntry: true } }),
    );

    const firstVersion = await readWebviewAssetVersion(assetDir);
    const unchangedVersion = await readWebviewAssetVersion(assetDir);
    assert.equal(unchangedVersion, firstVersion);

    await writeFile(
      path.join(manifestDir, 'manifest.json'),
      JSON.stringify({ 'src/webview/panel/panel.tsx': { file: 'assets/panel-bbb.js', isEntry: true } }),
    );
    const updatedVersion = await readWebviewAssetVersion(assetDir);

    assert.notEqual(updatedVersion, firstVersion);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('build script removes stale installed output before syncing rebuilt assets', async () => {
  const buildScript = await readFile(new URL('../scripts/build.mjs', import.meta.url), 'utf8');

  assert.match(buildScript, /await rm\(dest, \{ recursive: true, force: true \}\);/);
  assert.match(buildScript, /await cp\(outDir, dest, \{ recursive: true, force: true \}\);/);
  assert.ok(
    buildScript.indexOf('await rm(dest, { recursive: true, force: true });')
      < buildScript.indexOf('await cp(outDir, dest, { recursive: true, force: true });'),
    'installed out directory must be cleared before copying rebuilt output',
  );
});

test('build script builds the webview with Vite', async () => {
  const buildScript = await readFile(new URL('../scripts/build.mjs', import.meta.url), 'utf8');

  assert.match(buildScript, /function buildWebview\(\)/);
  assert.match(buildScript, /execSync\('npx vite build'/);
  assert.match(buildScript, /function runViteWatch\(\)/);
  assert.match(buildScript, /spawn\('npx vite build --watch'/);
});
