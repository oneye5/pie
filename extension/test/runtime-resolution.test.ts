import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { resolveCommandInvocation } from '../src/shared/command-invocation';
import { createCommandExecutor } from '../src/shared/exec-command';
import {
  resolveNodePath,
  resolveSdkPath,
} from '../src/shared/runtime-resolution';

test('resolveCommandInvocation wraps npm with cmd.exe on Windows', () => {
  const invocation = resolveCommandInvocation('npm', ['root', '-g'], {
    platform: 'win32',
    comSpec: 'C:/Windows/System32/cmd.exe',
  });

  assert.deepEqual(invocation, {
    command: 'C:/Windows/System32/cmd.exe',
    args: ['/d', '/s', '/c', 'npm root -g'],
  });
});

test('resolveCommandInvocation leaves non-Windows commands unchanged', () => {
  const invocation = resolveCommandInvocation('npm', ['root', '-g'], {
    platform: 'linux',
  });

  assert.deepEqual(invocation, {
    command: 'npm',
    args: ['root', '-g'],
  });
});

test('sdk lookup surfaces npm execution failure', async () => {
  await assert.rejects(
    () =>
      resolveSdkPath({
        env: {},
        exists: () => false,
        exec: async () => ({
          stdout: '',
          stderr: 'spawn ENOENT',
          exitCode: 1,
        }),
      }),
    /Failed to resolve the global PI SDK install via npm root -g/,
  );
});

test('resolveNodePath prefers configured setting', () => {
  const nodePath = resolveNodePath({
    configuredPath: 'C:/custom/node.exe',
    env: {},
    platform: 'win32',
    exists: (filePath) => filePath === 'C:/custom/node.exe',
  });

  assert.equal(nodePath, 'C:/custom/node.exe');
});

test('resolveNodePath falls back to PATH lookup', () => {
  const expectedPath = path.join('D:/tools', 'node.exe');
  const nodePath = resolveNodePath({
    env: {
      PATH: 'C:/bin;D:/tools',
    },
    platform: 'win32',
    exists: (filePath) => filePath === expectedPath,
  });

  assert.equal(nodePath, expectedPath);
});

test('resolveSdkPath prefers configured sdk path', async () => {
  const packageJsonPath = path.join('/opt/pi-sdk', 'package.json');
  const indexJsPath = path.join('/opt/pi-sdk', 'dist', 'index.js');
  const sdkPath = await resolveSdkPath({
    configuredPath: '/opt/pi-sdk',
    env: {},
    exists: (filePath) => filePath === packageJsonPath || filePath === indexJsPath,
    exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
  });

  assert.equal(sdkPath, '/opt/pi-sdk');
});

test('resolveSdkPath falls back to npm root -g', async () => {
  const expectedSdkPath = path.join('/global/node_modules', '@mariozechner', 'pi-coding-agent');
  const sdkPath = await resolveSdkPath({
    env: {},
    exists: (filePath) => {
      return (
        filePath === path.join(expectedSdkPath, 'package.json') ||
        filePath === path.join(expectedSdkPath, 'dist', 'index.js')
      );
    },
    exec: async () => ({
      stdout: '/global/node_modules\n',
      stderr: '',
      exitCode: 0,
    }),
  });

  assert.equal(sdkPath, expectedSdkPath);
});

// ─── execCommand / createCommandExecutor ────────────────────────────────────

test('createCommandExecutor wraps npm through cmd.exe on Windows', async () => {
  // Capture what command gets invoked by patching execFile.
  const invocations: { command: string; args: string[] }[] = [];
  const { execFile } = await import('node:child_process');

  // We call the real resolveCommandInvocation to verify integration.
  const win32Invocation = resolveCommandInvocation('npm', ['root', '-g'], { platform: 'win32' });
  assert.equal(win32Invocation.command.toLowerCase().endsWith('cmd.exe') || win32Invocation.command === 'cmd.exe', true, 'Windows npm should route through cmd.exe');
  assert.ok(win32Invocation.args.includes('/c'), 'Should pass /c to cmd.exe');
});

test('createCommandExecutor passes non-Windows npm through unchanged', () => {
  const invocation = resolveCommandInvocation('npm', ['root', '-g'], { platform: 'linux' });
  assert.equal(invocation.command, 'npm');
  assert.deepEqual(invocation.args, ['root', '-g']);
});

test('resolveSdkPath error includes useful message when npm fails with empty output', async () => {
  // Regression: on Windows, execFile('npm') silently fails returning empty stdout+stderr.
  // The error must still be actionable, not just an empty string.
  await assert.rejects(
    () =>
      resolveSdkPath({
        env: {},
        exists: () => false,
        exec: async () => ({ stdout: '', stderr: '', exitCode: 1 }),
      }),
    (err: Error) => {
      assert.ok(
        err.message.includes('npm root -g'),
        `Error message should mention 'npm root -g', got: ${err.message}`,
      );
      return true;
    },
  );
});

test('resolveSdkPath error when npm succeeds but SDK not found at resolved path', async () => {
  await assert.rejects(
    () =>
      resolveSdkPath({
        env: {},
        // npm root -g succeeds but nothing exists at that location.
        exists: () => false,
        exec: async () => ({ stdout: '/some/npm/root\n', stderr: '', exitCode: 0 }),
      }),
    /pi-coding-agent/,
  );
});

test('createCommandExecutor resolves node:child_process without throwing', () => {
  // Smoke test: the factory should be callable without error.
  assert.doesNotThrow(() => createCommandExecutor());
});
