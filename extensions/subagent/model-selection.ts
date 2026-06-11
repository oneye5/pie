import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";

/** Lazy-resolve the `yaml` package from available local/runtime dependencies. */
let _yamlParse: ((raw: string) => unknown) | null | undefined;
function getYamlParse(): ((raw: string) => unknown) | undefined {
	if (_yamlParse !== undefined) return _yamlParse ?? undefined;

	const baseRequire = createRequire(import.meta.url);
	const candidates = [baseRequire];
	try {
		candidates.push(createRequire(new URL("../../extension/package.json", import.meta.url)));
	} catch {
		// extension package not available in this environment
	}
	try {
		candidates.push(createRequire(baseRequire.resolve("@mariozechner/pi-coding-agent/package.json")));
	} catch {
		try {
			candidates.push(createRequire(baseRequire.resolve("@mariozechner/pi-coding-agent")));
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

	_yamlParse = null; // sentinel: don't retry on subsequent calls
	return undefined;
}

export interface TaskScores {
	precision?: number;
	creativity?: number;
	thoroughness?: number;
	reasoning?: number;
}

/** Pi CLI --thinking levels, ordered from lightest to heaviest. */
export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh";

export interface ModelProfile {
	id: string;
	precision: number;
	creativity: number;
	thoroughness: number;
	reasoning: number;
	/**
	 * Explicit cost ranking (0–30+). Higher = more expensive relative to peers.
	 * Used instead of the capability-dimension aggregate when present.
	 *
	 * This is a ranking heuristic, not a dollar amount. The absolute numbers aren't
	 * grounded, but the *relative ordering* is: if model A has cost 0 and model B
	 * has cost 20, then A is effectively free while B is expensive.
	 *
	 * Omit this field to fall back to aggregate(precision, creativity, thoroughness, reasoning).
	 *
	 * Legacy field — superseded by {@link normalizedCost} when real token pricing
	 * is available. Kept as fallback for models without token pricing data.
	 */
	cost?: number;
	/**
	 * Normalized selector cost (0–30+) derived from real token pricing in models.json.
	 * Populated by the caller from pricing data before selection.
	 *
	 * When present, this replaces {@link cost} as the primary cost input to fitness.
	 * The fallback order is: normalizedCost → legacy cost → capability aggregate.
	 */
	normalizedCost?: number;
	/** Which thinking levels this model supports. Models that omit this accept all levels. */
	thinking?: ThinkingLevel[];
	eligible: boolean;
}

export interface SelectionConfig {
	topK: number;
	profiles: ModelProfile[];
}

export interface SelectionResult {
	modelId: string;
	thinkingLevel: ThinkingLevel;
	pool: string[];
	fitScores: number[];
}

export interface ModelProviderRef {
	id: string;
	provider: string;
}

// --- Constants ---

export const PROVIDER_TOGGLES_ENV = "PIE_PROVIDER_TOGGLES_JSON";

const DIMENSIONS = ["precision", "creativity", "thoroughness", "reasoning"] as const;
const DEFAULT_SCORE = 2;

/**
 * Temporary guard: minimum capability aggregate (sum of all four dimensions)
 * required for a model to be eligible for subagent selection.
 *
 * This prevents models that are too small or weak for agentic work (e.g. GPT-4o,
 * GPT-5-mini, devstral-small-2, ministral-3) from being selected even for
 * low-scored tasks.
 *
 * REMOVE THIS when the data-driven stratified leaderboard (subagent-model-selection-v2)
 * replaces the current fitness-based selector.
 */
const MIN_CAPABILITY_AGGREGATE = 10;

/**
 * Scoring weights for asymmetric fitness + cost model.
 *
 * The scoring function replaces a simple dot product with:
 *
 *   fitness = Σ [ min(model[d], task[d]) * task[d]                  // capped base reward
 *                 - OVERKILL_WEIGHT * max(0, model[d] - task[d])     // penalty for exceeding
 *                 - DEFICIT_WEIGHT * max(0, task[d] - model[d])² ]   // penalty for falling short
 *
 *   final_score = fitness - COST_WEIGHT * cost                      // prefer cheaper models
 *
 * Cost is either an explicit `profile.cost` value or, when absent, the sum of the
 * four capability dimensions (precision + creativity + thoroughness + reasoning).
 * The explicit field decouples cost from capability, so a very expensive model
 * (e.g. claude-opus-4.7) can carry a high cost penalty even when its capability
 * aggregate is the same as a cheaper peer, and free models (cost=0) are strongly
 * preferred when fitness is comparable.
 *
 * This avoids the "always pick the strongest model" problem of a plain dot product,
 * where overshooting requirements is purely rewarded. Instead:
 * - Meeting a requirement gives the bulk of the score (capped at task level)
 * - Exceeding a requirement is penalized (overkill costs resources without proportional benefit)
 * - Falling short incurs a quadratic penalty (unsuitable models are strongly avoided)
 * - Cheaper models are preferred when fitness is comparable
 *
 * The overkill penalty means models that just barely meet requirements are preferred
 * over more powerful ones, while the reduced deficit penalty makes slightly-underpowered
 * models more acceptable relative to overkill.
 */
const OVERKILL_WEIGHT = 1.5;
const DEFICIT_WEIGHT = 2.0;
const COST_WEIGHT = 0.5;

const REASONING_TO_THINKING: ThinkingLevel[] = [
	"minimal", // 0
	"low",     // 1
	"low",     // 2
	"medium",  // 3
	"high",    // 4
	"xhigh",  // 5
];

// --- Public API ---

/**
 * Map a reasoning score (0-5) to a pi CLI --thinking level.
 * Never returns "off" — minimum is "minimal".
 */
export function reasoningToThinking(reasoningScore: number | undefined): ThinkingLevel {
	if (reasoningScore === undefined) {
		return REASONING_TO_THINKING[DEFAULT_SCORE];
	}
	if (Number.isNaN(reasoningScore) || reasoningScore === -Infinity) {
		return REASONING_TO_THINKING[0];
	}
	if (reasoningScore === Infinity) {
		return REASONING_TO_THINKING[5];
	}
	const clamped = Math.max(0, Math.min(5, reasoningScore));
	return REASONING_TO_THINKING[Math.floor(clamped)];
}

/**
 * Compute fitness score for a model against a task using asymmetric scoring.
 *
 * - Capped base reward: min(model, task) × task — only counts what the task needs
 * - Overkill penalty: linear penalty for exceeding requirements (OVERKILL_WEIGHT)
 * - Deficit penalty: quadratic penalty for falling short (DEFICIT_WEIGHT)
 * - Cost subtraction: linear penalty proportional to explicit cost when present,
 *   else the capability aggregate (COST_WEIGHT)
 */
export function computeFitness(taskScores: TaskScores, profile: ModelProfile): number {
	let fitness = 0;

	for (const dim of DIMENSIONS) {
		const t = taskScores[dim] ?? DEFAULT_SCORE;
		const m = profile[dim];
		const met = Math.min(m, t);
		const deficit = Math.max(0, t - m);
		const overkill = Math.max(0, m - t);

		fitness += met * t;                              // capped base reward
		fitness -= OVERKILL_WEIGHT * overkill;             // penalty for exceeding (overkill)
		fitness -= DEFICIT_WEIGHT * deficit * deficit;   // quadratic penalty for falling short
	}

	const cost = profile.normalizedCost ?? profile.cost ?? DIMENSIONS.reduce((sum, d) => sum + profile[d], 0);
	fitness -= COST_WEIGHT * cost;

	return fitness;
}

export function parseProviderToggles(raw: string | undefined): Record<string, boolean> {
	if (!raw) return {};

	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

		const toggles: Record<string, boolean> = {};
		for (const [provider, enabled] of Object.entries(parsed)) {
			if (typeof enabled === "boolean") toggles[provider] = enabled;
		}
		return toggles;
	} catch {
		return {};
	}
}

export function getDisabledProviders(providerToggles: Record<string, boolean>): Set<string> {
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

/**
 * Select a model from eligible profiles:
 * 1. Determine required thinking level from reasoning score
 * 2. Filter to models that support that thinking level
 * 3. Exclude any models not in the allowed-model set (e.g. provider toggled off)
 * 4. Exclude any models in the exclusion set (e.g. previously failed models)
 * 5. Score remaining by asymmetric fitness function
 * 6. Pick from top-K randomly
 *
 * Returns `undefined` when no eligible models exist.
 */
export function selectModel(
	taskScores: TaskScores,
	config: SelectionConfig,
	excludeModels?: Set<string>,
	allowedModelIds?: Set<string>,
): SelectionResult | undefined {
	const thinkingLevel = reasoningToThinking(taskScores.reasoning);

	// Filter: eligible + meets capability floor + supports the required thinking level + provider-enabled + not excluded
	const eligible = config.profiles.filter((p) => {
		if (!p.eligible) return false;
		// TEMP: exclude models below the capability aggregate floor (see MIN_CAPABILITY_AGGREGATE)
		const aggregate = p.precision + p.creativity + p.thoroughness + p.reasoning;
		if (aggregate < MIN_CAPABILITY_AGGREGATE) return false;
		if (p.thinking && !p.thinking.includes(thinkingLevel)) return false;
		if (allowedModelIds && !allowedModelIds.has(p.id)) return false;
		if (excludeModels && excludeModels.has(p.id)) return false;
		return true;
	});

	if (eligible.length === 0) return undefined;

	const scored = eligible.map((profile) => {
		const fitness = computeFitness(taskScores, profile);
		return { profile, fitness };
	});

	scored.sort((a, b) => b.fitness - a.fitness);

	const topK = scored.slice(0, Math.max(1, config.topK));
	const pool = topK.map((s) => s.profile.id);
	const fitScores = topK.map((s) => s.fitness);

	const pick = Math.floor(Math.random() * topK.length);

	return { modelId: pool[pick], pool, fitScores, thinkingLevel };
}

/**
 * Load model selection config, preferring YAML (cleaner to edit with comments)
 * but falling back to JSON for backward compatibility.
 */
export function loadSelectionConfig(jsonPath: string): SelectionConfig {
	const yamlPath = jsonPath.replace(/\.json$/, ".yaml");
	const parseYaml = getYamlParse();
	if (parseYaml && existsSync(yamlPath)) {
		const raw = readFileSync(yamlPath, "utf-8");
		return parseYaml(raw) as SelectionConfig;
	}
	const raw = readFileSync(jsonPath, "utf-8");
	return JSON.parse(raw) as SelectionConfig;
}