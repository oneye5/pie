import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { SourceAnalyticsPayload } from '../scripts/contracts.ts';
import { DEFAULT_FIXTURE_PATH, readSourceAnalyticsPayload } from '../scripts/source.ts';

export async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-analysis-test-'));
  try {
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

export async function loadFixture(): Promise<SourceAnalyticsPayload> {
  return await readSourceAnalyticsPayload(DEFAULT_FIXTURE_PATH);
}

export function deepClone<TValue>(value: TValue): TValue {
  return JSON.parse(JSON.stringify(value)) as TValue;
}

export const SENTINEL_STRINGS = [
  'SENTINEL_SESSION_PATH_ALPHA',
  'SENTINEL_SESSION_PATH_BRAVO',
  'SENTINEL_CONTEXT_FILE_ALPHA',
  'SENTINEL_CONTEXT_FILE_GOLF',
];
