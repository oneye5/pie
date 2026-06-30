/**
 * Bucket-based model selector (v2).
 *
 * The main agent provides a bucket hint ("small" / "medium" / "frontier") per
 * task and an optional thinkingLevel hint. The selector picks uniformly at
 * random from the *user-configured* bucket model lists (mirrored into the
 * process environment by the pie host as `PIE_SUBAGENT_BUCKETS_JSON`), filtered
 * by thinking support, provider allowlist, and exclusions.
 *
 * Bucket contents are user-configured in the pie settings UI (see
 * `subagentBuckets` in `ChatPrefs`) and persisted via `globalState` /
 * mirrored via the `runtimePrefs.set` RPC → `PIE_SUBAGENT_BUCKETS_JSON` env
 * var. When a bucket is empty, the selector falls back to the caller's active
 * model. Provider toggle logic is preserved from the old model-selection.ts.
 */

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { parseJsonOrThrow } from "../../shared/error-message.js";

// --- Types ---

/** Thinking effort levels, lightest → heaviest. */
export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh";

/** Simplified model config entry (from model-profiles.yaml). */
export interface SimpleModelConfig {
  id: string;
  eligible: boolean;
  thinking: ThinkingLevel[];
  disabled_reason: string | null;
  cost: number;
}

/** Per-bucket lists of model ids, user-configured via the settings UI. */
export interface BucketAssignments {
  small: string[];
  medium: string[];
  frontier: string[];
}

export interface BucketSelection {
  modelId: string;
  thinkingLevel?: ThinkingLevel;
  bucket: string;
  pool: string[];
  fallback: boolean;
}

export interface ModelProviderRef {
  id: string;
  provider: string;
}

// --- Constants ---

export const PROVIDER_TOGGLES_ENV = "PIE_PROVIDER_TOGGLES_JSON";

/** Environment key used by the pie host to mirror the user-configured subagent buckets. */
export const SUBAGENT_BUCKETS_ENV = "PIE_SUBAGENT_BUCKETS_JSON";

/** The three valid bucket keys, in display order. */
const BUCKET_KEYS = ["small", "medium", "frontier"] as const;
type BucketKey = (typeof BUCKET_KEYS)[number];

