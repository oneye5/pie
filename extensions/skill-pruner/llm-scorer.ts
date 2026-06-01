import { readFileSync } from "node:fs";
import path from "node:path";
import type { PruningConfig } from "./types.js";

export interface SkillCandidate {
	name: string;
	description: string;
}

export interface ToolCandidate {
	name: string;
	description: string;
}

export interface RecentConversationMessage {
	role: string;
	text: string;
}

export interface LlmPruningInput {
	userPrompt: string;
	contextFile?: string;
	recentConversation?: RecentConversationMessage[];
	skills: SkillCandidate[];
	tools: ToolCandidate[];
	config: PruningConfig;
}

export interface LlmPruningOutput {
	selectedSkills: string[];
	selectedTools: string[];
	rawResponse: string;
	rawThinking: string;
	systemPrompt: string;
	userMessage: string;
	latencyMs: number;
	stopReason?: string;
	errorMessage?: string;
}

export interface CompleteSimpleResult {
	text: string;
	thinking?: string;
	stopReason?: string;
	errorMessage?: string;
}

const DEFAULT_PROMPT_TEMPLATE = loadPromptTemplate();
let promptTemplateOverride: string | null = null;

function loadPromptTemplate(): string {
	try {
		return readFileSync(path.join(import.meta.dirname, "pruning-system-prompt.md"), "utf-8").trim();
	} catch {
		return [
			"You are a relevance classifier for a coding agent prompt-pruning prepass.",
			"Your job is to reduce prompt/tool noise while keeping the skills and tools that are likely to help with the user's current request, interpreted in conversation context.",
			"",
			"Respond with ONLY a valid JSON object in this exact shape:",
			'{"reasoning":"1-2 short sentences explaining the classification for debugging","skills":["skill-name"],"tools":["tool-name"]}',
			"Do not wrap in markdown. Do not include names that are not in the candidate lists.",
			"",
			"{{STRATEGY_INSTRUCTION}}",
		].join("\n");
	}
}

function resolvePromptTemplate(): string {
	return promptTemplateOverride ?? DEFAULT_PROMPT_TEMPLATE;
}

function buildStrategyInstruction(config: PruningConfig): string {
	if (config.skills.strategy === "topK") {
		return `Rank by relevance and select at most ${config.skills.ceiling} skills and ${config.tools?.ceiling ?? 10} tools.`;
	}
	return "Use discretion. Keep plausibly useful items, but prune clearly unrelated skills and tools.";
}

/** Build the system prompt for the pruning LLM call. */
export function buildPruningSystemPrompt(config: PruningConfig): string {
	return resolvePromptTemplate()
		.replace(/\{\{SKILL_CEILING\}\}/g, String(config.skills.ceiling))
		.replace(/\{\{TOOL_CEILING\}\}/g, String(config.tools?.ceiling ?? 10))
		.replace(/\{\{STRATEGY_INSTRUCTION\}\}/g, buildStrategyInstruction(config));
}

/** Build the user message for the pruning LLM call. */
export function buildPruningUserMessage(input: LlmPruningInput): string {
	const lines = [`User request: "${input.userPrompt}"`];

	if (input.recentConversation && input.recentConversation.length > 0) {
		lines.push("", "Recent conversation (use this to interpret follow-up requests):");
		for (const message of input.recentConversation) {
			lines.push(`- ${message.role}: ${message.text}`);
		}
	}

	if (input.contextFile) {
		lines.push("", `Context file: ${input.contextFile}`);
	}

	lines.push("", "Available skills:");
	for (const s of input.skills) {
		lines.push(`- ${s.name}: ${s.description}`);
	}

	lines.push("", "Available tools:");
	for (const t of input.tools) {
		lines.push(`- ${t.name}: ${t.description}`);
	}

	return lines.join("\n");
}

/** Parse the LLM response JSON, with fallback regex extraction. */
export function parseLlmResponse(raw: string, knownSkills: Set<string>, knownTools: Set<string>): { skills: string[]; tools: string[] } {
	// Try strict JSON parse first
	try {
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed === "object") {
			const skills = Array.isArray(parsed.skills) ? parsed.skills.filter((s: unknown) => typeof s === "string" && knownSkills.has(s)) : [];
			const tools = Array.isArray(parsed.tools) ? parsed.tools.filter((t: unknown) => typeof t === "string" && knownTools.has(t)) : [];
			return { skills, tools };
		}
	} catch {
		// Fall through to regex extraction
	}

	// Fallback: try to extract JSON from markdown code block or partial response
	const jsonMatch = raw.match(/\{[\s\S]*\}/);
	if (jsonMatch) {
		try {
			const parsed = JSON.parse(jsonMatch[0]);
			if (parsed && typeof parsed === "object") {
				const skills = Array.isArray(parsed.skills) ? parsed.skills.filter((s: unknown) => typeof s === "string" && knownSkills.has(s)) : [];
				const tools = Array.isArray(parsed.tools) ? parsed.tools.filter((t: unknown) => typeof t === "string" && knownTools.has(t)) : [];
				return { skills, tools };
			}
		} catch {
			// Fall through
		}
	}

	// Last resort: extract quoted strings that match known names
	const skills: string[] = [];
	const tools: string[] = [];
	for (const name of knownSkills) {
		if (raw.includes(name)) skills.push(name);
	}
	for (const name of knownTools) {
		if (raw.includes(name)) tools.push(name);
	}

	return { skills, tools };
}

export type CompleteSimpleFn = (
	model: unknown,
	context: Array<{ role: string; content: string }>,
	options: Record<string, unknown>,
) => Promise<CompleteSimpleResult>;

/**
 * Run the LLM pruning call. Accepts a `completeFn` parameter for testability.
 */
export async function runLlmPruning(
	input: LlmPruningInput,
	model: unknown,
	options: Record<string, unknown>,
	completeFn: CompleteSimpleFn,
): Promise<LlmPruningOutput> {
	const systemPrompt = buildPruningSystemPrompt(input.config);
	const userMessage = buildPruningUserMessage(input);

	const context = [
		{ role: "system", content: systemPrompt },
		{ role: "user", content: userMessage },
	];

	const start = Date.now();
	const response = await completeFn(model, context, options);
	const latencyMs = Date.now() - start;

	const knownSkills = new Set(input.skills.map((s) => s.name));
	const knownTools = new Set(input.tools.map((t) => t.name));
	const parsed = parseLlmResponse(response.text, knownSkills, knownTools);

	return {
		selectedSkills: parsed.skills,
		selectedTools: parsed.tools,
		rawResponse: response.text,
		rawThinking: response.thinking ?? "",
		systemPrompt,
		userMessage,
		latencyMs,
		stopReason: response.stopReason,
		errorMessage: response.errorMessage,
	};
}

/** internal: test seam — overrides the prompt template. */
export function __setPromptTemplate(template: string | null): void {
	promptTemplateOverride = template;
}
