import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI, Skill, ToolInfo } from "@mariozechner/pi-coding-agent";
import { clearPruningTrackingForTesting, setLogPathForTesting } from "../logger.js";
import type { PruningConfig } from "../types.js";

installSdkResolverForTests();
const require = createRequire(import.meta.url);
const { default: skillPruner, __setFormatter, __setToolSeams, __setCompleteFn, resetForTesting, setConfigForTesting } = require("../index.ts") as typeof import("../index.js");

function installSdkResolverForTests(): void {
	// Isolate from host extension-toggle state. When tests run inside the
	// running editor, the host exports PIE_EXTENSION_TOGGLES_JSON with
	// skill-pruner disabled, which makes shouldSkipPruning() short-circuit the
	// before_agent_start handler to `undefined` before any pruning runs.
	// These tests drive on/off/auto/shadow via config.mode and never exercise
	// the toggle, so neutralize it for the duration of this test process.
	delete process.env.PIE_EXTENSION_TOGGLES_JSON;

	const mockDir = mkdtempSync(path.join(tmpdir(), "skill-pruner-sdk-mock-"));

	const sdkPath = path.join(mockDir, "pi-coding-agent.cjs");
	writeFileSync(sdkPath, "exports.formatSkillsForPrompt = () => { throw new Error('test must call __setFormatter'); };\n", "utf-8");

	const tuiPath = path.join(mockDir, "pi-tui.cjs");
	writeFileSync(tuiPath, [
		"class Box {",
		"  children = [];",
		"  constructor(px, py, bgFn) { this.paddingX = px; this.paddingY = py; this.bgFn = bgFn; }",
		"  addChild(c) { this.children.push(c); }",
		"  render(w) { return this.children.flatMap(c => c.render(w)); }",
		"}",
		"class Text {",
		"  constructor(text, px, py) { this.text = text; this.paddingX = px ?? 0; this.paddingY = py ?? 0; }",
		"  render(w) { return [this.text]; }",
		"}",
		"module.exports = { Box, Text };",
	].join("\n"), "utf-8");

	const moduleWithResolver = Module as typeof Module & {
		_resolveFilename: (request: string, parent?: unknown, isMain?: boolean, options?: unknown) => string;
	};
	const originalResolveFilename = moduleWithResolver._resolveFilename;
	moduleWithResolver._resolveFilename = function resolveFilename(request, parent, isMain, options): string {
		if (request === "@mariozechner/pi-coding-agent") {
			return sdkPath;
		}
		if (request === "@mariozechner/pi-tui") {
			return tuiPath;
		}
		return originalResolveFilename.call(this, request, parent, isMain, options);
	};
}

function testFormatSkillsForPrompt(skills: Skill[]): string {
	const visibleSkills = skills.filter((s) => !s.disableModelInvocation);
	if (visibleSkills.length === 0) return "";
	const lines = [
		"\n\nThe following skills provide specialized instructions for specific tasks.",
		"Use the read tool to load a skill's file when the task matches its description.",
		"When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
		"",
		"<available_skills>",
	];
	for (const skill of visibleSkills) {
		lines.push("  <skill>");
		lines.push(`    <name>${escapeXml(skill.name)}</name>`);
		lines.push(`    <description>${escapeXml(skill.description)}</description>`);
		lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
		lines.push("  </skill>");
	}
	lines.push("</available_skills>");
	return lines.join("\n");
}

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/\"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

function skill(name: string, description: string, overrides: Partial<Skill> = {}): Skill {
	return {
		name,
		description,
		filePath: `/repo/skills/${name}/SKILL.md`,
		baseDir: `/repo/skills/${name}`,
		sourceInfo: {} as Skill["sourceInfo"],
		disableModelInvocation: false,
		...overrides,
	};
}

