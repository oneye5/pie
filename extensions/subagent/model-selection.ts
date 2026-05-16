import { readFileSync } from "node:fs";

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

// --- Constants ---

const DIMENSIONS = ["precision", "creativity", "thoroughness", "reasoning"] as const;
const DEFAULT_SCORE = 2;

/**
 * Scoring weights for asymmetric fitness + cost model.
 *
 * The scoring function replaces a simple dot product with:
 *
 *   fitness = Σ [ min(model[d], task[d]) * task[d]              // capped base reward
 *                 + SURPLUS_WEIGHT * max(0, model[d] - task[d])   // small bonus for exceeding
 *                 - DEFICIT_WEIGHT * max(0, task[d] - model[d])² ] // heavy penalty for falling short
 *
 *   final_score = fitness - COST_WEIGHT * Σ model[d]             // prefer cheaper models
 *
 * This avoids the "always pick the strongest model" problem of a plain dot product,
 * where overshooting requirements is purely rewarded. Instead:
 * - Meeting a requirement gives the bulk of the score (capped at task level)
 * - Exceeding a requirement adds a small linear bonus (diminishing incentive)
 * - Falling short incurs a steep quadratic penalty (unsuitable models are strongly avoided)
 * - Cheaper models (lower aggregate) are preferred when fitness is comparable
 *
 * The aggregate (sum of model dimensions) serves as a cost proxy: more capable models
 * tend to be more expensive and slower, so preferring a lower aggregate when
 * requirements are met saves resources.
 */
const SURPLUS_WEIGHT = 0.3;
const DEFICIT_WEIGHT = 3.0;
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
	const clamped = Math.max(0, Math.min(5, reasoningScore ?? DEFAULT_SCORE));
	return REASONING_TO_THINKING[clamped];
}

/**
 * Compute fitness score for a model against a task using asymmetric scoring.
 *
 * - Capped base reward: min(model, task) × task — only counts what the task needs
 * - Small surplus bonus: linear bonus for exceeding requirements (SURPLUS_WEIGHT)
 * - Heavy deficit penalty: quadratic penalty for falling short (DEFICIT_WEIGHT)
 * - Cost subtraction: linear penalty proportional to model aggregate (COST_WEIGHT)
 */
export function computeFitness(taskScores: TaskScores, profile: ModelProfile): number {
	let fitness = 0;

	for (const dim of DIMENSIONS) {
		const t = taskScores[dim] ?? DEFAULT_SCORE;
		const m = profile[dim];
		const met = Math.min(m, t);
		const deficit = Math.max(0, t - m);
		const surplus = Math.max(0, m - t);

		fitness += met * t;                              // capped base reward
		fitness += SURPLUS_WEIGHT * surplus;              // small bonus for exceeding
		fitness -= DEFICIT_WEIGHT * deficit * deficit;   // quadratic penalty for falling short
	}

	const cost = DIMENSIONS.reduce((sum, d) => sum + profile[d], 0);
	fitness -= COST_WEIGHT * cost;

	return fitness;
}

/**
 * Select a model from eligible profiles:
 * 1. Determine required thinking level from reasoning score
 * 2. Filter to models that support that thinking level
 * 3. Score remaining by asymmetric fitness function
 * 4. Pick from top-K randomly
 *
 * Returns `undefined` when no eligible models exist.
 */
export function selectModel(
	taskScores: TaskScores,
	config: SelectionConfig,
): SelectionResult | undefined {
	const thinkingLevel = reasoningToThinking(taskScores.reasoning);

	// Filter: eligible + supports the required thinking level
	const eligible = config.profiles.filter((p) => {
		if (!p.eligible) return false;
		if (p.thinking && !p.thinking.includes(thinkingLevel)) return false;
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

export function loadSelectionConfig(configPath: string): SelectionConfig {
	const raw = readFileSync(configPath, "utf-8");
	return JSON.parse(raw) as SelectionConfig;
}