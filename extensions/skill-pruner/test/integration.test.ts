import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI, Skill } from "@mariozechner/pi-coding-agent";
import skillPruner, { resetForTesting, setConfigForTesting } from "../index.js";
import { clearPruningTrackingForTesting, setLogPathForTesting } from "../logger.js";
import type { PruningConfig } from "../types.js";

function skill(name: string, description: string): Skill {
	return {
		name,
		description,
		filePath: `/repo/skills/${name}/SKILL.md`,
		baseDir: `/repo/skills/${name}`,
		sourceInfo: {} as Skill["sourceInfo"],
		disableModelInvocation: false,
	};
}

function config(overrides: Partial<PruningConfig["skills"]> = {}, mode: PruningConfig["mode"] = "auto"): PruningConfig {
	return {
		mode,
		skills: { ceiling: 5, floor: 2, scoreThreshold: 0.4, gapThreshold: 0.3, pinned: [], ...overrides },
	};
}

type Handler = (event: any, ctx: any) => unknown | Promise<unknown>;

function register(configOverride: PruningConfig, logPath = path.join(mkdtempSync(path.join(tmpdir(), "skill-pruner-integration-")), "pruning.jsonl")): Map<string, Handler> {
	resetForTesting();
	clearPruningTrackingForTesting();
	setLogPathForTesting(logPath);
	setConfigForTesting(configOverride);
	const handlers = new Map<string, Handler>();
	const pi = {
		on(eventName: string, handler: Handler) {
			handlers.set(eventName, handler);
		},
	} as unknown as ExtensionAPI;
	skillPruner(pi);
	return handlers;
}

function systemPrompt(skills: Skill[]): string {
	return `Base prompt.${formatSkillsForPrompt(skills)}\nCurrent date: 2026-05-16`;
}

function formatSkillsForPrompt(skills: Skill[]): string {
	if (skills.length === 0) return "";
	const lines = [
		"\n\nThe following skills provide specialized instructions for specific tasks.",
		"Use the read tool to load a skill's file when the task matches its description.",
		"When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
		"",
		"<available_skills>",
	];
	for (const skill of skills) {
		lines.push("  <skill>");
		lines.push(`    <name>${skill.name}</name>`);
		lines.push(`    <description>${skill.description}</description>`);
		lines.push(`    <location>${skill.filePath}</location>`);
		lines.push("  </skill>");
	}
	lines.push("</available_skills>");
	return lines.join("\n");
}

async function runBeforeAgentStart(handlers: Map<string, Handler>, prompt: string, skills: Skill[], overrideSystemPrompt?: string) {
	const handler = handlers.get("before_agent_start");
	assert.ok(handler, "before_agent_start handler registered");
	return await handler({
		type: "before_agent_start",
		prompt,
		systemPrompt: overrideSystemPrompt ?? systemPrompt(skills),
		systemPromptOptions: {
			cwd: "/repo",
			skills,
			contextFiles: [{ path: "AGENTS.md", content: "Project context" }],
		},
	}, { cwd: "/repo", sessionId: "session-1" });
}

const realisticSkills = [
	skill("code-simplification", "Simplifies code for clarity. Use when refactoring code for clarity, reducing complexity. Do not use when adding new features."),
	skill("duckdb-query-optimization", "Guides DuckDB query performance tuning. Use when queries against analytics databases are slow, writing new analytics queries. Do not use for general SQL questions."),
	skill("frontend-design", "Production-grade frontend interfaces. Use when building UI components, pages, or visual applications. Do not use for backend logic."),
];

test("full pipeline includes focused relevant skills and hints excluded skills", async () => {
	const handlers = register(config({ floor: 1, ceiling: 2, scoreThreshold: 0.4, gapThreshold: 0.3 }));
	const result = await runBeforeAgentStart(handlers, "Refactor this code for clarity", realisticSkills) as { systemPrompt?: string } | undefined;

	assert.ok(result?.systemPrompt);
	assert.match(result.systemPrompt, /<name>code-simplification<\/name>/);
	assert.doesNotMatch(result.systemPrompt, /<name>duckdb-query-optimization<\/name>/);
	assert.match(result.systemPrompt, /Pruned skills .*duckdb-query-optimization/);
});