function config(overrides: Partial<PruningConfig["skills"]> = {}, mode: PruningConfig["mode"] = "auto", toolsOverrides?: Partial<PruningConfig["tools"]>): PruningConfig {
	const result: PruningConfig = {
		mode,
		model: "gpt-5.4-mini",
		provider: "github-copilot",
		thinkingLevel: "minimal",
		skills: { strategy: "discretion", ceiling: 8, pinned: [], alwaysKeep: [], ...overrides },
	};
	if (toolsOverrides) {
		result.tools = {
			strategy: toolsOverrides.strategy ?? "discretion",
			ceiling: toolsOverrides.ceiling ?? 10,
			dependencies: { edit: ["read"], subagent: ["bash"], ...(toolsOverrides?.dependencies ?? {}) },
			alwaysKeep: toolsOverrides.alwaysKeep ?? [],
		};
	}
	return result;
}

type Handler = (event: any, ctx: any) => unknown | Promise<unknown>;

type RegisterResult = {
	handlers: Map<string, Handler>;
	registeredTools: Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>;
	registeredRenderers: Map<string, (...args: any[]) => any>;
	sentMessages: any[];
};

function register(configOverride: PruningConfig, logPath = path.join(mkdtempSync(path.join(tmpdir(), "skill-pruner-integration-")), "pruning.jsonl")): RegisterResult {
	resetForTesting();
	clearPruningTrackingForTesting();
	setLogPathForTesting(logPath);
	setConfigForTesting(configOverride);
	__setFormatter(testFormatSkillsForPrompt);
	const handlers = new Map<string, Handler>();
	const registeredTools: Map<string, { execute: (...args: unknown[]) => Promise<unknown> }> = new Map();
	const registeredRenderers = new Map<string, (...args: any[]) => any>();
	const sentMessages: any[] = [];
	const pi = {
		on(eventName: string, handler: Handler) {
			handlers.set(eventName, handler);
		},
		registerMessageRenderer(customType: string, renderer: any) {
			registeredRenderers.set(customType, renderer);
		},
		registerTool(toolDef: { name: string; execute?: (...args: unknown[]) => Promise<unknown> }) {
			if (toolDef.execute) {
				registeredTools.set(toolDef.name, toolDef as { execute: (...args: unknown[]) => Promise<unknown> });
			}
		},
		getAllTools: () => [] as ToolInfo[],
		getActiveTools: () => [] as string[],
		setActiveTools: (_names: string[]) => {},
		sendMessage: (message: any) => { sentMessages.push(message); },
	} as unknown as ExtensionAPI;
	skillPruner(pi);
	return { handlers, registeredTools, registeredRenderers, sentMessages };
}

function systemPrompt(skills: Skill[]): string {
	return `Base prompt.${testFormatSkillsForPrompt(skills)}\nCurrent date: 2026-05-16`;
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
	}, { cwd: "/repo", sessionManager: { getSessionId: () => "session-1" } });
}

function mockCompleteFn(response: { skills: string[]; tools?: string[] }) {
	return async () => ({ text: JSON.stringify({ skills: response.skills, tools: response.tools ?? [] }) });
}

const realisticSkills = [
	skill("code-simplification", "Simplifies code for clarity. Use when refactoring code for clarity, reducing complexity. Do not use when adding new features."),
	skill("duckdb-query-optimization", "Guides DuckDB query performance tuning. Use when queries against analytics databases are slow, writing new analytics queries. Do not use for general SQL questions."),
	skill("frontend-design", "Production-grade frontend interfaces. Use when building UI components, pages, or visual applications. Do not use for backend logic."),
];

const mockToolInfo = [
	{ name: "read", description: "Read file contents", parameters: { type: "object", properties: {} } },
	{ name: "edit", description: "Edit a file using exact text replacement", parameters: { type: "object", properties: {} } },
	{ name: "bash", description: "Execute a bash command", parameters: { type: "object", properties: {} } },
	{ name: "subagent", description: "Delegate tasks to specialized subagents", parameters: { type: "object", properties: {} } },
	{ name: "web_search", description: "Search the web for information", parameters: { type: "object", properties: {} } },
];

