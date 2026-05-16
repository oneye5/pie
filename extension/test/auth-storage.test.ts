import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { getDefaultAuthDir, resolveAuthPath } from '../src/backend/auth-storage';

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-auth-storage-'));
  try {
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('resolveAuthPath honors an explicit PI_CODING_AGENT_AUTH_DIR override', async () => {
  await withTempDir(async (dir) => {
    const agentDir = path.join(dir, 'agent');
    const overrideDir = path.join(dir, 'override-auth');
    await fs.mkdir(agentDir, { recursive: true });

    const authPath = await resolveAuthPath(agentDir, {
      PI_CODING_AGENT_AUTH_DIR: overrideDir,
    });

    assert.equal(authPath, path.resolve(overrideDir, 'auth.json'));
  });
});

test('resolveAuthPath migrates in-tree auth out of git work trees by default', async () => {
  await withTempDir(async (dir) => {
    const repoDir = path.join(dir, 'repo');
    const agentDir = path.join(repoDir, '.pi');
    const sourceAuthPath = path.join(agentDir, 'auth.json');
    const homeDir = path.join(dir, 'home');

    await fs.mkdir(path.join(repoDir, '.git'), { recursive: true });
    await fs.mkdir(agentDir, { recursive: true });
    await fs.mkdir(homeDir, { recursive: true });
    await fs.writeFile(sourceAuthPath, '{"token":"secret"}\n', 'utf8');

    const env: NodeJS.ProcessEnv = {
      HOME: homeDir,
      USERPROFILE: homeDir,
      LOCALAPPDATA: path.join(dir, 'local-app-data'),
    };

    const authPath = await resolveAuthPath(agentDir, env);
    const expectedPath = path.join(getDefaultAuthDir(env), 'auth.json');

    assert.equal(authPath, expectedPath);
    assert.equal(await fs.readFile(authPath, 'utf8'), '{"token":"secret"}\n');
    await assert.rejects(async () => await fs.access(sourceAuthPath));
  });
});

test('resolveAuthPath preserves in-tree auth when PIE_ALLOW_IN_TREE_AUTH is enabled', async () => {
  await withTempDir(async (dir) => {
    const repoDir = path.join(dir, 'repo');
    const agentDir = path.join(repoDir, '.pi');
    const sourceAuthPath = path.join(agentDir, 'auth.json');

    await fs.mkdir(path.join(repoDir, '.git'), { recursive: true });
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(sourceAuthPath, '{"token":"secret"}\n', 'utf8');

    const authPath = await resolveAuthPath(agentDir, {
      PIE_ALLOW_IN_TREE_AUTH: '1',
      HOME: path.join(dir, 'home'),
      USERPROFILE: path.join(dir, 'home'),
      LOCALAPPDATA: path.join(dir, 'local-app-data'),
    });

    assert.equal(authPath, sourceAuthPath);
    assert.equal(await fs.readFile(sourceAuthPath, 'utf8'), '{"token":"secret"}\n');
  });
});
