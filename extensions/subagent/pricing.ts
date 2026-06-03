/**
 * Model token pricing types, parser, and normalization.
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
 * Token prices are converted to the selector's legacy cost scale (0–30+) via:
 *
 *   blended = (3 × input + 1 × output) / 4
 *   normalized = 10 × √(blended / baselineUsdPer1M)
 *
 * The 3:1 input:output ratio is representative of agentic coding workloads.
 * The baseline ($6.00/1M blended) is anchored to claude-sonnet-4.6 pricing
 * ($3.00/M input, $15.00/M output), which maps to the legacy `cost=10` baseline.
 *
 * ## Fallback order
 *
 * 1. Real `models.json` pricing → normalized cost
 * 2. Legacy `model-profiles.yaml` `cost` field
 * 3. Capability aggregate (precision + creativity + thoroughness + reasoning)
 */

import { existsSync, readFileSync } from "node:fs";

// --- Types ---

/**
 * Real token pricing in USD per 1M tokens.
 *
 * - `input` and `output` are required to be non-negative and finite.
 * - `cacheRead` and `cacheWrite` default to 0 when absent or not applicable.
 */
export interface ModelTokenPricing {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/**
 * A pricing record keyed by model id, including the provider for disambiguation.
 */
export interface ModelPricingRecord {
	id: string;
	provider: string;
	pricing?: ModelTokenPricing;
}

/**
 * Cost source used by {@link resolveModelCost}.
 */
export type CostSource = "pricing" | "legacy" | "aggregate";

/**
 * Resolved cost for a model, with traceability.
 */
export interface ResolvedCost {
	/** Normalized cost on the 0–30+ selector scale. */
	normalizedCost: number;
	/** Which source provided the cost value. */
	usedSource: CostSource;
}

// --- Constants ---

/** Token ratio for agentic coding workloads: 3 input tokens per 1 output token. */
const INPUT_WEIGHT = 3;
const OUTPUT_WEIGHT = 1;

/**
 * Baseline blended USD-per-1M tokens.
 * Anchored to claude-sonnet-4.6: $3.00/M input, $15.00/M output.
 * blended = (3 × 3.00 + 1 × 15.00) / 4 = $6.00/1M
 */
const BASELINE_USD_PER_1M = 6.0;

/** Scale factor mapping the baseline to the legacy cost=10 reference. */
const NORMALIZATION_SCALE = 10;

// --- Parser ---

/**
 * Parse and validate a raw `cost` object from `models.json`.
 *
 * Returns `undefined` if:
 * - The input is not a plain object
 * - Any numeric field is negative, NaN, or non-finite
 * - The `input` or `output` subfields are not valid numbers
 *
 * Missing subfields are defaulted to 0 (genuinely free/included).
 */
export function parseModelPricing(raw: unknown): ModelTokenPricing | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;

	const obj = raw as Record<string, unknown>;

	// Missing subfields default to 0 (free/included).
	// Explicitly invalid values (negative, NaN, Infinity) cause rejection.
	const input = maybeValidNumber(obj.input);
	const output = maybeValidNumber(obj.output);
	const cacheRead = maybeValidNumber(obj.cacheRead);
	const cacheWrite = maybeValidNumber(obj.cacheWrite);

	// If any field was explicitly set to an invalid value, reject.
	if (input === undefined || output === undefined) return undefined;
	if (cacheRead === undefined || cacheWrite === undefined) return undefined;

	return { input, output, cacheRead, cacheWrite };
}

/**
 * Validate a raw value as a non-negative finite number.
 * - Returns the value if it is a valid non-negative finite number.
 * - Returns `0` if the field is absent (undefined).
 * - Returns `undefined` if the field is present but invalid (negative, NaN, Infinity, non-number).
 */
function maybeValidNumber(v: unknown): number | undefined {
	if (v === undefined) return 0;
	if (typeof v !== "number") return undefined;
	if (!Number.isFinite(v) || v < 0) return undefined;
	return v;
}

// --- Normalization ---

