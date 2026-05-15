import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  buildWorkspaceAnalyticsId,
  getDataOutcomesRootPath,
  getDefaultRunAnalyticsExportPath,
} from '../src/host/analytics-storage';

function createFileUri(fileSystemPath: string, raw = `file://${fileSystemPath}`) {
  return {
    scheme: 'file',
    fsPath: fileSystemPath,
    toString: () => raw,
  };
}

test('buildWorkspaceAnalyticsId canonicalizes multi-root file folders across order and casing', () => {
  const left = buildWorkspaceAnalyticsId({
    workspaceFolders: [
      { uri: createFileUri('C:\\Repo\\Two') },
      { uri: createFileUri('c:\\repo\\one') },
    ],
    noWorkspaceId: 'unused-left',
    platform: 'win32',
  });

  const right = buildWorkspaceAnalyticsId({
    workspaceFolders: [
      { uri: createFileUri('c:\\REPO\\ONE') },
      { uri: createFileUri('C:\\repo\\two') },
    ],
    noWorkspaceId: 'unused-right',
    platform: 'win32',
  });

  assert.equal(left, right);
  assert.equal(left, JSON.stringify({
    folders: [
      'file:c:/repo/one',
      'file:c:/repo/two',
    ],
  }));
});

test('buildWorkspaceAnalyticsId serializes folder sets without delimiter collisions', () => {
  const left = buildWorkspaceAnalyticsId({
    workspaceFolders: [
      { uri: { scheme: 'mem', toString: () => 'mem:/a' } },
      { uri: { scheme: 'mem', toString: () => 'mem:/b|mem:/c' } },
    ],
    noWorkspaceId: 'unused',
  });

  const right = buildWorkspaceAnalyticsId({
    workspaceFolders: [
      { uri: { scheme: 'mem', toString: () => 'mem:/a|mem:/b' } },
      { uri: { scheme: 'mem', toString: () => 'mem:/c' } },
    ],
    noWorkspaceId: 'unused',
  });

  assert.notEqual(left, right);
});

test('buildWorkspaceAnalyticsId falls back to the workspace file when no folders are open', () => {
  const workspaceId = buildWorkspaceAnalyticsId({
    workspaceFile: createFileUri('/workspaces/pie/pie.code-workspace'),
    noWorkspaceId: 'unused',
    platform: 'linux',
  });

  assert.equal(workspaceId, JSON.stringify({
    workspaceFile: 'file:/workspaces/pie/pie.code-workspace',
  }));
});

test('buildWorkspaceAnalyticsId uses the persisted no-workspace id as a collision-proof fallback', () => {
  const workspaceId = buildWorkspaceAnalyticsId({
    noWorkspaceId: 'window-analytics-id',
  });

  assert.equal(workspaceId, JSON.stringify({
    noWorkspaceId: 'window-analytics-id',
  }));
});

test('getDataOutcomesRootPath prefers PI_CODING_AGENT_DIR when configured', () => {
  const savedEnv = process.env.PIE_ANALYTICS_DIR;
  delete process.env.PIE_ANALYTICS_DIR;
  try {
    assert.equal(
      getDataOutcomesRootPath('  /repo/root  ', '/global/storage'),
      path.join('/repo/root', 'data', 'outcomes'),
    );
    assert.equal(
      getDataOutcomesRootPath('', '/global/storage'),
      path.join('/global/storage', 'data', 'outcomes'),
    );
  } finally {
    if (savedEnv !== undefined) {
      process.env.PIE_ANALYTICS_DIR = savedEnv;
    }
  }
});

test('getDataOutcomesRootPath prefers PIE_ANALYTICS_DIR env var over all other sources', () => {
  const savedEnv = process.env.PIE_ANALYTICS_DIR;
  process.env.PIE_ANALYTICS_DIR = '/custom/analytics';
  try {
    assert.equal(
      getDataOutcomesRootPath('/repo/root', '/global/storage'),
      path.resolve('/custom/analytics'),
    );
  } finally {
    if (savedEnv !== undefined) {
      process.env.PIE_ANALYTICS_DIR = savedEnv;
    } else {
      delete process.env.PIE_ANALYTICS_DIR;
    }
  }
});

test('getDefaultRunAnalyticsExportPath prefers the configured PI repo path when available', () => {
  assert.equal(
    getDefaultRunAnalyticsExportPath('/pi-config', '/global/storage', '/workspace/project'),
    path.join('/pi-config', 'analysis', 'data', 'exports', 'run-analytics-export.json'),
  );
});

test('getDefaultRunAnalyticsExportPath falls back to extension global storage outside the PI repo', () => {
  assert.equal(
    getDefaultRunAnalyticsExportPath('', '/global/storage', '/workspace/project'),
    path.join('/global/storage', 'exports', 'project', 'run-analytics-export.json'),
  );
});
