import * as fs from 'node:fs/promises';

import { coerceRunSnapshot } from '../run-analytics/coercion-snapshots';
import { isObjectRecord } from '../run-analytics/coercion-utils';
import {
  RUN_ANALYTICS_SCHEMA_VERSION,
  type PersistedSessionRunState,
  type RunCheckpoint,
} from '../run-analytics/types';
import { MIGRATION_FAILED, migrateCheckpoint } from './checkpoint-migrations';
import { parseJsonOrThrow, toErrorMessage } from '../../shared/error-message';

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
    const value = parseJsonOrThrow<{
      schemaVersion?: unknown;
      seq?: unknown;
      sessions?: unknown;
    }>(raw, 'checkpoint file');
    if (typeof value.schemaVersion !== 'number' || typeof value.seq !== 'number') {
      console.warn(`[checkpoint-io] checkpoint has unexpected top-level shape (missing/invalid schemaVersion or seq); dropping checkpoint`);
      return null;
    }
    const fileVersion = value.schemaVersion;

    // Resolve the raw checkpoint value to the current schema version.
    //  - Equal version: no migration, v1 path is byte-identical to pre-fix behavior.
    //  - Older version: walk the migration registry up to RUN_ANALYTICS_SCHEMA_VERSION.
    //  - Newer version: this code is older than the file — refuse loudly.
    let resolved: typeof value;
    if (fileVersion === RUN_ANALYTICS_SCHEMA_VERSION) {
      resolved = value;
    } else if (fileVersion < RUN_ANALYTICS_SCHEMA_VERSION) {
      const migrated = migrateCheckpoint(value, fileVersion, RUN_ANALYTICS_SCHEMA_VERSION);
      if (migrated === MIGRATION_FAILED) {
        console.warn(
          `[pie] checkpoint migration failed: cannot migrate schema version ${fileVersion} to ${RUN_ANALYTICS_SCHEMA_VERSION} (missing migration step or up threw); dropping checkpoint`,
        );
        return null;
      }
      resolved = migrated as typeof value;
    } else {
      console.warn(
        `[pie] checkpoint from newer schema version ${fileVersion} (this build understands up to ${RUN_ANALYTICS_SCHEMA_VERSION}); dropping (upgrade pi to read it)`,
      );
      return null;
    }

    if (!isObjectRecord(resolved.sessions)) {
      console.warn(`[checkpoint-io] checkpoint.sessions has unexpected shape; dropping checkpoint`);
      return null;
    }

    const sessions: Record<string, PersistedSessionRunState> = {};
    let invalidSessions = 0;
    for (const [sessionPath, sessionState] of Object.entries(resolved.sessions)) {
      const parsed = parsePersistedSessionRunState(sessionState);
      if (!parsed) {
        invalidSessions += 1;
        continue;
      }
      sessions[sessionPath] = parsed;
    }

    if (invalidSessions > 0) {
      console.warn(`[checkpoint-io] dropped ${invalidSessions} invalid session entries from checkpoint`);
    }

    return {
      schemaVersion: RUN_ANALYTICS_SCHEMA_VERSION,
      seq: value.seq,
      sessions,
    };
  } catch (err) {
    // Log parse / migration exceptions so corruption is observable (missing files are
    // expected to be handled by callers via readOptionalText returning null).
    // Prefer the audit logger if available; fall back to console.warn.
console.warn(`[checkpoint-io] failed to parse checkpoint: ${toErrorMessage(err)}`);
    return null;
  }
}

export { readOptionalText };