/**
 * Convert real token prices to the selector's 0–30+ cost penalty scale.
 *
 * Uses a representative 3:1 input:output token ratio, producing a blended
 * USD-per-1M value, then maps it to the legacy scale via a square-root
 * transform anchored at the baseline ($6.00/1M → cost=10).
 *
 * Returns 0 for free/local models. No upper clamp is applied.
 */
export function estimateNormalizedCost(pricing: ModelTokenPricing): number {
	const blended = (INPUT_WEIGHT * pricing.input + OUTPUT_WEIGHT * pricing.output)
		/ (INPUT_WEIGHT + OUTPUT_WEIGHT);

	if (blended <= 0) return 0;

	return NORMALIZATION_SCALE * Math.sqrt(blended / BASELINE_USD_PER_1M);
}

// --- Cost Resolution ---

/**
 * Resolve a model's effective cost using the fallback order:
 *
 * 1. Real pricing from `models.json` (normalized via {@link estimateNormalizedCost})
 * 2. Legacy `cost` field from `model-profiles.yaml`
 * 3. Capability aggregate (sum of precision + creativity + thoroughness + reasoning)
 *
 * @param modelId - Model id to look up
 * @param pricingRecords - Map of model id → pricing records from `models.json`
 * @param legacyCost - Optional legacy cost from `model-profiles.yaml`
 * @param capabilityAggregate - Fallback aggregate (usually capability sum)
 */
export function resolveModelCost(
	modelId: string,
	pricingRecords: Map<string, ModelPricingRecord[]>,
	legacyCost?: number,
	capabilityAggregate?: number,
): ResolvedCost {
	// 1. Try real pricing
	const records = pricingRecords.get(modelId);
	if (records && records.length > 0) {
		const priced = records.find((r) => r.pricing !== undefined);
		if (priced?.pricing) {
			return {
				normalizedCost: estimateNormalizedCost(priced.pricing),
				usedSource: "pricing",
			};
		}
	}

	// 2. Try legacy profile cost
	if (legacyCost !== undefined && Number.isFinite(legacyCost)) {
		return {
			normalizedCost: Math.max(0, legacyCost),
			usedSource: "legacy",
		};
	}

	// 3. Fall back to capability aggregate
	const aggregate = capabilityAggregate ?? 0;
	return {
		normalizedCost: Math.max(0, aggregate),
		usedSource: "aggregate",
	};
}

// --- Loader ---

/**
 * Load pricing records from `models.json`.
 *
 * Returns a Map keyed by model id, with values being arrays of
 * {@link ModelPricingRecord} (one per provider the model appears under).
 * Returns an empty Map when the file is missing or unreadable.
 *
 * Models with missing, invalid, or negative pricing are silently skipped.
 */
export function loadModelPricing(modelsJsonPath: string): Map<string, ModelPricingRecord[]> {
	const map = new Map<string, ModelPricingRecord[]>();

	let raw: string;
	try {
		raw = readFileSync(modelsJsonPath, "utf-8");
	} catch {
		return map;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return map;
	}

	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return map;

	const cfg = parsed as Record<string, unknown>;
	const providers = cfg.providers;
	if (!providers || typeof providers !== "object" || Array.isArray(providers)) return map;

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
		if (!providerData || typeof providerData !== "object") continue;
		const provider = providerData as Record<string, unknown>;

		const models = provider.models;
		if (Array.isArray(models)) {
			for (const model of models) {
				if (!model || typeof model !== "object") continue;
				const m = model as Record<string, unknown>;
				if (typeof m.id !== "string") continue;
				addRecord(providerName, m.id, m);
			}
		}

		const modelOverrides = provider.modelOverrides;
		if (modelOverrides && typeof modelOverrides === "object" && !Array.isArray(modelOverrides)) {
			for (const [id, model] of Object.entries(modelOverrides as Record<string, unknown>)) {
				if (!model || typeof model !== "object") continue;
				addRecord(providerName, id, model as Record<string, unknown>);
			}
		}
	}

	return map;
}