/** Thinking levels ordered from lightest to heaviest. */
const THINKING_ORDER: ThinkingLevel[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

// --- YAML loading (same lazy-resolve pattern as old model-selection.ts) ---

let _yamlParse: ((raw: string) => unknown) | null | undefined;
function getYamlParse(): ((raw: string) => unknown) | undefined {
  if (_yamlParse !== undefined) return _yamlParse ?? undefined;

  const baseRequire = createRequire(import.meta.url);
  const candidates = [baseRequire];
  try {
    candidates.push(
      createRequire(
        new URL("../../extension/package.json", import.meta.url),
      ),
    );
  } catch {
    // extension package not available in this environment
  }
  try {
    candidates.push(
      createRequire(
        baseRequire.resolve("@mariozechner/pi-coding-agent/package.json"),
      ),
    );
  } catch {
    try {
      candidates.push(
        createRequire(baseRequire.resolve("@mariozechner/pi-coding-agent")),
      );
    } catch {
      // pi SDK not resolvable from this environment
    }
  }

  for (const req of candidates) {
    try {
      const yaml = req("yaml") as { parse: (raw: string) => unknown };
      _yamlParse = yaml.parse.bind(yaml);
      return _yamlParse;
    } catch {
      // try next candidate
    }
  }

  _yamlParse = null;
  return undefined;
}

// --- Config loading ---

/**
 * Load the simple model config from model-profiles.yaml.
 * Falls back to model-profiles.json for backward compatibility.
 */
export function loadModelConfig(configPath: string): SimpleModelConfig[] {
  const yamlPath = configPath.replace(/\.json$/, ".yaml");
  const parseYaml = getYamlParse();
  if (parseYaml && existsSync(yamlPath)) {
    const raw = readFileSync(yamlPath, "utf-8");
    const parsed = parseYaml(raw) as { profiles?: SimpleModelConfig[] };
    return parsed.profiles ?? [];
  }
  const raw = readFileSync(configPath, "utf-8");
  const parsed = parseJsonOrThrow<{ profiles?: SimpleModelConfig[] }>(raw, "model profiles");
  return parsed.profiles ?? [];
}

// --- User-configured buckets (mirrored via PIE_SUBAGENT_BUCKETS_JSON) ---

/** Fresh empty buckets (new array references each call — `parseBucketConfig`
 *  mutates the arrays it returns, so never share a module-level constant). */
function emptyBuckets(): BucketAssignments {
  return { small: [], medium: [], frontier: [] };
}

/**
 * Parse the user-configured bucket JSON (from {@link SUBAGENT_BUCKETS_ENV}).
 *
 * Accepts `{ small: string[], medium: string[], frontier: string[] }` — extra
 * keys are ignored and missing keys default to empty. Non-array values and
 * non-string / empty entries are dropped; duplicate model ids within a bucket
 * are de-duplicated (a model may legitimately appear in more than one bucket).
 *
 * Returns empty assignments for undefined / malformed input so the caller
 * falls back to the active model. Never throws.
 */
export function parseBucketConfig(raw: string | undefined): BucketAssignments {
  if (!raw) return emptyBuckets();
  let parsed: unknown;
  try {
    parsed = parseJsonOrThrow<unknown>(raw, "subagent buckets");
  } catch {
    return emptyBuckets();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return emptyBuckets();
  }

  const obj = parsed as Record<string, unknown>;
  const out: BucketAssignments = emptyBuckets();
  for (const key of BUCKET_KEYS) {
    const value = obj[key];
    if (!Array.isArray(value)) continue;
    const seen = new Set<string>();
    for (const entry of value) {
      if (typeof entry === "string" && entry.length > 0 && !seen.has(entry)) {
        seen.add(entry);
        out[key].push(entry);
      }
    }
  }
  return out;
}

/**
 * Read + parse the user-configured buckets from the process environment.
 *
 * The pie host mirrors `ChatPrefs.subagentBuckets` into
 * `PIE_SUBAGENT_BUCKETS_JSON` via the `runtimePrefs.set` RPC on startup and on
 * every change. Returns empty assignments when the env var is unset (e.g. when
 * running under stock pi without the pie host), causing `selectModel` to fall
 * back to the caller's active model.
 */
export function readBucketAssignments(): BucketAssignments {
  return parseBucketConfig(process.env[SUBAGENT_BUCKETS_ENV]);
}

// --- Provider toggles (preserved from old model-selection.ts) ---

export function parseProviderToggles(
  raw: string | undefined,
): Record<string, boolean> {
  if (!raw) return {};

  try {
    const parsed = parseJsonOrThrow<unknown>(raw, "provider toggles");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return {};

    const toggles: Record<string, boolean> = {};
    for (const [provider, enabled] of Object.entries(parsed)) {
      if (typeof enabled === "boolean") toggles[provider] = enabled;
    }
    return toggles;
  } catch {
    return {};
  }
}

export function getDisabledProviders(
  providerToggles: Record<string, boolean>,
): Set<string> {
  return new Set(
    Object.entries(providerToggles)
      .filter(([, enabled]) => enabled === false)
      .map(([provider]) => provider),
  );
}

export function getAllowedModelIdsForProviders(
  models: ModelProviderRef[],
  disabledProviders: Set<string>,
): Set<string> | undefined {
  if (disabledProviders.size === 0) return undefined;

  return new Set(
    models
      .filter((model) => !disabledProviders.has(model.provider))
      .map((model) => model.id),
  );
}

// --- Thinking level helpers ---

/**
 * Find the nearest supported thinking level for a model.
 * If the requested level is unsupported, walks toward "medium" (the center)
 * and returns the closest supported level. If no levels are supported,
 * returns undefined.
 */
export function nearestSupportedThinking(
  requested: ThinkingLevel,
  supported: ThinkingLevel[],
): ThinkingLevel | undefined {
  if (supported.length === 0) return undefined;
  if (supported.includes(requested)) return requested;

  const reqIndex = THINKING_ORDER.indexOf(requested);
  // Walk outward from the requested level
  for (let offset = 1; offset < THINKING_ORDER.length; offset++) {
    const lower = THINKING_ORDER[reqIndex - offset];
    const higher = THINKING_ORDER[reqIndex + offset];
    if (lower && supported.includes(lower)) return lower;
    if (higher && supported.includes(higher)) return higher;
  }
  return undefined;
}

// --- Selection ---

/**
 * Select a model from the user-configured bucket assignments.
 *
 * 1. Get bucket assignments (user-configured via the settings UI, mirrored
 *    through `PIE_SUBAGENT_BUCKETS_JSON`)
 * 2. Filter by thinkingLevel support (if provided)
 * 3. Filter by provider allowlist + excludeModels
 * 4. Pick uniformly at random from remaining entries
 * 5. Fall back to active model if bucket is empty
 *
 * @param bucket - Bucket hint: "small", "medium", or "frontier"
 * @param thinkingLevel - Optional thinking level hint
 * @param assignments - User-configured bucket assignments (from env)
 * @param modelConfig - Simple model config for thinking support lookup
 * @param allowedModelIds - Models allowed by provider toggles
 * @param excludeModels - Models to exclude (e.g., previously failed)
 * @param activeModelId - The caller's active model (fallback)
 */
export function selectModel(
  bucket: string,
  thinkingLevel: ThinkingLevel | undefined,
  assignments: BucketAssignments,
  modelConfig: SimpleModelConfig[],
  allowedModelIds: Set<string> | undefined,
  excludeModels: Set<string> | undefined,
  activeModelId: string,
): BucketSelection {
  const bucketKey = bucket as keyof BucketAssignments;
  let pool = assignments[bucketKey] ?? [];

  // Build thinking support lookup from model config
  const thinkingSupport = new Map<string, ThinkingLevel[]>();
  for (const cfg of modelConfig) {
    thinkingSupport.set(cfg.id, cfg.thinking);
  }

  // Filter by thinkingLevel if provided
  if (thinkingLevel && pool.length > 0) {
    const thinkingFiltered = pool.filter((id) => {
      const supported = thinkingSupport.get(id);
      // Models not in config are treated as supporting all levels
      if (!supported) return true;
      return supported.includes(thinkingLevel);
    });

    if (thinkingFiltered.length === 0) {
      // Relax to nearest supported thinking level
      const allSupported = new Set<ThinkingLevel>();
      for (const id of pool) {
        const supported = thinkingSupport.get(id);
        if (supported) for (const l of supported) allSupported.add(l);
      }
      const relaxed = nearestSupportedThinking(thinkingLevel, [...allSupported]);
      if (relaxed) {
        thinkingLevel = relaxed;
        // Re-filter with relaxed level
        const relaxedPool = pool.filter((id) => {
          const supported = thinkingSupport.get(id);
          if (!supported) return true;
          return supported.includes(relaxed);
        });
        if (relaxedPool.length > 0) {
          pool = relaxedPool;
        }
      }
    } else {
      pool = thinkingFiltered;
    }
  }

  // Filter by provider allowlist
  if (allowedModelIds && pool.length > 0) {
    pool = pool.filter((id) => allowedModelIds.has(id));
  }

  // Filter by excludeModels
  if (excludeModels && pool.length > 0) {
    pool = pool.filter((id) => !excludeModels.has(id));
  }

  // If pool is empty, fall back to active model
  if (pool.length === 0) {
    // If the active model itself has been excluded, return empty to signal exhaustion.
    const fallbackId = activeModelId && !excludeModels?.has(activeModelId) ? activeModelId : "";
    return {
      modelId: fallbackId,
      thinkingLevel,
      bucket,
      pool: [],
      fallback: true,
    };
  }

  // Pick uniformly at random
  const pick = Math.floor(Math.random() * pool.length);

  return {
    modelId: pool[pick],
    thinkingLevel,
    bucket,
    pool,
    fallback: false,
  };
}
