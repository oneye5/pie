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
 * Select a model from eligible profiles:
 * 1. Determine required thinking level from reasoning score
 * 2. Filter to models that support that thinking level
 * 3. Score remaining by dot product against task vector
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

	// Score by dot product (excluding reasoning from scoring since it's handled by thinking level)
	const tv = DIMENSIONS.map((d) => taskScores[d] ?? DEFAULT_SCORE);

	const scored = eligible.map((profile) => {
		const mv = DIMENSIONS.map((d) => profile[d]);
		const dot = tv.reduce((sum, t, i) => sum + t * mv[i], 0);
		return { profile, dot };
	});

	scored.sort((a, b) => b.dot - a.dot);

	const topK = scored.slice(0, Math.max(1, config.topK));
	const pool = topK.map((s) => s.profile.id);
	const fitScores = topK.map((s) => s.dot);

	const pick = Math.floor(Math.random() * topK.length);

	return { modelId: pool[pick], pool, fitScores, thinkingLevel };
}

export function loadSelectionConfig(configPath: string): SelectionConfig {
	const raw = readFileSync(configPath, "utf-8");
	return JSON.parse(raw) as SelectionConfig;
}
