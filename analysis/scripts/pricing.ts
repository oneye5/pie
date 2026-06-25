/**
 * Token-pricing loader for the analysis package.
 *
 * Mirrors the pricing semantics in `extension/src/backend/pricing.ts` (which is
 * itself a thin duplicate of `extensions/subagent/pricing.ts`). Keep the three
 * copies synchronized.
 *
 * ## Units
 * - All rates are **USD per 1,000,000 tokens**.
 * - `0` = genuinely free / local / included.
 * - Missing `cost` block = unknown pricing (cost falls back to `null`).
 *
 * `models.json` is read from the repo root by default (`../../models.json`
 * relative to this module). Override with the `PIE_MODELS_JSON` env var or the
 * explicit `modelsJsonPath` argument (used by tests).
 */
import { loadModelsJsonProviders } from './load-models.ts';

// Re-exported so existing imports of `resolveModelsJsonPath` from `./pricing.ts`
// (e.g. tests) keep working now that it lives in `./load-models.ts`.
export { resolveModelsJsonPath } from './load-models.ts';

const TOKENS_PER_MILLION = 1_000_000;

export interface ModelTokenPricing {
  /** USD per 1M input tokens. */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
  /** USD per 1M cache-read tokens. */
  cacheRead: number;
  /** USD per 1M cache-write tokens. */
  cacheWrite: number;
}

export interface TokenUsageForCost {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

function maybeValidNumber(value: unknown): number | undefined {
  if (value === undefined) {
    return 0;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return value;
}

/** Parse and validate a raw `cost` object from `models.json`. `undefined` if invalid. */
export function parseModelPricing(raw: unknown): ModelTokenPricing | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  const input = maybeValidNumber(obj.input);
  const output = maybeValidNumber(obj.output);
  const cacheRead = maybeValidNumber(obj.cacheRead);
  const cacheWrite = maybeValidNumber(obj.cacheWrite);
  if (input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined) {
    return undefined;
  }
  return { input, output, cacheRead, cacheWrite };
}

function addRecord(map: Map<string, ModelTokenPricing>, id: string, model: Record<string, unknown>): void {
  if (!id) {
    return;
  }
  if (map.has(id)) {
    return; // first provider wins; later duplicates ignored
  }
  const pricing = parseModelPricing(model.cost);
  if (pricing) {
    map.set(id, pricing);
  }
}

/**
 * Load a model-id → pricing map from `models.json`.
 *
 * Returns an empty map (never throws) if the file is missing or malformed, so
 * that cost derivation degrades gracefully to `null` rather than breaking the
 * analytics pipeline.
 */
export function loadModelPricingMap(modelsJsonPath?: string): Map<string, ModelTokenPricing> {
  const map = new Map<string, ModelTokenPricing>();
  const providers = loadModelsJsonProviders(modelsJsonPath);
  if (!providers) {
    return map;
  }

  for (const providerData of Object.values(providers)) {
    if (!providerData || typeof providerData !== 'object') {
      continue;
    }
    const provider = providerData as Record<string, unknown>;

    const models = provider.models;
    if (Array.isArray(models)) {
      for (const model of models) {
        if (!model || typeof model !== 'object') {
          continue;
        }
        const m = model as Record<string, unknown>;
        if (typeof m.id !== 'string') {
          continue;
        }
        addRecord(map, m.id, m);
      }
    }

    const modelOverrides = provider.modelOverrides;
    if (modelOverrides && typeof modelOverrides === 'object' && !Array.isArray(modelOverrides)) {
      for (const [id, model] of Object.entries(modelOverrides as Record<string, unknown>)) {
        if (!model || typeof model !== 'object') {
          continue;
        }
        addRecord(map, id, model as Record<string, unknown>);
      }
    }
  }

  return map;
}

/** Compute USD cost for a token usage given a pricing record. */
export function computeTokenCostUsd(usage: TokenUsageForCost, pricing: ModelTokenPricing): number {
  const cost =
    (usage.inputTokens / TOKENS_PER_MILLION) * pricing.input +
    (usage.outputTokens / TOKENS_PER_MILLION) * pricing.output +
    (usage.cacheReadTokens / TOKENS_PER_MILLION) * pricing.cacheRead +
    (usage.cacheWriteTokens / TOKENS_PER_MILLION) * pricing.cacheWrite;
  return Math.round(cost * 1_000_000) / 1_000_000; // round to 1 micro-dollar
}

/**
 * Estimate the USD cost of a run. Returns `null` when pricing is unknown for the
 * model (e.g. a local/free model with no `cost` block, or an unrecognized id).
 */
export function estimateRunCostUsd(
  modelId: string | null | undefined,
  usage: TokenUsageForCost,
  pricingMap: Map<string, ModelTokenPricing>,
): number | null {
  if (!modelId) {
    return null;
  }
  const pricing = pricingMap.get(modelId);
  if (!pricing) {
    return null;
  }
  const cost = computeTokenCostUsd(usage, pricing);
  // A zero cost is meaningful (free/local model) — keep 0, only null when unknown.
  return cost;
}
