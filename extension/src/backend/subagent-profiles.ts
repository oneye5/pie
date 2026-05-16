import * as fs from 'node:fs';
import * as path from 'node:path';

import type { ModelSubagentInfo } from '../shared/protocol';

/**
 * Raw profile shape as stored in `<agentDir>/model-profiles.json`.
 * The subagent extension owns the authoritative type; we only consume fields needed
 * for picker ordering, so this is intentionally minimal and tolerant.
 */
interface RawSubagentProfile {
  id?: unknown;
  precision?: unknown;
  creativity?: unknown;
  thoroughness?: unknown;
  reasoning?: unknown;
  eligible?: unknown;
  _disabled_reason?: unknown;
}

interface RawSubagentConfig {
  profiles?: unknown;
}

interface CacheEntry {
  mtimeMs: number;
  map: Map<string, ModelSubagentInfo>;
}

const cache = new Map<string, CacheEntry>();

function toNumber(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function parseProfiles(raw: string): Map<string, ModelSubagentInfo> {
  const out = new Map<string, ModelSubagentInfo>();
  let parsed: RawSubagentConfig;
  try {
    parsed = JSON.parse(raw) as RawSubagentConfig;
  } catch {
    return out;
  }
  const profiles = Array.isArray(parsed.profiles) ? parsed.profiles : [];
  for (const entry of profiles as RawSubagentProfile[]) {
    if (!entry || typeof entry.id !== 'string' || entry.id.length === 0) continue;
    const aggregate =
      toNumber(entry.precision) +
      toNumber(entry.creativity) +
      toNumber(entry.thoroughness) +
      toNumber(entry.reasoning);
    const info: ModelSubagentInfo = {
      eligible: entry.eligible === true,
      aggregate,
    };
    if (typeof entry._disabled_reason === 'string' && entry._disabled_reason.length > 0) {
      info.disabledReason = entry._disabled_reason;
    }
    out.set(entry.id, info);
  }
  return out;
}

/**
 * Load subagent profiles for the picker, keyed by model id. Returns an empty map
 * when the shared `<agentDir>/model-profiles.json` is missing or unreadable so the
 * picker still renders (and the subagent extension falls back to inheriting the
 * caller's model). Cached by mtime to avoid re-parsing on every `models.list` request.
 */
export function loadSubagentProfiles(agentDir: string): Map<string, ModelSubagentInfo> {
  if (!agentDir) return new Map();
  const filePath = path.join(agentDir, 'model-profiles.json');
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    cache.delete(filePath);
    return new Map();
  }
  const cached = cache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.map;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const map = parseProfiles(raw);
    cache.set(filePath, { mtimeMs: stat.mtimeMs, map });
    return map;
  } catch {
    return new Map();
  }
}

/** Test hook: drop the in-memory cache. */
export function _clearSubagentProfilesCache(): void {
  cache.clear();
}
