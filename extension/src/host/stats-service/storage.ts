import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { serializeJsonLine } from '../../shared/jsonl';
import { toErrorMessage, parseJsonOrThrow } from '../../shared/error-message';
import { parseCheckpoint, readOptionalText } from '../shared/checkpoint-io';
import { workspaceHash } from './helpers';
import {
  readCheckpointFromDisk,
  writeCheckpointToDisk,
  type CheckpointSlot,
} from './persistence';
import {
  exportRunAnalyticsStore,
  queryRunAnalyticsStore,
  type RunAnalyticsExportPayload,
  type RunAnalyticsQueryResult,
} from '../run-analytics/query';
import {
  RUN_ANALYTICS_SCHEMA_VERSION,
  type OutcomeHistoryLogEntry,
  type PersistedSessionRunState,
  type RunCheckpoint,
  type RunSnapshot,
  type RunSnapshotLogEntry,
} from '../run-analytics';

interface RunAnalyticsStorageOptions {
  dataOutcomesRootPath: string;
  legacyUsageDataRootPath?: string;
  workspaceId: string;
  legacyWorkspaceIds?: string[];
  now: () => Date;
  serializeSessions: () => Record<string, PersistedSessionRunState>;
}

export class RunAnalyticsStorage {
  private readonly storageDir: string;
  private readonly legacyStorageDirs: string[];
  private readonly autoExportPath: string;
  private readonly now: () => Date;
  private readonly serializeSessions: () => Record<string, PersistedSessionRunState>;

  private persistenceQueue: Promise<void> = Promise.resolve();
  private seq = 0;
  private activeSlot: CheckpointSlot = 'a';
  private lastPersistError: { message: string; at: string } | null = null;

  constructor(options: RunAnalyticsStorageOptions) {
    const workspaceIds = [...new Set([options.workspaceId, ...(options.legacyWorkspaceIds ?? [])])];
    const workspaceStorageHashes = workspaceIds.map((workspaceId) => workspaceHash(workspaceId));
    const primaryWorkspaceHash = workspaceStorageHashes[0]!;
    this.storageDir = path.join(
      options.dataOutcomesRootPath,
      primaryWorkspaceHash,
    );

    const legacyRoots = [
      options.legacyUsageDataRootPath
        ? path.join(options.legacyUsageDataRootPath, 'runs')
        : null,
      options.legacyUsageDataRootPath
        ? path.join(options.legacyUsageDataRootPath, 'usage-data')
        : null,
      options.legacyUsageDataRootPath
        ? path.join(options.legacyUsageDataRootPath, 'data', 'outcomes')
        : null,
      path.join(options.dataOutcomesRootPath, 'runs'),
      path.join(options.dataOutcomesRootPath, 'usage-data'),
      options.dataOutcomesRootPath,
    ].filter((rootPath): rootPath is string => !!rootPath);

    this.legacyStorageDirs = legacyRoots
      .flatMap((rootPath) => workspaceStorageHashes.map((workspaceHashValue) => (
        path.join(rootPath, workspaceHashValue)
      )))
      .filter((candidate, index, candidates) => (
        candidate !== this.storageDir && candidates.indexOf(candidate) === index
      ));
    this.autoExportPath = path.join(this.storageDir, 'run-analytics.json');
    this.now = options.now;
    this.serializeSessions = options.serializeSessions;
  }

  async start(): Promise<RunCheckpoint | null> {
    await this.migrateLegacyStorage();
    await fs.mkdir(this.storageDir, { recursive: true });
    const checkpoint = await this.readCheckpoint();
    this.seq = checkpoint?.seq ?? 0;
    await this.writeAutoExportSafely();
    return checkpoint;
  }

  schedulePersist(snapshotToAppend?: RunSnapshot, outcomeToAppend?: OutcomeHistoryLogEntry): void {
    const checkpoint = this.buildCheckpoint(++this.seq);
    this.persistenceQueue = this.persistenceQueue
      .catch((error) => {
        const message = toErrorMessage(error);
        const at = this.isoNow();
        this.lastPersistError = { message, at };
        console.warn(`[pie] run-analytics persist failed at ${at}: ${message}`);
      })
      .then(async () => {
        await fs.mkdir(this.storageDir, { recursive: true });
        if (snapshotToAppend) {
          await fs.appendFile(
            path.join(this.storageDir, 'run-snapshots.jsonl'),
            serializeJsonLine({
              schemaVersion: RUN_ANALYTICS_SCHEMA_VERSION,
              kind: 'run_snapshot',
              recordedAt: this.isoNow(),
              run: snapshotToAppend,
            } satisfies RunSnapshotLogEntry),
            'utf8',
          );
        }
        if (outcomeToAppend) {
          await fs.appendFile(
            path.join(this.storageDir, 'outcome-history.jsonl'),
            serializeJsonLine(outcomeToAppend),
            'utf8',
          );
        }
        await this.writeCheckpoint(checkpoint);
        await this.writeAutoExportSafely();
        this.lastPersistError = null;
      });
  }