// ---------------------------------------------------------------------------
// Model-surface fidelity tests
// These assert that the final pruning state matches (or transparently
// deviates from) the intent expressed by the pruning LLM.
// ---------------------------------------------------------------------------

test("model returns only unknown skill names → fail-open keeps all skills and reports reason", async () => {
	__setCompleteFn(mockCompleteFn({ skills: ["nonexistent-skill"], tools: [] }));
	try {
		const { handlers } = register(config());
		const result = await runBeforeAgentStart(handlers, "anything", realisticSkills) as { systemPrompt?: string; message?: any } | undefined;

		assert.ok(result?.systemPrompt);
		// Fail-open: all skills should be present
		assert.match(result.systemPrompt, /<name>code-simplification<\/name>/);
		assert.match(result.systemPrompt, /<name>duckdb-query-optimization<\/name>/);
		assert.match(result.systemPrompt, /<name>frontend-design<\/name>/);

		assert.ok(result?.message, "feedback message should explain the deviation");
		assert.equal(result.message.customType, "pruning-result");
		const details = result.message.details;
		assert.ok(details.prepassFailOpenReason, "prepassFailOpenReason should be populated when model intent was overridden");
		assert.ok(String(details.prepassFailOpenReason).includes("skill"), "reason should mention skills");
	} finally {
		__setCompleteFn(null);
	}
});

test("model returns only unknown tool names → fail-open keeps all tools and reports reason", async () => {
	__setCompleteFn(mockCompleteFn({ skills: [], tools: ["nonexistent-tool"] }));
	try {
		const { handlers } = register(config({}, "auto", { ceiling: 10 }));
		__setToolSeams({
			getAllTools: () => mockToolInfo as any[],
			getActiveTools: () => mockToolInfo.map((t) => t.name),
			setActiveTools: () => {},
		});

		const result = await runBeforeAgentStart(handlers, "anything", realisticSkills) as { systemPrompt?: string; message?: any } | undefined;

		// Fail-open: all tools should be reported as included
		assert.ok(result?.message, "feedback message should explain the deviation");
		const details = result.message.details;
		assert.deepEqual(details.includedTools.sort(), mockToolInfo.map((t) => t.name).sort());
		assert.equal(details.excludedTools.length, 0);
		assert.ok(details.prepassFailOpenReason, "prepassFailOpenReason should be populated when model intent was overridden");
		assert.ok(String(details.prepassFailOpenReason).includes("tool"), "reason should mention tools");
	} finally {
		__setCompleteFn(null);
		__setToolSeams({ getAllTools: null, getActiveTools: null, setActiveTools: null });
	}
});

test("model explicitly empties skills and returns unknown tools → skills honored, tools fail-open with reason", async () => {
	__setCompleteFn(async () => ({ text: '{"skills":[],"tools":["nonexistent-tool"]}' }));
	try {
		const { handlers } = register(config({}, "auto", { ceiling: 10 }));
		__setToolSeams({
			getAllTools: () => mockToolInfo as any[],
			getActiveTools: () => mockToolInfo.map((t) => t.name),
			setActiveTools: () => {},
		});

		const result = await runBeforeAgentStart(handlers, "anything", realisticSkills) as { systemPrompt?: string; message?: any } | undefined;

		assert.ok(result?.systemPrompt);
		// Skills explicitly empty → no skills in prompt
		assert.doesNotMatch(result.systemPrompt, /<name>code-simplification<\/name>/);
		assert.doesNotMatch(result.systemPrompt, /<name>duckdb-query-optimization<\/name>/);
		assert.doesNotMatch(result.systemPrompt, /<name>frontend-design<\/name>/);

		// Tools fail-open
		assert.ok(result?.message);
		const details = result.message.details;
		assert.deepEqual(details.includedTools.sort(), mockToolInfo.map((t) => t.name).sort());
		assert.equal(details.excludedTools.length, 0);
		assert.ok(details.prepassFailOpenReason, "prepassFailOpenReason should explain tool fail-open");
	} finally {
		__setCompleteFn(null);
		__setToolSeams({ getAllTools: null, getActiveTools: null, setActiveTools: null });
	}
});

