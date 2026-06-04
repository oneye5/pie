import test from "node:test";
import assert from "node:assert/strict";
import { buildPruningSystemPrompt, buildPruningUserMessage, parseLlmResponse, runLlmPruning, __setPromptTemplate } from "../llm-scorer.js";
import type { PruningConfig } from "../types.js";

function makeConfig(overrides: Partial<PruningConfig> = {}): PruningConfig {
	return {
		mode: "auto",
		model: "gpt-5.4-mini",
		provider: "github-copilot",
		thinkingLevel: "minimal",
		skills: { strategy: "discretion", ceiling: 8, pinned: [], alwaysKeep: [] },
		tools: { strategy: "discretion", ceiling: 10, dependencies: {}, alwaysKeep: [] },
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// buildPruningSystemPrompt tests
// ---------------------------------------------------------------------------

test("buildPruningSystemPrompt includes discretion instruction for discretion strategy", () => {
	const config = makeConfig();
	const prompt = buildPruningSystemPrompt(config);
	assert.ok(prompt.includes("Use discretion"));
	assert.ok(prompt.includes("prune clearly unrelated"));
	assert.ok(!prompt.includes("Rank by relevance"));
});

test("buildPruningSystemPrompt includes topK instruction for topK strategy", () => {
	const config = makeConfig({
		skills: { strategy: "topK", ceiling: 5, pinned: [], alwaysKeep: [] },
		tools: { strategy: "topK", ceiling: 8, dependencies: {}, alwaysKeep: [] },
	});
	const prompt = buildPruningSystemPrompt(config);
	assert.ok(prompt.includes("Rank by relevance and select at most 5 skills and 8 tools"));
	assert.ok(!prompt.includes("Use discretion"));
});

test("buildPruningSystemPrompt always includes core rules", () => {
	const prompt = buildPruningSystemPrompt(makeConfig());
	assert.ok(prompt.includes("relevance classifier"));
	assert.ok(prompt.includes("JSON object"));
	assert.ok(prompt.includes("Do not wrap in markdown"));
});

test("buildPruningSystemPrompt works with __setPromptTemplate test seam", () => {
	const customTemplate = "Custom template with {{SKILL_CEILING}} skills and {{TOOL_CEILING}} tools. {{STRATEGY_INSTRUCTION}}";
	__setPromptTemplate(customTemplate);
	try {
		const config = makeConfig({ skills: { strategy: "discretion", ceiling: 8, pinned: [], alwaysKeep: [] } });
		const prompt = buildPruningSystemPrompt(config);
		assert.ok(prompt.includes("Custom template with 8 skills and 10 tools"));
		assert.ok(prompt.includes("Use discretion"));
	} finally {
		__setPromptTemplate(null);
	}
});

// ---------------------------------------------------------------------------
// buildPruningUserMessage tests
// ---------------------------------------------------------------------------

test("buildPruningUserMessage includes user request and skill/tool lists", () => {
	const msg = buildPruningUserMessage({
		userPrompt: "refactor this code",
		skills: [{ name: "code-simplification", description: "Simplifies code" }],
		tools: [{ name: "read", description: "Read files" }],
		config: makeConfig(),
	});
	assert.ok(msg.includes('User request: "refactor this code"'));
	assert.ok(msg.includes("- code-simplification: Simplifies code"));
	assert.ok(msg.includes("- read: Read files"));
});


test("buildPruningUserMessage includes recent conversation when provided", () => {
	const msg = buildPruningUserMessage({
		userPrompt: "new zealand, use the local conventions",
		recentConversation: [
			{ role: "user", text: "hello there, whats going on with the weather in wellington today" },
			{ role: "assistant", text: "Do you mean Wellington, New Zealand?" },
		],
		skills: [],
		tools: [],
		config: makeConfig(),
	});
	assert.ok(msg.includes("Recent conversation (use this to interpret follow-up requests):"));
	assert.ok(msg.includes("- user: hello there, whats going on with the weather in wellington today"));
	assert.ok(msg.includes("- assistant: Do you mean Wellington, New Zealand?"));
});

test("buildPruningUserMessage includes context file when provided", () => {
	const msg = buildPruningUserMessage({
		userPrompt: "help",
		contextFile: "AGENTS.md",
		skills: [],
		tools: [],
		config: makeConfig(),
	});
	assert.ok(msg.includes("Context file: AGENTS.md"));
});

test("buildPruningUserMessage omits context file when not provided", () => {
	const msg = buildPruningUserMessage({
		userPrompt: "help",
		skills: [],
		tools: [],
		config: makeConfig(),
	});
	assert.ok(!msg.includes("Context file"));
});

// ---------------------------------------------------------------------------
// parseLlmResponse tests
// ---------------------------------------------------------------------------

test("parseLlmResponse parses valid JSON response", () => {
	const knownSkills = new Set(["alpha", "beta", "gamma"]);
	const knownTools = new Set(["read", "edit", "bash"]);
	const result = parseLlmResponse(
		'{"skills": ["alpha", "gamma"], "tools": ["read"]}',
		knownSkills,
		knownTools,
	);
	assert.deepEqual(result.skills, ["alpha", "gamma"]);
	assert.deepEqual(result.tools, ["read"]);
});

test("parseLlmResponse filters unknown names", () => {
	const knownSkills = new Set(["alpha"]);
	const knownTools = new Set(["read"]);
	const result = parseLlmResponse(
		'{"skills": ["alpha", "unknown-skill"], "tools": ["read", "unknown-tool"]}',
		knownSkills,
		knownTools,
	);
	assert.deepEqual(result.skills, ["alpha"]);
	assert.deepEqual(result.tools, ["read"]);
});

test("parseLlmResponse handles JSON in markdown code block", () => {
	const knownSkills = new Set(["alpha"]);
	const knownTools = new Set(["read"]);
	const result = parseLlmResponse(
		'```json\n{"skills": ["alpha"], "tools": ["read"]}\n```',
		knownSkills,
		knownTools,
	);
	assert.deepEqual(result.skills, ["alpha"]);
	assert.deepEqual(result.tools, ["read"]);
});


test("parseLlmResponse extracts embedded JSON from surrounding prose", () => {
	const knownSkills = new Set(["alpha"]);
	const knownTools = new Set(["read"]);
	const result = parseLlmResponse(
		'Sure — use this: {"skills": ["alpha"], "tools": ["read"]}',
		knownSkills,
		knownTools,
	);
	assert.deepEqual(result.skills, ["alpha"]);
	assert.deepEqual(result.tools, ["read"]);
});

test("parseLlmResponse falls back to name extraction from raw text", () => {
	const knownSkills = new Set(["code-simplification", "frontend-design"]);
	const knownTools = new Set(["read", "edit"]);
	const result = parseLlmResponse(
		"I think code-simplification and read would be useful",
		knownSkills,
		knownTools,
	);
	assert.deepEqual(result.skills, ["code-simplification"]);
	assert.deepEqual(result.tools, ["read"]);
});

test("parseLlmResponse returns empty arrays for completely invalid input", () => {
	const knownSkills = new Set(["alpha"]);
	const knownTools = new Set(["read"]);
	const result = parseLlmResponse("", knownSkills, knownTools);
	assert.deepEqual(result.skills, []);
	assert.deepEqual(result.tools, []);
});

test("parseLlmResponse handles missing skills/tools keys gracefully", () => {
	const knownSkills = new Set(["alpha"]);
	const knownTools = new Set(["read"]);
	const result = parseLlmResponse('{"skills": ["alpha"]}', knownSkills, knownTools);
	assert.deepEqual(result.skills, ["alpha"]);
	assert.deepEqual(result.tools, []);
	assert.equal(result.skillsExplicitlyEmpty, false);
	assert.equal(result.toolsExplicitlyEmpty, false);
});

test("parseLlmResponse flags explicitly empty skills array", () => {
	const knownSkills = new Set(["alpha"]);
	const knownTools = new Set(["read"]);
	const result = parseLlmResponse('{"skills":[],"tools":["read"]}', knownSkills, knownTools);
	assert.deepEqual(result.skills, []);
	assert.deepEqual(result.tools, ["read"]);
	assert.equal(result.skillsExplicitlyEmpty, true);
	assert.equal(result.toolsExplicitlyEmpty, false);
});

test("parseLlmResponse flags explicitly empty tools array", () => {
	const knownSkills = new Set(["alpha"]);
	const knownTools = new Set(["read"]);
	const result = parseLlmResponse('{"skills":["alpha"],"tools":[]}', knownSkills, knownTools);
	assert.deepEqual(result.skills, ["alpha"]);
	assert.deepEqual(result.tools, []);
	assert.equal(result.skillsExplicitlyEmpty, false);
	assert.equal(result.toolsExplicitlyEmpty, true);
});

test("parseLlmResponse does not flag explicit empty when array filtered to empty", () => {
	const knownSkills = new Set(["alpha"]);
	const knownTools = new Set(["read"]);
	const result = parseLlmResponse('{"skills":["unknown"],"tools":["unknown-tool"]}', knownSkills, knownTools);
	assert.deepEqual(result.skills, []);
	assert.deepEqual(result.tools, []);
	assert.equal(result.skillsExplicitlyEmpty, false);
	assert.equal(result.toolsExplicitlyEmpty, false);
});

test("parseLlmResponse extracts reasoning from JSON response", () => {
	const knownSkills = new Set(["alpha"]);
	const knownTools = new Set(["read"]);
	const result = parseLlmResponse(
		'{"reasoning":"Frontend bug requires UI fixes","skills":["alpha"],"tools":["read"]}',
		knownSkills,
		knownTools,
	);
	assert.deepEqual(result.skills, ["alpha"]);
	assert.deepEqual(result.tools, ["read"]);
	assert.equal(result.reasoning, "Frontend bug requires UI fixes");
});

test("parseLlmResponse omits reasoning when absent or empty", () => {
	const knownSkills = new Set(["alpha"]);
	const knownTools = new Set(["read"]);
	const withEmpty = parseLlmResponse(
		'{"reasoning":"","skills":["alpha"],"tools":["read"]}',
		knownSkills,
		knownTools,
	);
	assert.equal(withEmpty.reasoning, undefined);
	const without = parseLlmResponse(
		'{"skills":["alpha"],"tools":["read"]}',
		knownSkills,
		knownTools,
	);
	assert.equal(without.reasoning, undefined);
});

// ---------------------------------------------------------------------------
// runLlmPruning tests
// ---------------------------------------------------------------------------

test("runLlmPruning calls completeFn and returns parsed result", async () => {
	const input = {
		userPrompt: "refactor code",
		skills: [
			{ name: "code-simplification", description: "Simplifies code" },
			{ name: "frontend-design", description: "Frontend UI" },
		],
		tools: [
			{ name: "read", description: "Read files" },
			{ name: "edit", description: "Edit files" },
		],
		config: makeConfig(),
	};

	const completeFn = async () => ({
		text: '{"skills": ["code-simplification"], "tools": ["read", "edit"]}',
		thinking: 'Refactoring suggests code-simplification skill.',
	});

	const result = await runLlmPruning(input, undefined, {}, completeFn);
	assert.deepEqual(result.selectedSkills, ["code-simplification"]);
	assert.deepEqual(result.selectedTools, ["read", "edit"]);
	assert.ok(result.latencyMs >= 0);
	assert.ok(result.rawResponse.includes("code-simplification"));
});

test("runLlmPruning propagates completion errors", async () => {
	const input = {
		userPrompt: "test",
		skills: [],
		tools: [],
		config: makeConfig(),
	};

	const completeFn = async () => { throw new Error("timeout"); };

	await assert.rejects(
		() => runLlmPruning(input, undefined, {}, completeFn),
		/timeout/,
	);
});

test("runLlmPruning handles invalid JSON from model gracefully", async () => {
	const input = {
		userPrompt: "test",
		skills: [{ name: "alpha", description: "Alpha skill" }],
		tools: [{ name: "read", description: "Read files" }],
		config: makeConfig(),
	};

	const completeFn = async () => ({ text: "not json but alpha and read" });

	const result = await runLlmPruning(input, undefined, {}, completeFn);
	// Should still extract known names from raw text
	assert.deepEqual(result.selectedSkills, ["alpha"]);
	assert.deepEqual(result.selectedTools, ["read"]);
});

test("runLlmPruning falls back to JSON reasoning when native thinking is absent", async () => {
	const input = {
		userPrompt: "refactor code",
		skills: [{ name: "code-simplification", description: "Simplifies code" }],
		tools: [{ name: "read", description: "Read files" }],
		config: makeConfig(),
	};

	const completeFn = async () => ({
		text: '{"reasoning":"Refactoring needs code-simplification","skills":["code-simplification"],"tools":["read"]}',
	});

	const result = await runLlmPruning(input, undefined, {}, completeFn);
	assert.deepEqual(result.selectedSkills, ["code-simplification"]);
	assert.deepEqual(result.selectedTools, ["read"]);
	assert.equal(result.rawThinking, "Refactoring needs code-simplification");
});

test("runLlmPruning prefers native thinking over JSON reasoning", async () => {
	const input = {
		userPrompt: "refactor code",
		skills: [{ name: "code-simplification", description: "Simplifies code" }],
		tools: [{ name: "read", description: "Read files" }],
		config: makeConfig(),
	};

	const completeFn = async () => ({
		text: '{"reasoning":"JSON reasoning","skills":["code-simplification"],"tools":["read"]}',
		thinking: "Native reasoning",
	});

	const result = await runLlmPruning(input, undefined, {}, completeFn);
	assert.equal(result.rawThinking, "Native reasoning");
});
