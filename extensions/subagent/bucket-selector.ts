/**
 * Bucket-based model selector (v2).
 *
 * Replaces the old fitness-based model-selection.ts. The main agent provides
 * a bucket hint ("small" / "medium" / "frontier") per task and an optional
 * thinkingLevel hint. The selector picks uniformly at random from the
 * stratified leaderboard's bucket assignments, filtered by thinking support,
 * provider allowlist, and exclusions.
 *
 * Provider toggle logic is preserved from the old model-selection.ts.
 */

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type {
  BucketAssignments,
  SimpleModelConfig,
  ThinkingLevel,
} from "./bridge.js";

// Re-export ThinkingLevel for consumers (agent frontmatter parsing, etc.).
export type { ThinkingLevel };

// --- Types ---

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
  const parsed = JSON.parse(raw) as { profiles?: SimpleModelConfig[] };
  return parsed.profiles ?? [];
}

// --- Provider toggles (preserved from old model-selection.ts) ---

export function parseProviderToggles(
  raw: string | undefined,
): Record<string, boolean> {
  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw) as unknown;
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
 * Select a model from the stratified leaderboard's bucket assignments.
 *
 * 1. Get bucket assignments from the bridge (stratified ranker)
 * 2. Filter by thinkingLevel support (if provided)
 * 3. Filter by provider allowlist + excludeModels
 * 4. Pick uniformly at random from remaining entries
 * 5. Fall back to active model if bucket is empty
 *
 * @param bucket - Bucket hint: "small", "medium", or "frontier"
 * @param thinkingLevel - Optional thinking level hint
 * @param assignments - Pre-computed bucket assignments (from bridge)
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
