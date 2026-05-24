import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  getWebviewAssetDir,
  isHotReloadAssetFileName,
  readWebviewAssetVersion,
} from '../src/host/webview/hot-reload';

test('isHotReloadAssetFileName matches only the built panel assets', () => {
  assert.equal(isHotReloadAssetFileName('panel.js'), true);
  assert.equal(isHotReloadAssetFileName('panel.css'), true);
  assert.equal(isHotReloadAssetFileName('index.html'), true);
  assert.equal(isHotReloadAssetFileName('/tmp/panel.js'), true);
  assert.equal(isHotReloadAssetFileName('panel.js.map'), false);
  assert.equal(isHotReloadAssetFileName('panel.tsx'), false);
  assert.equal(isHotReloadAssetFileName(undefined), false);
});

test('readWebviewAssetVersion changes when a built asset changes', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'pie-webview-hot-reload-'));
  const assetDir = getWebviewAssetDir(rootDir);

  try {
    await mkdir(assetDir, { recursive: true });
    await Promise.all([
      writeFile(path.join(assetDir, 'index.html'), '<div id="app"></div>'),
      writeFile(path.join(assetDir, 'panel.css'), '.panel { color: red; }'),
      writeFile(path.join(assetDir, 'panel.js'), 'console.log("one");'),
    ]);

    const firstVersion = await readWebviewAssetVersion(assetDir);
    const unchangedVersion = await readWebviewAssetVersion(assetDir);
    assert.equal(unchangedVersion, firstVersion);

    await writeFile(path.join(assetDir, 'panel.css'), '.panel { color: rebeccapurple; font-weight: 600; }');
    const updatedVersion = await readWebviewAssetVersion(assetDir);

    assert.notEqual(updatedVersion, firstVersion);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
