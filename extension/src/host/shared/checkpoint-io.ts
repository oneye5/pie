import * as fs from 'node:fs/promises';

import { coerceRunSnapshot } from '../run-analytics/coercion-snapshots';
import { isObjectRecord } from '../run-analytics/coercion-utils';
import {
  RUN_ANALYTICS_SCHEMA_VERSION,
  type PersistedSessionRunState,
  type RunCheckpoint,
} from '../run-analytics/types';

// Import choice / cycle-avoidance:
//  - RUN_ANALYTICS_SCHEMA_VERSION + PersistedSessionRunState + RunCheckpoint come from
//    `../run-analytics/types` (the leaf module). Importing the run-analytics/index barrel
//    would be safe today (it re-exports types + coercion only, not query.ts), but the leaf
//    module is the canonical source and keeps us free of any future barrel cycle.
//  - coerceRunSnapshot is canonically defined in `../run-analytics/coercion-snapshots`
//    (re-exported via the run-analytics barrel). We import from the leaf coercion module
//    directly: it depends only on coercion-utils / -rollups / -factors / -functional-settings,
//    none of which import this shared module, so there is no cycle.
//  - The `isTaskBoundaryIntent` predicate is canonically defined in
//    `stats-service/helpers.ts`. Importing it from there would create a cycle
//    (stats-service/helpers will re-export parseCheckpoint from this module, and any
//    stats-service consumer could pull this module in transitively), so the small
//    predicate is inlined here instead.

function isTaskBoundaryIntent(value: unknown): value is Exclude<PersistedSessionRunState['nextTaskIntent'], null> {
  return value === 'new_task' || value === 'continue_task';
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

function parsePersistedSessionRunState(value: unknown): PersistedSessionRunState | null {
  if (!isObjectRecord(value)) {
    return null;
  }

  return {
    currentRun: coerceRunSnapshot(value.currentRun),
    lastRun: coerceRunSnapshot(value.lastRun),
    nextTaskIntent: isTaskBoundaryIntent(value.nextTaskIntent) ? value.nextTaskIntent : null,
    queuedUnsupportedInputCount:
      typeof value.queuedUnsupportedInputCount === 'number'
      && Number.isFinite(value.queuedUnsupportedInputCount)
      && value.queuedUnsupportedInputCount >= 0
        ? Math.trunc(value.queuedUnsupportedInputCount)
        : 0,
    busyStartedAt: typeof value.busyStartedAt === 'string' ? value.busyStartedAt : null,
  };
}

export function parseCheckpoint(raw: string): RunCheckpoint | null {
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

export { readOptionalText };