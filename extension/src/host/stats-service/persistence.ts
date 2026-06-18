import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { RunCheckpoint } from '../run-analytics';
import { resolveCheckpointSlot } from '../shared/checkpoint-slots';

export type CheckpointSlot = 'a' | 'b';

interface ReadCheckpointResult {
  checkpoint: RunCheckpoint | null;
  activeSlot: CheckpointSlot;
}

async function readOptionalText(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export async function readCheckpointFromDisk(
  storageDir: string,
  parseCheckpoint: (raw: string) => RunCheckpoint | null,
): Promise<ReadCheckpointResult> {
  const genPath = path.join(storageDir, 'open-runs.gen');
  const slotAPath = path.join(storageDir, 'open-runs.a.json');
  const slotBPath = path.join(storageDir, 'open-runs.b.json');

  const [genValue, slotA, slotB] = await Promise.all([
    readOptionalText(genPath),
    readOptionalText(slotAPath),
    readOptionalText(slotBPath),
  ]);

  const checkpointA = slotA ? parseCheckpoint(slotA) : null;
  const checkpointB = slotB ? parseCheckpoint(slotB) : null;
  return resolveCheckpointSlot(genValue, checkpointA, checkpointB);
}

export async function writeCheckpointToDisk(
  storageDir: string,
  activeSlot: CheckpointSlot,
  checkpoint: RunCheckpoint,
): Promise<CheckpointSlot> {
  const nextSlot: CheckpointSlot = activeSlot === 'a' ? 'b' : 'a';
  const slotPath = path.join(storageDir, `open-runs.${nextSlot}.json`);
  const genPath = path.join(storageDir, 'open-runs.gen');

  await fs.writeFile(slotPath, JSON.stringify(checkpoint, null, 2), 'utf8');
  await fs.writeFile(genPath, nextSlot, 'utf8');
  return nextSlot;
}
