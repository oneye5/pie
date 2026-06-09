/**
 * Type definitions shared across the skill-pruner source modules.
 *
 * `pruning.ts` declares the *interfaces* for the data it produces, but
 * those types are also referenced by `message-builders.ts` (which only
 * consumes the values) and the `register.ts` orchestrator. Putting them
 * here keeps the modules from forming an import cycle.
 */

export interface SkillPruningResult {
	included: string[];
	excluded: string[];
	tokensSaved: number;
}

export interface ToolPruningResult {
	included: string[];
	excluded: string[];
	tokensSaved: number;
}

export interface PrepassRunResult {
	selectedSkills: string[] | null;
	selectedTools: string[] | null;
	skillsExplicitlyEmpty: boolean;
	toolsExplicitlyEmpty: boolean;
	error: string | null;
	rawResponse: string;
	rawThinking: string;
	rawSystemPrompt: string;
	rawUserMessage: string;
	latencyMs: number;
	thinkingLevel: string;
}
