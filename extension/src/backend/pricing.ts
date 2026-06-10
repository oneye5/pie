/**
 * Minimal pricing parser / normalizer for the VS Code extension backend.
 *
 * This is a thin duplicate of the equivalent module in `extensions/subagent/pricing.ts`
 * to avoid cross-package import complexity. Keep constants and logic synchronized.
 *
 * ## Units & semantics
 *
 * - All costs are in **USD per 1M tokens**.
 * - `0` = genuinely free, local, or included.
 * - Missing `cost` field = unknown pricing (triggers fallback).
 * - Negative or non-finite prices are rejected.
 *
 * ## Normalization
 *
 *   blended = (3 × input + 1 × output) / 4
 *   normalized = 10 × √(blended / 6.00)
 *
 * Basline ($6.00/1M blended) anchored to claude-sonnet-4.6.
 */

/** Token ratio for agentic coding workloads: 3 input tokens per 1 output token. */
const INPUT_WEIGHT = 3;
const OUTPUT_WEIGHT = 1;

/** Baseline blended USD-per-1M tokens (claude-sonnet-4.6: $3.00/M input, $15.00/M output). */
const BASELINE_USD_PER_1M = 6.0;

/** Scale factor mapping the baseline to the legacy cost=10 reference. */
const NORMALIZATION_SCALE = 10;

export interface ModelTokenPricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ModelPricingRecord {
  id: string;
  provider: string;
  pricing?: ModelTokenPricing;
}

/**
 * Parse and validate a raw `cost` object from `models.json`.
 *
 * Returns `undefined` if invalid. Missing subfields default to 0.
 */
export function parseModelPricing(raw: unknown): ModelTokenPricing | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;

  const obj = raw as Record<string, unknown>;

  const input = maybeValidNumber(obj.input);
  const output = maybeValidNumber(obj.output);
  const cacheRead = maybeValidNumber(obj.cacheRead);
  const cacheWrite = maybeValidNumber(obj.cacheWrite);

  if (input === undefined || output === undefined) return undefined;
  if (cacheRead === undefined || cacheWrite === undefined) return undefined;

  return { input, output, cacheRead, cacheWrite };
}

function maybeValidNumber(v: unknown): number | undefined {
  if (v === undefined) return 0;
  if (typeof v !== 'number') return undefined;
  if (!Number.isFinite(v) || v < 0) return undefined;
  return v;
}

/**
 * Convert real token prices to the selector's 0–30+ cost penalty scale.
 */
export function estimateNormalizedCost(pricing: ModelTokenPricing): number {
  const blended = (INPUT_WEIGHT * pricing.input + OUTPUT_WEIGHT * pricing.output)
    / (INPUT_WEIGHT + OUTPUT_WEIGHT);

  if (blended <= 0) return 0;

  return NORMALIZATION_SCALE * Math.sqrt(blended / BASELINE_USD_PER_1M);
}

/**
 * Load pricing records from `models.json`.
 */
export function loadModelPricing(modelsJsonPath: string): Map<string, ModelPricingRecord[]> {
  const map = new Map<string, ModelPricingRecord[]>();

  let raw: string;
  try {
    raw = require('node:fs').readFileSync(modelsJsonPath, 'utf-8');
  } catch {
    return map;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return map;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return map;

  const cfg = parsed as Record<string, unknown>;
  const providers = cfg.providers;
  if (!providers || typeof providers !== 'object' || Array.isArray(providers)) return map;

  const addRecord = (provider: string, id: string, model: Record<string, unknown>) => {
    if (id.length === 0) return;
    const pricing = parseModelPricing(model.cost);
    if (!pricing) return;

    const record: ModelPricingRecord = { id, provider, pricing };
    const existing = map.get(id);
    if (existing) {
      existing.push(record);
    } else {
      map.set(id, [record]);
    }
  };

  for (const [providerName, providerData] of Object.entries(providers as Record<string, unknown>)) {
    if (!providerData || typeof providerData !== 'object') continue;
    const provider = providerData as Record<string, unknown>;

    const models = provider.models;
    if (Array.isArray(models)) {
      for (const model of models) {
        if (!model || typeof model !== 'object') continue;
        const m = model as Record<string, unknown>;
        if (typeof m.id !== 'string') continue;
        addRecord(providerName, m.id, m);
      }
    }

    const modelOverrides = provider.modelOverrides;
    if (modelOverrides && typeof modelOverrides === 'object' && !Array.isArray(modelOverrides)) {
      for (const [id, model] of Object.entries(modelOverrides as Record<string, unknown>)) {
        if (!model || typeof model !== 'object') continue;
        addRecord(providerName, id, model as Record<string, unknown>);
      }
    }
  }

  return map;
}