test("model returns explicitly empty for both categories → fail-open for both with reason", async () => {
	__setCompleteFn(async () => ({ text: '{"skills":[],"tools":[]}' }));
	try {
		const { handlers } = register(config({}, "auto", { ceiling: 10 }));
		__setToolSeams({
			getAllTools: () => mockToolInfo as any[],
			getActiveTools: () => mockToolInfo.map((t) => t.name),
			setActiveTools: () => {},
		});

		const result = await runBeforeAgentStart(handlers, "anything", realisticSkills) as { systemPrompt?: string; message?: any } | undefined;

		// Both explicitly empty triggers fail-open for both
		assert.ok(result?.systemPrompt);
		assert.match(result.systemPrompt, /<name>code-simplification<\/name>/);
		assert.match(result.systemPrompt, /<name>duckdb-query-optimization<\/name>/);
		assert.match(result.systemPrompt, /<name>frontend-design<\/name>/);

		assert.ok(result?.message);
		const details = result.message.details;
		assert.deepEqual(details.includedTools.sort(), mockToolInfo.map((t) => t.name).sort());
		assert.equal(details.excludedTools.length, 0);
		assert.ok(details.prepassFailOpenReason, "prepassFailOpenReason should explain both-category fail-open");
	} finally {
		__setCompleteFn(null);
		__setToolSeams({ getAllTools: null, getActiveTools: null, setActiveTools: null });
	}
});

test("model returns mixed known and unknown skill names → known kept, unknown dropped, no fail-open", async () => {
	__setCompleteFn(mockCompleteFn({ skills: ["code-simplification", "nonexistent-skill"], tools: [] }));
	try {
		const { handlers } = register(config());
		const result = await runBeforeAgentStart(handlers, "refactor", realisticSkills) as { systemPrompt?: string; message?: any } | undefined;

		assert.ok(result?.systemPrompt);
		assert.match(result.systemPrompt, /<name>code-simplification<\/name>/);
		assert.doesNotMatch(result.systemPrompt, /<name>duckdb-query-optimization<\/name>/);
		assert.doesNotMatch(result.systemPrompt, /<name>frontend-design<\/name>/);

		assert.ok(result?.message);
		const details = result.message.details;
		// No fail-open because at least one known skill was selected
		assert.equal(details.prepassFailOpenReason, undefined);
	} finally {
		__setCompleteFn(null);
	}
});

test("model returns valid tool selection → setActiveTools matches model intent exactly (plus dependencies)", async () => {
	const setActiveToolsCalls: string[][] = [];
	__setCompleteFn(mockCompleteFn({ skills: [], tools: ["edit", "bash"] }));
	try {
		const { handlers } = register(config({}, "auto", { ceiling: 10, dependencies: {} }));
		__setToolSeams({
			getAllTools: () => mockToolInfo as any[],
			getActiveTools: () => mockToolInfo.map((t) => t.name),
			setActiveTools: (names: string[]) => { setActiveToolsCalls.push(names); },
		});

		await runBeforeAgentStart(handlers, "edit and run", realisticSkills);

		assert.ok(setActiveToolsCalls.length > 0);
		const active = setActiveToolsCalls[0];
		assert.ok(active.includes("edit"));
		assert.ok(active.includes("bash"));
		assert.ok(!active.includes("web_search"));
		assert.ok(!active.includes("subagent"));
	} finally {
		__setCompleteFn(null);
		__setToolSeams({ getAllTools: null, getActiveTools: null, setActiveTools: null });
	}
});