  /** The most recent persistence failure, or null if the last persist succeeded. */
  getPersistError(): { message: string; at: string } | null {
    return this.lastPersistError;
  }

  async flush(): Promise<void> {
    await this.persistenceQueue.catch(() => undefined);
  }

  async queryRunAnalytics(): Promise<RunAnalyticsQueryResult> {
    await this.flush();
    return await queryRunAnalyticsStore(this.storageDir);
  }

  async exportRunAnalytics(targetPath: string): Promise<RunAnalyticsExportPayload> {
    await this.flush();
    return await exportRunAnalyticsStore(this.storageDir, targetPath, this.now);
  }

  private buildCheckpoint(seq: number): RunCheckpoint {
    return {
      schemaVersion: RUN_ANALYTICS_SCHEMA_VERSION,
      seq,
      sessions: this.serializeSessions(),
    };
  }

  private async readCheckpoint(): Promise<RunCheckpoint | null> {
    const { checkpoint, activeSlot } = await readCheckpointFromDisk(this.storageDir, parseCheckpoint);
    this.activeSlot = activeSlot;
    return checkpoint;
  }

  private async writeCheckpoint(checkpoint: RunCheckpoint): Promise<void> {
    this.activeSlot = await writeCheckpointToDisk(this.storageDir, this.activeSlot, checkpoint);
  }

