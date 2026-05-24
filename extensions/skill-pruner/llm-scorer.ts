import type { PruningConfig } from "./types.js";

export interface SkillCandidate {
	name: string;
	description: string;
}

export interface ToolCandidate {
	name: string;
	description: string;
}

export interface LlmPruningInput {
	userPrompt: string;
	contextFile?: string;
	skills: SkillCandidate[];
	tools: ToolCandidate[];
	config: PruningConfig;
}

export interface LlmPruningOutput {
	selectedSkills: string[];
	selectedTools: string[];
	rawResponse: string;
	latencyMs: number;
}

/** Build the system prompt for the pruning LLM call. */
export function buildPruningSystemPrompt(config: PruningConfig): string {
	const lines = [
		"You are a relevance filter. Given a user request and a list of available skills and tools, select ONLY those that are directly needed.",
		"",
		"Rules:",
		"- For skills: select only skills whose specialized knowledge is required. If the request is simple/routine, select NONE.",
		"- For tools: select only tools the agent will likely need to call. Always include core tools (read, edit, write, bash) unless the task clearly won't need them.",
		"- Respond with ONLY a JSON object: {\"skills\": [\"name1\", ...], \"tools\": [\"name1\", ...]}",
		"- Do not explain. Do not add commentary.",
	];

	if (config.skills.strategy === "topK") {
		lines.push("", `Select up to ${config.skills.ceiling} skills and ${config.tools?.ceiling ?? 10} tools, ranked by relevance.`);
	} else {
		lines.push("", "Select only what is genuinely needed. It is acceptable to select zero skills if the request is routine.");
	}

	return lines.join("\n");
}

/** Build the user message for the pruning LLM call. */
export function buildPruningUserMessage(input: LlmPruningInput): string {
	const lines = [`User request: "${input.userPrompt}"`];

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
) => Promise<{ text: string }>;

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
		latencyMs,
	};
}