test("model returns tool selection with dependencies → dependencies are auto-included even if model omitted them", async () => {
	const setActiveToolsCalls: string[][] = [];
	__setCompleteFn(mockCompleteFn({ skills: [], tools: ["edit", "subagent"] }));
	try {
		const { handlers } = register(config({}, "auto", { ceiling: 10, dependencies: { edit: ["read"], subagent: ["bash"] } }));
		__setToolSeams({
			getAllTools: () => mockToolInfo as any[],
			getActiveTools: () => mockToolInfo.map((t) => t.name),
			setActiveTools: (names: string[]) => { setActiveToolsCalls.push(names); },
		});

		await runBeforeAgentStart(handlers, "edit and delegate", realisticSkills);

		assert.ok(setActiveToolsCalls.length > 0);
		const active = setActiveToolsCalls[0];
		assert.ok(active.includes("edit"));
		assert.ok(active.includes("read"), "read should be included as dependency of edit");
		assert.ok(active.includes("subagent"));
		assert.ok(active.includes("bash"), "bash should be included as dependency of subagent");
		assert.ok(!active.includes("web_search"));
	} finally {
		__setCompleteFn(null);
		__setToolSeams({ getAllTools: null, getActiveTools: null, setActiveTools: null });
	}
});

test("model returns fewer skills than ceiling → all model selections honored, no extras", async () => {
	__setCompleteFn(mockCompleteFn({ skills: ["code-simplification"], tools: [] }));
	try {
		const { handlers } = register(config({ ceiling: 5 }));
		const result = await runBeforeAgentStart(handlers, "refactor", realisticSkills) as { systemPrompt?: string } | undefined;

		assert.ok(result?.systemPrompt);
		assert.match(result.systemPrompt, /<name>code-simplification<\/name>/);
		assert.doesNotMatch(result.systemPrompt, /<name>duckdb-query-optimization<\/name>/);
		assert.doesNotMatch(result.systemPrompt, /<name>frontend-design<\/name>/);
	} finally {
		__setCompleteFn(null);
	}
});

test("model excludes a pinned skill → pinned skill is still included, respecting model for rest", async () => {
	__setCompleteFn(mockCompleteFn({ skills: ["duckdb-query-optimization"], tools: [] }));
	try {
		const { handlers } = register(config({ pinned: ["code-simplification"] }));
		const result = await runBeforeAgentStart(handlers, "query optimization", realisticSkills) as { systemPrompt?: string } | undefined;

		assert.ok(result?.systemPrompt);
		assert.match(result.systemPrompt, /<name>code-simplification<\/name>/);
		assert.match(result.systemPrompt, /<name>duckdb-query-optimization<\/name>/);
		assert.doesNotMatch(result.systemPrompt, /<name>frontend-design<\/name>/);
	} finally {
		__setCompleteFn(null);
	}
});

test("model excludes an always-keep tool → always-keep tool is still included, respecting model for rest", async () => {
	const setActiveToolsCalls: string[][] = [];
	__setCompleteFn(mockCompleteFn({ skills: [], tools: ["edit"] }));
	try {
		const { handlers } = register(config({}, "auto", { ceiling: 10, alwaysKeep: ["web_search"] }));
		__setToolSeams({
			getAllTools: () => mockToolInfo as any[],
			getActiveTools: () => mockToolInfo.map((t) => t.name),
			setActiveTools: (names: string[]) => { setActiveToolsCalls.push(names); },
		});

		await runBeforeAgentStart(handlers, "edit files", realisticSkills);

		assert.ok(setActiveToolsCalls.length > 0);
		const active = setActiveToolsCalls[0];
		assert.ok(active.includes("edit"));
		assert.ok(active.includes("web_search"), "always-keep tool should survive");
		assert.ok(!active.includes("subagent"));
	} finally {
		__setCompleteFn(null);
		__setToolSeams({ getAllTools: null, getActiveTools: null, setActiveTools: null });
	}
});