test("empty skills array produces no modification", async () => {
	const handlers = register(config());
	const result = await runBeforeAgentStart(handlers, "anything", [], "Base prompt without skills");
	assert.equal(result, undefined);
});

test("all-zero scores include floor of 2 by name asc", async () => {
	const skills = [
		skill("charlie", "General helper."),
		skill("alpha", "Another helper."),
		skill("bravo", "More assistance."),
	];
	const handlers = register(config({ floor: 2, ceiling: 5 }));
	const result = await runBeforeAgentStart(handlers, "unrelated zebra", skills) as { systemPrompt?: string } | undefined;

	assert.ok(result?.systemPrompt);
	assert.match(result.systemPrompt, /<name>alpha<\/name>/);
	assert.match(result.systemPrompt, /<name>bravo<\/name>/);
	assert.doesNotMatch(result.systemPrompt, /<name>charlie<\/name>/);
	assert.match(result.systemPrompt, /Pruned skills .*charlie/);
});

test("regex no-match case fails open with original prompt unchanged", async () => {
	const handlers = register(config({ floor: 1, ceiling: 1 }));
	const result = await runBeforeAgentStart(handlers, "Refactor code", realisticSkills, "Base prompt without the skills block");
	assert.equal(result, undefined);
});

test("literal /skill:name prompt force-includes the named skill through name match", async () => {
	const handlers = register(config({ floor: 1, ceiling: 1 }));
	const result = await runBeforeAgentStart(handlers, "Please use /skill:duckdb-query-optimization for this", realisticSkills) as { systemPrompt?: string } | undefined;

	assert.ok(result?.systemPrompt);
	assert.match(result.systemPrompt, /<name>duckdb-query-optimization<\/name>/);
	assert.doesNotMatch(result.systemPrompt, /<name>code-simplification<\/name>/);
});

test("shadow mode leaves prompt unchanged, logs decision, and records shadow miss candidates", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "skill-pruner-integration-"));
	const logPath = path.join(dir, "pruning.jsonl");
	setLogPathForTesting(logPath);
	try {
		const handlers = register(config({ floor: 1, ceiling: 1 }, "shadow"), logPath);
		const originalPrompt = systemPrompt(realisticSkills);
		const result = await runBeforeAgentStart(handlers, "Refactor this code for clarity", realisticSkills, originalPrompt) as { systemPrompt?: string } | undefined;

		assert.equal(result?.systemPrompt, originalPrompt);

		const toolHandler = handlers.get("tool_call");
		assert.ok(toolHandler, "tool_call handler registered");
		await toolHandler({
			type: "tool_call",
			toolCallId: "1",
			toolName: "read",
			input: { path: "/repo/skills/duckdb-query-optimization/SKILL.md" },
		}, { cwd: "/repo", sessionId: "session-1" });

		const lines = readFileSync(logPath, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
		assert.equal(lines[0].mode, "shadow");
		assert.ok(lines[0].excluded.includes("duckdb-query-optimization"));
		assert.ok(lines.some((line) => line.event === "skill_read" && line.skillName === "duckdb-query-optimization"));
		assert.ok(lines.some((line) => line.event === "shadow_miss_candidate" && line.skillName === "duckdb-query-optimization"));
	} finally {
		setLogPathForTesting(null);
		clearPruningTrackingForTesting();
	}
});

test("input handler always continues", async () => {
	const handlers = register(config());
	const handler = handlers.get("input");
	assert.ok(handler, "input handler registered");
	assert.deepEqual(await handler({ type: "input", text: "hello", source: "interactive" }, { cwd: "/repo" }), { action: "continue" });
});
