export type PruningMode = "auto" | "off" | "shadow";

export type PruningStrategy = "discretion" | "topK";

export interface SkillPruningConfig {
	strategy: PruningStrategy;
	ceiling: number;
	pinned: string[];
}

export type ToolDependencies = Record<string, string[]>;

export interface ToolPruningConfig {
	strategy: PruningStrategy;
	ceiling: number;
	dependencies: ToolDependencies;
}

export interface PruningConfig {
	mode: PruningMode;
	model: string;
	provider: string;
	thinkingLevel: string;
	skills: SkillPruningConfig;
	tools?: ToolPruningConfig;
}

export interface PruningResult {
	includedSkills: string[];
	excludedSkills: string[];
	includedTools: string[];
	excludedTools: string[];
	mode: PruningMode;
	skillTokensSaved: number;
	toolTokensSaved: number;
	/** Model used for the LLM prepass call. */
	prepassModel?: string;
	/** Thinking level of the LLM prepass call. */
	prepassThinkingLevel?: string;
	/** Raw LLM response text. */
	prepassResponse?: string;
	/** Raw thinking/reasoning tokens from the prepass LLM call. */
	prepassThinking?: string;
	/** System prompt sent to the LLM prepass. */
	prepassSystemPrompt?: string;
	/** Latency of the LLM prepass call in milliseconds. */
	prepassLatencyMs?: number;
	/** Error message if the prepass failed. */
	prepassError?: string;
}

export interface PruningDecision {
	timestamp: string;
	sessionId: string;
	mode: PruningMode;
	query: string;
	contextFile?: string;
	llmModel: string;
	llmThinkingLevel: string;
	llmResponse: string;
	llmLatencyMs: number;
	pinned: string[];
	included: string[];
	excluded: string[];
	skillBlockTokens: number;
	originalBlockTokens: number;
	toolIncluded?: string[];
	toolExcluded?: string[];
	toolBlockTokens?: number;
	originalToolBlockTokens?: number;
}
