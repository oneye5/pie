import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import {
  RUN_ANALYTICS_SCHEMA_VERSION,
  coerceOutcomeHistoryLogEntry,
  coerceRunSnapshot,
  type OutcomeHistoryLogEntry,
  type PersistedSessionRunState,
  type RunCheckpoint,
  type RunSnapshot,
} from './run-analytics';

export interface RunAnalyticsQueryResult {
  completedRuns: RunSnapshot[];
  openRuns: RunSnapshot[];
  outcomes: OutcomeHistoryLogEntry[];
}

export interface RunAnalyticsExportPayload extends RunAnalyticsQueryResult {
  schemaVersion: number;
  exportedAt: string;
  workspaceKey: string;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
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

async function readJsonlObjects(filePath: string): Promise<unknown[]> {
  const raw = await readOptionalText(filePath);
  if (!raw) {
    return [];
  }

  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as unknown;
      } catch {
        return null;
      }
    })
    .filter((value): value is unknown => value !== null);
}

function parsePersistedSessionRunState(value: unknown): PersistedSessionRunState | null {
  if (!isObjectRecord(value)) {
    return null;
  }

  return {
    currentRun: coerceRunSnapshot(value.currentRun),
    lastRun: coerceRunSnapshot(value.lastRun),
    nextTaskIntent:
      value.nextTaskIntent === 'new_task' || value.nextTaskIntent === 'continue_task'
        ? value.nextTaskIntent
        : null,
    queuedUnsupportedInputCount:
      typeof value.queuedUnsupportedInputCount === 'number'
      && Number.isFinite(value.queuedUnsupportedInputCount)
      && value.queuedUnsupportedInputCount >= 0
        ? Math.trunc(value.queuedUnsupportedInputCount)
        : 0,
    busyStartedAt: typeof value.busyStartedAt === 'string' ? value.busyStartedAt : null,
  };
}

function parseCheckpoint(raw: string): RunCheckpoint | null {
  try {
    const value = JSON.parse(raw) as {
      schemaVersion?: unknown;
      seq?: unknown;
      sessions?: unknown;
    };
    if (value.schemaVersion !== RUN_ANALYTICS_SCHEMA_VERSION || typeof value.seq !== 'number') {
      return null;
    }
    if (!isObjectRecord(value.sessions)) {
      return null;
    }

    const sessions: Record<string, PersistedSessionRunState> = {};
    for (const [sessionPath, sessionState] of Object.entries(value.sessions)) {
      const parsed = parsePersistedSessionRunState(sessionState);
      if (!parsed) {
        continue;
      }
      sessions[sessionPath] = parsed;
    }

    return {
      schemaVersion: RUN_ANALYTICS_SCHEMA_VERSION,
      seq: value.seq,
      sessions,
    };
  } catch {
    return null;
  }
}

async function readCheckpoint(storageDir: string): Promise<RunCheckpoint | null> {
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
    return preferredCheckpoint ?? fallbackCheckpoint;
  }

  if (checkpointA && checkpointB) {
    return checkpointA.seq >= checkpointB.seq ? checkpointA : checkpointB;
  }

  return checkpointA ?? checkpointB ?? null;
}

export async function queryRunAnalyticsStore(storageDir: string): Promise<RunAnalyticsQueryResult> {
  const [snapshotLines, outcomeLines, checkpoint] = await Promise.all([
    readJsonlObjects(path.join(storageDir, 'run-snapshots.jsonl')),
    readJsonlObjects(path.join(storageDir, 'outcome-history.jsonl')),
    readCheckpoint(storageDir),
  ]);

  const latestCompletedRuns = new Map<string, RunSnapshot>();
  for (const line of snapshotLines) {
    if (!isObjectRecord(line) || line.kind !== 'run_snapshot') {
      continue;
    }
    const snapshot = coerceRunSnapshot(line.run);
    if (!snapshot) {
      continue;
    }
    latestCompletedRuns.set(snapshot.runId, snapshot);
  }

  const outcomes: OutcomeHistoryLogEntry[] = [];
  for (const line of outcomeLines) {
    const entry = coerceOutcomeHistoryLogEntry(line);
    if (entry) {
      outcomes.push(entry);
    }
  }

  const openRuns = Object.values(checkpoint?.sessions ?? {})
    .map((sessionState) => sessionState.currentRun)
    .filter((run): run is RunSnapshot => run !== null);

  return {
    completedRuns: [...latestCompletedRuns.values()],
    openRuns,
    outcomes,
  };
}

export async function exportRunAnalyticsStore(
  storageDir: string,
  targetPath: string,
  now: () => Date = () => new Date(),
): Promise<RunAnalyticsExportPayload> {
  const result = await queryRunAnalyticsStore(storageDir);
  const payload: RunAnalyticsExportPayload = {
    schemaVersion: RUN_ANALYTICS_SCHEMA_VERSION,
    exportedAt: now().toISOString(),
    workspaceKey: path.basename(storageDir),
    ...result,
  };

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return payload;
}