  private async migrateLegacyStorage(): Promise<void> {
    await fs.mkdir(this.storageDir, { recursive: true });

    const existingLegacyStorageDirs: string[] = [];
    for (const legacyStorageDir of this.legacyStorageDirs) {
      try {
        await fs.cp(legacyStorageDir, this.storageDir, {
          recursive: true,
          force: false,
          errorOnExist: false,
        });
        existingLegacyStorageDirs.push(legacyStorageDir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
    }

    if (existingLegacyStorageDirs.length === 0) {
      return;
    }

    await this.mergeJsonlLogFiles(existingLegacyStorageDirs, 'run-snapshots.jsonl');
    await this.mergeJsonlLogFiles(existingLegacyStorageDirs, 'outcome-history.jsonl');
    await this.mergeCheckpointStates(existingLegacyStorageDirs);
  }

  private async mergeJsonlLogFiles(legacyStorageDirs: string[], fileName: string): Promise<void> {
    const targetPath = path.join(this.storageDir, fileName);
    const [currentRaw, ...legacyRaws] = await Promise.all([
      readOptionalText(targetPath),
      ...legacyStorageDirs.map((legacyStorageDir) => readOptionalText(path.join(legacyStorageDir, fileName))),
    ]);
    const existingLegacyRaws = legacyRaws.filter((raw): raw is string => !!raw);

    if (existingLegacyRaws.length === 0) {
      return;
    }

    const mergedRaw = this.mergeJsonlContent(currentRaw, existingLegacyRaws, fileName);
    if (mergedRaw === currentRaw) {
      return;
    }

    await fs.writeFile(targetPath, mergedRaw, 'utf8');
  }

  private async mergeCheckpointStates(legacyStorageDirs: string[]): Promise<void> {
    const currentState = await readCheckpointFromDisk(this.storageDir, parseCheckpoint);
    const legacyStates = await Promise.all(
      legacyStorageDirs.map((legacyStorageDir) => readCheckpointFromDisk(legacyStorageDir, parseCheckpoint)),
    );
    const checkpoints = [
      ...legacyStates.map((state) => state.checkpoint).filter((checkpoint): checkpoint is RunCheckpoint => !!checkpoint),
      currentState.checkpoint,
    ].filter((checkpoint): checkpoint is RunCheckpoint => !!checkpoint);

    if (checkpoints.length === 0) {
      return;
    }

    const mergedSessions: Record<string, PersistedSessionRunState> = {};
    for (const checkpoint of checkpoints) {
      for (const [sessionPath, sessionState] of Object.entries(checkpoint.sessions)) {
        mergedSessions[sessionPath] = this.mergeCheckpointSessionState(
          mergedSessions[sessionPath],
          sessionState,
        );
      }
    }

    const mergedCheckpoint: RunCheckpoint = {
      schemaVersion: RUN_ANALYTICS_SCHEMA_VERSION,
      seq: Math.max(...checkpoints.map((checkpoint) => checkpoint.seq)),
      sessions: mergedSessions,
    };

    if (currentState.checkpoint && JSON.stringify(currentState.checkpoint) === JSON.stringify(mergedCheckpoint)) {
      return;
    }

    await writeCheckpointToDisk(this.storageDir, currentState.activeSlot, mergedCheckpoint);
  }

  private mergeJsonlContent(
    currentRaw: string | null,
    legacyRaws: string[],
    fileName?: string,
  ): string {
    const mergedLines = new Map<string, { line: string; recency: string; order: number }>();
    let order = 0;

    for (const raw of [...legacyRaws, currentRaw]) {
      if (!raw) {
        continue;
      }

      for (const line of raw.split(/\r?\n/)) {
        const normalizedLine = line.trim();
        if (!normalizedLine) {
          continue;
        }

        const candidate = this.getJsonlMergeCandidate(fileName, normalizedLine);
        const existing = mergedLines.get(candidate.key);
        if (!existing
          || candidate.recency > existing.recency
          || (candidate.recency === existing.recency && order >= existing.order)) {
          mergedLines.set(candidate.key, {
            line: normalizedLine,
            recency: candidate.recency,
            order,
          });
        }
        order += 1;
      }
    }

    return mergedLines.size > 0
      ? `${[...mergedLines.values()].map((entry) => entry.line).join('\n')}\n`
      : '';
  }

  private mergeCheckpointSessionState(
    existingSessionState: PersistedSessionRunState | undefined,
    incomingSessionState: PersistedSessionRunState | undefined,
  ): PersistedSessionRunState {
    if (!existingSessionState) {
      return incomingSessionState!;
    }
    if (!incomingSessionState) {
      return existingSessionState;
    }

    const existingRecency = this.getSessionStateRecencyKey(existingSessionState);
    const incomingRecency = this.getSessionStateRecencyKey(incomingSessionState);
    if (incomingRecency > existingRecency) {
      return incomingSessionState;
    }
    if (incomingRecency < existingRecency) {
      return existingSessionState;
    }
    if (incomingSessionState.currentRun && !existingSessionState.currentRun) {
      return incomingSessionState;
    }
    return incomingSessionState;
  }

  private getSessionStateRecencyKey(sessionState: PersistedSessionRunState): string {
    return sessionState.currentRun?.updatedAt
      ?? sessionState.currentRun?.startedAt
      ?? sessionState.lastRun?.updatedAt
      ?? sessionState.lastRun?.finalizedAt
      ?? sessionState.busyStartedAt
      ?? '';
  }

  private getJsonlMergeCandidate(
    fileName: string | undefined,
    normalizedLine: string,
  ): { key: string; recency: string } {
    try {
      const parsed = parseJsonOrThrow<{
        kind?: unknown;
        recordedAt?: unknown;
        runId?: unknown;
        run?: { runId?: unknown; updatedAt?: unknown; finalizedAt?: unknown };
      }>(normalizedLine, 'stats line');

      if (fileName === 'run-snapshots.jsonl'
        && parsed.kind === 'run_snapshot'
        && typeof parsed.run?.runId === 'string') {
        return {
          key: `run_snapshot:${parsed.run.runId}`,
          recency:
            typeof parsed.run.updatedAt === 'string'
              ? parsed.run.updatedAt
              : typeof parsed.run.finalizedAt === 'string'
                ? parsed.run.finalizedAt
                : typeof parsed.recordedAt === 'string'
                  ? parsed.recordedAt
                  : '',
        };
      }

      if (fileName === 'outcome-history.jsonl'
        && parsed.kind === 'run_outcome'
        && typeof parsed.runId === 'string') {
        return {
          key: `run_outcome:${parsed.runId}`,
          recency: typeof parsed.recordedAt === 'string' ? parsed.recordedAt : '',
        };
      }
    } catch {
      // Fall back to the exact line content below.
    }

    return {
      key: `line:${normalizedLine}`,
      recency: '',
    };
  }

  private async writeAutoExport(): Promise<void> {
    await exportRunAnalyticsStore(this.storageDir, this.autoExportPath, this.now);
  }

  private async writeAutoExportSafely(): Promise<void> {
    try {
      await this.writeAutoExport();
    } catch (error) {
      const message = toErrorMessage(error);
      console.warn(`[pie] Failed to refresh run analytics export at ${this.autoExportPath}: ${message}`);
    }
  }

  private isoNow(): string {
    return this.now().toISOString();
  }
}