test("model returns tool selection but no tools config exists → tool intent is silently discarded (model-surface gap)", async () => {
	const setActiveToolsCalls: string[][] = [];
	__setCompleteFn(mockCompleteFn({ skills: ["code-simplification"], tools: ["edit", "bash"] }));
	try {
		// config() without toolsOverrides produces a PruningConfig with NO tools field
		const { handlers } = register(config());
		__setToolSeams({
			getAllTools: () => mockToolInfo as any[],
			getActiveTools: () => mockToolInfo.map((t) => t.name),
			setActiveTools: (names: string[]) => { setActiveToolsCalls.push(names); },
		});

		const result = await runBeforeAgentStart(handlers, "edit and run", realisticSkills) as { systemPrompt?: string; message?: any } | undefined;

		assert.ok(result?.systemPrompt);
		assert.match(result.systemPrompt, /<name>code-simplification<\/name>/);

		// Because activeConfig.tools is undefined, the model's tool selections are ignored
		assert.equal(setActiveToolsCalls.length, 0, "setActiveTools should NOT be called when tools config is absent");
	} finally {
		__setCompleteFn(null);
		__setToolSeams({ getAllTools: null, getActiveTools: null, setActiveTools: null });
	}
});

test("model returns skill selection but no skills in session → tool intent still applied if tools config present", async () => {
	const setActiveToolsCalls: string[][] = [];
	__setCompleteFn(mockCompleteFn({ skills: ["nonexistent-skill"], tools: ["edit", "bash"] }));
	try {
		const { handlers } = register(config({}, "auto", { ceiling: 10, dependencies: {} }));
		__setToolSeams({
			getAllTools: () => mockToolInfo as any[],
			getActiveTools: () => mockToolInfo.map((t) => t.name),
			setActiveTools: (names: string[]) => { setActiveToolsCalls.push(names); },
		});

		await runBeforeAgentStart(handlers, "edit and run", []);

		assert.ok(setActiveToolsCalls.length > 0);
		const active = setActiveToolsCalls[0];
		assert.ok(active.includes("edit"));
		assert.ok(active.includes("bash"));
		assert.ok(!active.includes("web_search"));
	} finally {
		__setCompleteFn(null);
		__setToolSeams({ getAllTools: null, getActiveTools: null, setActiveTools: null });
	}
});

test("shadow mode: model intent is measured but not applied → feedback still reports model intent", async () => {
	const setActiveToolsCalls: string[][] = [];
	__setCompleteFn(mockCompleteFn({ skills: ["code-simplification"], tools: ["edit"] }));
	try {
		const { handlers } = register(config({}, "shadow", { ceiling: 10 }));
		__setToolSeams({
			getAllTools: () => mockToolInfo as any[],
			getActiveTools: () => mockToolInfo.map((t) => t.name),
			setActiveTools: (names: string[]) => { setActiveToolsCalls.push(names); },
		});

		const originalPrompt = systemPrompt(realisticSkills);
		const result = await runBeforeAgentStart(handlers, "refactor", realisticSkills, originalPrompt) as { systemPrompt?: string; message?: any } | undefined;

		assert.equal(result?.systemPrompt, originalPrompt);
		assert.equal(setActiveToolsCalls.length, 0);

		assert.ok(result?.message);
		const details = result.message.details;
		assert.deepEqual(details.includedSkills, ["code-simplification"]);
		assert.deepEqual(details.excludedSkills, ["duckdb-query-optimization", "frontend-design"]);
		assert.deepEqual(details.includedTools, ["edit", "read"]);
		assert.deepEqual(details.excludedTools, ["bash", "subagent", "web_search"]);
	} finally {
		__setCompleteFn(null);
		__setToolSeams({ getAllTools: null, getActiveTools: null, setActiveTools: null });
	}
});

test("fail-open reason is absent when model intent is honored exactly", async () => {
	__setCompleteFn(mockCompleteFn({ skills: ["code-simplification"], tools: [] }));
	try {
		const { handlers } = register(config());
		const result = await runBeforeAgentStart(handlers, "refactor", realisticSkills) as { systemPrompt?: string; message?: any } | undefined;

		assert.ok(result?.message);
		const details = result.message.details;
		assert.equal(details.prepassFailOpenReason, undefined, "no fail-open reason when model intent is honored");
	} finally {
		__setCompleteFn(null);
	}
});
