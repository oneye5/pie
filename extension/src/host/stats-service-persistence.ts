import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { RunCheckpoint } from './run-analytics-types';

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
  const trimmedGen = genValue?.trim();

  if (trimmedGen === 'a' || trimmedGen === 'b') {
    const preferredCheckpoint = trimmedGen === 'a' ? checkpointA : checkpointB;
    const fallbackCheckpoint = trimmedGen === 'a' ? checkpointB : checkpointA;
    if (preferredCheckpoint) {
      return { checkpoint: preferredCheckpoint, activeSlot: trimmedGen };
    }
    if (fallbackCheckpoint) {
      return { checkpoint: fallbackCheckpoint, activeSlot: trimmedGen === 'a' ? 'b' : 'a' };
    }
  }

  if (checkpointA && checkpointB) {
    return checkpointA.seq >= checkpointB.seq
      ? { checkpoint: checkpointA, activeSlot: 'a' }
      : { checkpoint: checkpointB, activeSlot: 'b' };
  }

  if (checkpointA) {
    return { checkpoint: checkpointA, activeSlot: 'a' };
  }

  if (checkpointB) {
    return { checkpoint: checkpointB, activeSlot: 'b' };
  }

  return { checkpoint: null, activeSlot: 'a' };
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
