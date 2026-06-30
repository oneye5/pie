import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import test from 'node:test';

import {
  buildWorkspaceAnalyticsIdFromRoot,
  detectLatestStorageDir,
  detectPreferredStorageDir,
  listStorageDirCandidates,
  normalizeFileSystemPathForWorkspaceKey,
  workspaceStorageHash,
  workspaceStorageHashCandidates,
} from '../scripts/source-auto.ts';
import { withTempDir } from './helpers.ts';

async function writeArtifact(storageDir: string, fileName: string, mtimeMs: number): Promise<void> {
  await fs.mkdir(storageDir, { recursive: true });
  const filePath = path.join(storageDir, fileName);
  await fs.writeFile(filePath, '{}\n', 'utf8');
  const timestamp = new Date(mtimeMs);
  await fs.utimes(filePath, timestamp, timestamp);
}

test('buildWorkspaceAnalyticsIdFromRoot and workspaceStorageHash are deterministic', () => {
  const workspaceRoot = 'D:\\Projects\\StandAloneProjects\\pi-config';
  const workspaceId = buildWorkspaceAnalyticsIdFromRoot(workspaceRoot, 'win32');
  assert.equal(workspaceId, JSON.stringify({ folders: ['file:d:/projects/standaloneprojects/pi-config'] }));
  assert.equal(workspaceStorageHash(workspaceId), '7161a5ef2dd349b4');
});

test('detectPreferredStorageDir picks workspace-matching storage hash when present', async () => {
  await withTempDir(async (outcomesRoot) => {
    const workspaceRoot = 'D:\\Repo\\preferred-workspace';
    const preferredHash = workspaceStorageHash(buildWorkspaceAnalyticsIdFromRoot(workspaceRoot, 'win32'));

    const preferredDir = path.join(outcomesRoot, preferredHash);
    const newerOtherDir = path.join(outcomesRoot, 'ffffffffffffffff');

    await writeArtifact(preferredDir, 'run-snapshots.jsonl', 1_000);
    await writeArtifact(newerOtherDir, 'run-snapshots.jsonl', 2_000);

    const selected = await detectPreferredStorageDir(outcomesRoot, workspaceRoot, 'win32');
    assert.equal(selected, preferredDir);
  });
});

test('detectPreferredStorageDir returns null when no workspace-hash match exists', async () => {
  await withTempDir(async (outcomesRoot) => {
    const olderDir = path.join(outcomesRoot, '1111111111111111');
    const newerDir = path.join(outcomesRoot, '2222222222222222');

    await writeArtifact(olderDir, 'outcome-history.jsonl', 5_000);
    await writeArtifact(newerDir, 'run-snapshots.jsonl', 9_000);

    const selected = await detectPreferredStorageDir(outcomesRoot, '/tmp/unrelated-workspace', 'linux');
    assert.equal(selected, null);
  });
});

test('detectLatestStorageDir returns the most recently active storage dir', async () => {
  await withTempDir(async (outcomesRoot) => {
    const olderDir = path.join(outcomesRoot, '1111111111111111');
    const newerDir = path.join(outcomesRoot, '2222222222222222');

    await writeArtifact(olderDir, 'outcome-history.jsonl', 5_000);
    await writeArtifact(newerDir, 'run-snapshots.jsonl', 9_000);

    const selected = await detectLatestStorageDir(outcomesRoot);
    assert.equal(selected, newerDir);
  });
});

test('workspaceStorageHashCandidates includes workspace-file hashes', async () => {
  await withTempDir(async (workspaceRoot) => {
    const workspaceFilePath = path.join(workspaceRoot, 'team.code-workspace');
    await fs.writeFile(workspaceFilePath, '{"folders":[]}', 'utf8');

    const platform = process.platform;
    const hashes = await workspaceStorageHashCandidates(workspaceRoot, platform);
    const workspaceFileId = JSON.stringify({
      workspaceFile: `file:${normalizeFileSystemPathForWorkspaceKey(workspaceFilePath, platform)}`,
    });
    assert.ok(hashes.has(workspaceStorageHash(workspaceFileId)));
  });
});

test('listStorageDirCandidates ignores directories without analytics artifacts', async () => {
  await withTempDir(async (outcomesRoot) => {
    const ignoredDir = path.join(outcomesRoot, 'aaaaaaaaaaaaaaaa');
    const includedDir = path.join(outcomesRoot, 'bbbbbbbbbbbbbbbb');

    await fs.mkdir(ignoredDir, { recursive: true });
    await writeArtifact(includedDir, 'open-runs.a.json', 7_000);

    const candidates = await listStorageDirCandidates(outcomesRoot);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]?.storageDir, includedDir);
  });
});

test('workspace and outcomes discovery tolerate missing directories', async () => {
  await withTempDir(async (root) => {
    const missingWorkspaceRoot = path.join(root, 'missing-workspace');
    const expectedRootHash = workspaceStorageHash(buildWorkspaceAnalyticsIdFromRoot(missingWorkspaceRoot, 'linux'));

    const hashes = await workspaceStorageHashCandidates(missingWorkspaceRoot, 'linux');
    assert.equal(hashes.size, 1);
    assert.ok(hashes.has(expectedRootHash));

    const missingOutcomesRoot = path.join(root, 'missing-outcomes');
    assert.deepEqual(await listStorageDirCandidates(missingOutcomesRoot), []);
    assert.equal(await detectLatestStorageDir(missingOutcomesRoot), null);
    assert.equal(await detectPreferredStorageDir(missingOutcomesRoot, missingWorkspaceRoot, 'linux'), null);
  });
});

test('listStorageDirCandidates sorts tied directories alphabetically and rethrows invalid roots', async () => {
  await withTempDir(async (root) => {
    const outcomesRoot = path.join(root, 'outcomes');
    await fs.mkdir(outcomesRoot, { recursive: true });

    await writeArtifact(path.join(outcomesRoot, 'bbbbbbbbbbbbbbbb'), 'run-snapshots.jsonl', 12_000);
    await writeArtifact(path.join(outcomesRoot, 'aaaaaaaaaaaaaaaa'), 'outcome-history.jsonl', 12_000);
    await fs.writeFile(path.join(outcomesRoot, 'notes.txt'), 'ignore me', 'utf8');

    const candidates = await listStorageDirCandidates(outcomesRoot);
    assert.deepEqual(
      candidates.map((candidate) => path.basename(candidate.storageDir)),
      ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb'],
    );

    const fileBackedRoot = path.join(root, 'outcomes-file');
    await fs.writeFile(fileBackedRoot, 'not a directory', 'utf8');
    await assert.rejects(async () => await listStorageDirCandidates(fileBackedRoot));
  });
});
