import test from "node:test";
import assert from "node:assert/strict";
import { buildPruningSystemPrompt, buildPruningUserMessage, parseLlmResponse, runLlmPruning } from "../llm-scorer.js";
import type { PruningConfig } from "../types.js";

function makeConfig(overrides: Partial<PruningConfig> = {}): PruningConfig {
	return {
		mode: "auto",
		model: "gpt-5.4-mini",
		provider: "github-copilot",
		thinkingLevel: "minimal",
		skills: { strategy: "discretion", ceiling: 8, pinned: [] },
		tools: { strategy: "discretion", ceiling: 10, dependencies: {} },
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// buildPruningSystemPrompt tests
// ---------------------------------------------------------------------------

test("buildPruningSystemPrompt includes discretion instruction for discretion strategy", () => {
	const config = makeConfig();
	const prompt = buildPruningSystemPrompt(config);
	assert.ok(prompt.includes("plausibly useful"));
	assert.ok(prompt.includes("lean toward keeping"));
	assert.ok(!prompt.includes("Select up to"));
});

test("buildPruningSystemPrompt includes topK instruction for topK strategy", () => {
	const config = makeConfig({
		skills: { strategy: "topK", ceiling: 5, pinned: [] },
		tools: { strategy: "topK", ceiling: 8, dependencies: {} },
	});
	const prompt = buildPruningSystemPrompt(config);
	assert.ok(prompt.includes("Select up to 5 skills and 8 tools"));
	assert.ok(!prompt.includes("genuinely needed"));
});

test("buildPruningSystemPrompt always includes core rules", () => {
	const prompt = buildPruningSystemPrompt(makeConfig());
	assert.ok(prompt.includes("relevance classifier"));
	assert.ok(prompt.includes("JSON object"));
	assert.ok(prompt.includes("Do not explain"));
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
