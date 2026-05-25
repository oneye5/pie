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
	const mockDir = mkdtempSync(path.join(tmpdir(), "skill-pruner-sdk-mock-"));

	// Mock pi-coding-agent SDK
	const sdkPath = path.join(mockDir, "pi-coding-agent.cjs");
	writeFileSync(sdkPath, "exports.formatSkillsForPrompt = () => { throw new Error('test must call __setFormatter'); };\n", "utf-8");

	// Mock pi-tui
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

// ---------------------------------------------------------------------------
// Shared test-double for formatSkillsForPrompt.
// ---------------------------------------------------------------------------
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
		skills: { strategy: "discretion", ceiling: 8, pinned: [], ...overrides },
	};
	if (toolsOverrides) {
		result.tools = {
			strategy: toolsOverrides.strategy ?? "discretion",
			ceiling: toolsOverrides.ceiling ?? 10,
			dependencies: { edit: ["read"], subagent: ["bash"], ...(toolsOverrides?.dependencies ?? {}) },
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

/** Create a mock LLM completion function that returns a fixed response. */
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
// LLM-based pruning tests
// ---------------------------------------------------------------------------

test("discretion mode: LLM selects subset → only those skills included", async () => {
	__setCompleteFn(mockCompleteFn({ skills: ["code-simplification"], tools: [] }));
	try {
		const { handlers } = register(config());
		const result = await runBeforeAgentStart(handlers, "Refactor this code for clarity", realisticSkills) as { systemPrompt?: string } | undefined;

		assert.ok(result?.systemPrompt);
		assert.match(result.systemPrompt, /<name>code-simplification<\/name>/);
		assert.doesNotMatch(result.systemPrompt, /<name>duckdb-query-optimization<\/name>/);
		assert.doesNotMatch(result.systemPrompt, /<name>frontend-design<\/name>/);
		assert.match(result.systemPrompt, /Pruned skills .*duckdb-query-optimization/);
	} finally {
		__setCompleteFn(null);
	}
});

test("discretion mode: LLM returns empty for both skills and tools → fails open (all included)", async () => {
	__setCompleteFn(mockCompleteFn({ skills: [], tools: [] }));
	try {
		const { handlers } = register(config({ pinned: ["frontend-design"] }));
		const result = await runBeforeAgentStart(handlers, "simple question", realisticSkills) as { systemPrompt?: string } | undefined;

		// Fail-open: when LLM returns empty for both skills and tools,
		// treat as a failed prepass and keep everything.
		assert.ok(result?.systemPrompt);
		assert.match(result.systemPrompt, /<name>frontend-design<\/name>/);
		assert.match(result.systemPrompt, /<name>code-simplification<\/name>/);
		assert.match(result.systemPrompt, /<name>duckdb-query-optimization<\/name>/);
	} finally {
		__setCompleteFn(null);
	}
});

test("ceiling enforced even if LLM returns more skills", async () => {
	__setCompleteFn(mockCompleteFn({ skills: ["code-simplification", "duckdb-query-optimization", "frontend-design"], tools: [] }));
	try {
		const { handlers } = register(config({ ceiling: 2 }));
		const result = await runBeforeAgentStart(handlers, "do everything", realisticSkills) as { systemPrompt?: string } | undefined;

		assert.ok(result?.systemPrompt);
		const matches = result.systemPrompt.match(/<name>[^<]+<\/name>/g) ?? [];
		assert.ok(matches.length <= 2, `ceiling should limit to 2 skills, got ${matches.length}`);
	} finally {
		__setCompleteFn(null);
	}
});

test("pinned skills always included regardless of LLM output", async () => {
	__setCompleteFn(mockCompleteFn({ skills: ["duckdb-query-optimization"], tools: [] }));
	try {
		const { handlers } = register(config({ pinned: ["code-simplification"] }));
		const result = await runBeforeAgentStart(handlers, "query optimization", realisticSkills) as { systemPrompt?: string } | undefined;

		assert.ok(result?.systemPrompt);
		assert.match(result.systemPrompt, /<name>code-simplification<\/name>/);
		assert.match(result.systemPrompt, /<name>duckdb-query-optimization<\/name>/);
	} finally {
		__setCompleteFn(null);
	}
});

test("LLM failure → graceful fallback (all skills included)", async () => {
	__setCompleteFn(async () => { throw new Error("model unavailable"); });
	const origWarn = console.warn;
	const warnings: string[] = [];
	console.warn = (m?: unknown) => { warnings.push(String(m)); };
	try {
		const { handlers } = register(config());
		const result = await runBeforeAgentStart(handlers, "anything", realisticSkills) as { systemPrompt?: string } | undefined;

		assert.ok(result?.systemPrompt);
		assert.match(result.systemPrompt, /<name>code-simplification<\/name>/);
		assert.match(result.systemPrompt, /<name>duckdb-query-optimization<\/name>/);
		assert.match(result.systemPrompt, /<name>frontend-design<\/name>/);
		assert.ok(warnings.some((w) => w.includes("LLM pruning failed")));
	} finally {
		console.warn = origWarn;
		__setCompleteFn(null);
	}
});

test("empty skills array produces no modification", async () => {
	__setCompleteFn(mockCompleteFn({ skills: [], tools: [] }));
	try {
		const { handlers } = register(config());
		const result = await runBeforeAgentStart(handlers, "anything", [], "Base prompt without skills");
		assert.equal(result, undefined);
	} finally {
		__setCompleteFn(null);
	}
});

test("regex no-match case fails open with original prompt unchanged", async () => {
	__setCompleteFn(mockCompleteFn({ skills: ["code-simplification"], tools: [] }));
	try {
		const { handlers } = register(config());
		const result = await runBeforeAgentStart(handlers, "Refactor code", realisticSkills, "Base prompt without the skills block");
		assert.equal(result, undefined);
	} finally {
		__setCompleteFn(null);
	}
});

test("tool dependencies honored", async () => {
	const setActiveToolsCalls: string[][] = [];
	__setCompleteFn(mockCompleteFn({ skills: ["code-simplification"], tools: ["edit", "subagent"] }));
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
	} finally {
		__setCompleteFn(null);
		__setToolSeams({ getAllTools: null, getActiveTools: null, setActiveTools: null });
	}
});

test("shadow mode leaves prompt unchanged and logs decision", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "skill-pruner-integration-"));
	const logPath = path.join(dir, "pruning.jsonl");
	__setCompleteFn(mockCompleteFn({ skills: ["code-simplification"], tools: [] }));
	try {
		const { handlers } = register(config({}, "shadow"), logPath);
		const originalPrompt = systemPrompt(realisticSkills);
		const result = await runBeforeAgentStart(handlers, "Refactor this code for clarity", realisticSkills, originalPrompt) as { systemPrompt?: string } | undefined;

		assert.equal(result?.systemPrompt, originalPrompt);

		const lines = readFileSync(logPath, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
		assert.equal(lines[0].mode, "shadow");
		assert.ok(lines[0].excluded.includes("duckdb-query-optimization"));
	} finally {
		__setCompleteFn(null);
		setLogPathForTesting(null);
		clearPruningTrackingForTesting();
	}
});

test("shadow mode: skill read of pruned skill → shadow_miss_candidate", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "skill-pruner-integration-"));
	const logPath = path.join(dir, "pruning.jsonl");
	__setCompleteFn(mockCompleteFn({ skills: ["code-simplification"], tools: [] }));
	try {
		const { handlers } = register(config({}, "shadow"), logPath);
		await runBeforeAgentStart(handlers, "Refactor this code for clarity", realisticSkills);

		const toolHandler = handlers.get("tool_call");
		assert.ok(toolHandler);
		await toolHandler({
			type: "tool_call", toolCallId: "1", toolName: "read",
			input: { path: "/repo/skills/duckdb-query-optimization/SKILL.md" },
		}, { cwd: "/repo", sessionManager: { getSessionId: () => "session-1" } });

		const lines = readFileSync(logPath, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
		assert.ok(lines.some((line) => line.event === "shadow_miss_candidate" && line.skillName === "duckdb-query-optimization"));
	} finally {
		__setCompleteFn(null);
		setLogPathForTesting(null);
		clearPruningTrackingForTesting();
	}
});

test("auto mode: pruned skill read → skill_miss; included skill read → skill_read", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "skill-pruner-integration-"));
	const logPath = path.join(dir, "pruning.jsonl");
	__setCompleteFn(mockCompleteFn({ skills: ["code-simplification"], tools: [] }));
	try {
		const { handlers } = register(config(), logPath);
		await runBeforeAgentStart(handlers, "Refactor this code for clarity", realisticSkills);

		const toolHandler = handlers.get("tool_call");
		assert.ok(toolHandler);

		await toolHandler({
			type: "tool_call", toolCallId: "1", toolName: "read",
			input: { path: "/repo/skills/duckdb-query-optimization/SKILL.md" },
		}, { cwd: "/repo", sessionManager: { getSessionId: () => "session-1" } });

		await toolHandler({
			type: "tool_call", toolCallId: "2", toolName: "read",
			input: { path: "/repo/skills/code-simplification/SKILL.md" },
		}, { cwd: "/repo", sessionManager: { getSessionId: () => "session-1" } });

		const lines = readFileSync(logPath, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
		assert.ok(lines.some((line) => line.event === "skill_miss" && line.skillName === "duckdb-query-optimization"));
		assert.ok(lines.some((line) => line.event === "skill_read" && line.skillName === "code-simplification"));
	} finally {
		__setCompleteFn(null);
		setLogPathForTesting(null);
		clearPruningTrackingForTesting();
	}
});

test("disabled skill excluded from LLM consideration", async () => {
	const disabledSkill = skill("disabled-helper", "Use when disabled things happen.", { disableModelInvocation: true });
	const enabledSkills = [
		skill("alpha-tool", "Use when alpha beta."),
		skill("gamma-tool", "Use when gamma delta."),
	];
	const allSkills = [disabledSkill, ...enabledSkills];

	__setCompleteFn(mockCompleteFn({ skills: ["alpha-tool", "gamma-tool"], tools: [] }));
	try {
		const { handlers } = register(config());
		const result = await runBeforeAgentStart(handlers, "alpha beta", allSkills) as { systemPrompt?: string } | undefined;

		assert.ok(result?.systemPrompt);
		assert.doesNotMatch(result.systemPrompt, /<name>disabled-helper<\/name>/);
		assert.match(result.systemPrompt, /<name>alpha-tool<\/name>/);
		assert.match(result.systemPrompt, /<name>gamma-tool<\/name>/);
	} finally {
		__setCompleteFn(null);
	}
});

test("input handler always continues", async () => {
	const { handlers } = register(config());
	const handler = handlers.get("input");
	assert.ok(handler, "input handler registered");
	assert.deepEqual(await handler({ type: "input", text: "hello", source: "interactive" }, { cwd: "/repo" }), { action: "continue" });
});

test("off mode baseline: known skill read → skill_read; non-skill read → no event", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "skill-pruner-integration-"));
	const logPath = path.join(dir, "pruning.jsonl");
	try {
		const { handlers } = register(config({}, "off"), logPath);
		await runBeforeAgentStart(handlers, "anything", realisticSkills);

		const toolHandler = handlers.get("tool_call");
		assert.ok(toolHandler);

		await toolHandler({
			type: "tool_call", toolCallId: "1", toolName: "read",
			input: { path: "/repo/skills/code-simplification/SKILL.md" },
		}, { cwd: "/repo", sessionManager: { getSessionId: () => "session-1" } });

		await toolHandler({
			type: "tool_call", toolCallId: "2", toolName: "read",
			input: { path: "/repo/src/index.ts" },
		}, { cwd: "/repo", sessionManager: { getSessionId: () => "session-1" } });

		const lines = readFileSync(logPath, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
		assert.ok(lines.some((line) => line.event === "skill_read" && line.skillName === "code-simplification"));
		assert.ok(!lines.some((line) => line.skillName === "src/index" || line.skillName === "index"));
	} finally {
		setLogPathForTesting(null);
		clearPruningTrackingForTesting();
	}
});

test("tool_call safely ignores read events with non-string path", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "skill-pruner-integration-"));
	const logPath = path.join(dir, "pruning.jsonl");
	try {
		const { handlers } = register(config({}, "off"), logPath);
		await runBeforeAgentStart(handlers, "anything", realisticSkills);

		const toolHandler = handlers.get("tool_call");
		assert.ok(toolHandler);
		await toolHandler({
			type: "tool_call", toolCallId: "1", toolName: "read",
			input: { path: 123 },
		}, { cwd: "/repo", sessionManager: { getSessionId: () => "session-1" } });

		assert.equal(existsSync(logPath), false);
	} finally {
		setLogPathForTesting(null);
		clearPruningTrackingForTesting();
	}
});

test("tool_call catches unexpected context errors and continues", async () => {
	const warnings: string[] = [];
	const originalWarn = console.warn;
	console.warn = (m?: unknown) => { warnings.push(String(m)); };
	try {
		const { handlers } = register(config({}, "off"));
		await runBeforeAgentStart(handlers, "anything", realisticSkills);
		const toolHandler = handlers.get("tool_call");
		assert.ok(toolHandler);

		await toolHandler({
			type: "tool_call", toolCallId: "1", toolName: "read",
			input: { path: "/repo/skills/code-simplification/SKILL.md" },
		}, {
			cwd: "/repo",
			sessionManager: { getSessionId() { throw new Error("boom"); } },
		});

		assert.ok(warnings.some((warning) => warning.includes("failed to record skill read: boom")));
	} finally {
		console.warn = originalWarn;
	}
});

test("tool pruning in auto mode calls setActiveTools with LLM selections", async () => {
	const setActiveToolsCalls: string[][] = [];
	__setCompleteFn(mockCompleteFn({ skills: ["code-simplification"], tools: ["read", "edit", "bash"] }));
	try {
		const { handlers } = register(config({}, "auto", { ceiling: 10 }));
		__setToolSeams({
			getAllTools: () => mockToolInfo as any[],
			getActiveTools: () => mockToolInfo.map((t) => t.name),
			setActiveTools: (names: string[]) => { setActiveToolsCalls.push(names); },
		});
		await runBeforeAgentStart(handlers, "edit some code", realisticSkills);
		assert.ok(setActiveToolsCalls.length > 0, "setActiveTools should have been called");
		assert.ok(setActiveToolsCalls[0].includes("read"));
		assert.ok(setActiveToolsCalls[0].includes("edit"));
		assert.ok(!setActiveToolsCalls[0].includes("web_search"));
	} finally {
		__setCompleteFn(null);
		__setToolSeams({ getAllTools: null, getActiveTools: null, setActiveTools: null });
	}
});

test("tool pruning in shadow mode does not call setActiveTools", async () => {
	const setActiveToolsCalls: string[][] = [];
	__setCompleteFn(mockCompleteFn({ skills: ["code-simplification"], tools: ["read", "edit"] }));
	try {
		const { handlers } = register(config({}, "shadow", { ceiling: 10 }));
		__setToolSeams({
			getAllTools: () => mockToolInfo as any[],
			getActiveTools: () => mockToolInfo.map((t) => t.name),
			setActiveTools: (names: string[]) => { setActiveToolsCalls.push(names); },
		});
		await runBeforeAgentStart(handlers, "edit some code", realisticSkills);
		assert.equal(setActiveToolsCalls.length, 0, "setActiveTools should NOT be called in shadow mode");
	} finally {
		__setCompleteFn(null);
		__setToolSeams({ getAllTools: null, getActiveTools: null, setActiveTools: null });
	}
});

test("tool pruning without tools config does not call setActiveTools", async () => {
	const setActiveToolsCalls: string[][] = [];
	__setCompleteFn(mockCompleteFn({ skills: ["code-simplification"], tools: ["read"] }));
	try {
		const { handlers } = register(config()); // no tools config
		__setToolSeams({
			getAllTools: () => mockToolInfo as any[],
			getActiveTools: () => mockToolInfo.map((t) => t.name),
			setActiveTools: (names: string[]) => { setActiveToolsCalls.push(names); },
		});
		await runBeforeAgentStart(handlers, "edit some code", realisticSkills);
		assert.equal(setActiveToolsCalls.length, 0);
	} finally {
		__setCompleteFn(null);
		__setToolSeams({ getAllTools: null, getActiveTools: null, setActiveTools: null });
	}
});

test("request_tool recovery tool is registered", async () => {
	const { registeredTools } = register(config());
	assert.ok(registeredTools.has("request_tool"));
});

test("request_tool execute enables a pruned tool", async () => {
	const setActiveToolsCalls: string[][] = [];
	const { registeredTools } = register(config({}, "auto", { ceiling: 3 }));
	const toolDef = registeredTools.get("request_tool");
	assert.ok(toolDef);

	__setToolSeams({
		getAllTools: () => mockToolInfo as any[],
		getActiveTools: () => ["read", "edit", "bash"],
		setActiveTools: (names: string[]) => { setActiveToolsCalls.push(names); },
	});

	try {
		const result = await toolDef.execute("call-1", { toolName: "web_search" }, undefined, undefined, undefined) as any;
		assert.ok(result.content[0].text.includes("web_search"));
		assert.ok(setActiveToolsCalls[0].includes("web_search"));
	} finally {
		__setToolSeams({ getAllTools: null, getActiveTools: null, setActiveTools: null });
	}
});

test("request_tool execute returns error for unknown tool name", async () => {
	const { registeredTools } = register(config({}, "auto", { ceiling: 3 }));
	const toolDef = registeredTools.get("request_tool");
	assert.ok(toolDef);

	__setToolSeams({
		getAllTools: () => mockToolInfo as any[],
		getActiveTools: () => ["read", "edit", "bash"],
		setActiveTools: () => {},
	});

	try {
		const result = await toolDef.execute("call-2", { toolName: "nonexistent_tool" }, undefined, undefined, undefined) as any;
		assert.equal(result.isError, true);
	} finally {
		__setToolSeams({ getAllTools: null, getActiveTools: null, setActiveTools: null });
	}
});

test("request_tool execute returns message when tool is already active", async () => {
	const { registeredTools } = register(config({}, "auto", { ceiling: 3 }));
	const toolDef = registeredTools.get("request_tool");
	assert.ok(toolDef);

	__setToolSeams({
		getAllTools: () => mockToolInfo as any[],
		getActiveTools: () => ["read", "edit", "bash", "web_search"],
		setActiveTools: () => {},
	});

	try {
		const result = await toolDef.execute("call-3", { toolName: "web_search" }, undefined, undefined, undefined) as any;
		assert.ok(result.content[0].text.includes("already active"));
	} finally {
		__setToolSeams({ getAllTools: null, getActiveTools: null, setActiveTools: null });
	}
});

test("UI feedback message is returned in event result when skills are pruned", async () => {
	__setCompleteFn(mockCompleteFn({ skills: ["code-simplification"], tools: [] }));
	try {
		const { handlers } = register(config());
		const result = await runBeforeAgentStart(handlers, "Refactor this code for clarity", realisticSkills) as { systemPrompt?: string; message?: any } | undefined;
		assert.ok(result?.message, "should return a feedback message in event result");
		assert.equal(result.message.customType, "pruning-result");
		assert.equal(result.message.display, true);
		const details = result.message.details;
		assert.ok(details.excludedSkills.length > 0);
		assert.ok(details.includedSkills.length > 0);
		assert.equal(details.mode, "auto");
	} finally {
		__setCompleteFn(null);
	}
});

test("feedback message returned even when nothing is pruned (all selected by LLM)", async () => {
	__setCompleteFn(mockCompleteFn({ skills: ["code-simplification", "duckdb-query-optimization", "frontend-design"], tools: [] }));
	try {
		const { handlers } = register(config());
		const result = await runBeforeAgentStart(handlers, "do everything", realisticSkills) as { systemPrompt?: string; message?: any } | undefined;
		assert.ok(result?.message, "feedback message always returned for transparency");
		assert.equal(result.message.customType, "pruning-result");
		assert.equal(result.message.details.excludedSkills.length, 0);
	} finally {
		__setCompleteFn(null);
	}
});

test("message renderer compact view renders skill summary", async () => {
	const { registeredRenderers } = register(config());
	const renderer = registeredRenderers.get("pruning-result");
	assert.ok(renderer);

	const themeMock = {
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
	};

	const box = renderer(
		{
			content: "Pruned",
			display: true,
			details: {
				includedSkills: ["code-simplification"],
				excludedSkills: ["duckdb-query-optimization", "frontend-design"],
				includedTools: [],
				excludedTools: [],
				mode: "auto",
				skillTokensSaved: 300,
				toolTokensSaved: 0,
			},
		},
		{ expanded: false },
		themeMock,
	);
	const rendered = box.render(80);
	assert.ok(rendered.some((line: string) => line.includes("Kept 1/3 skills")));
});

test("message renderer expanded view renders skill details", async () => {
	const { registeredRenderers } = register(config());
	const renderer = registeredRenderers.get("pruning-result");
	assert.ok(renderer);

	const themeMock = {
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
	};

	const box = renderer(
		{
			content: "Pruned",
			display: true,
			details: {
				includedSkills: ["code-simplification"],
				excludedSkills: ["duckdb-query-optimization", "frontend-design"],
				includedTools: ["read", "edit"],
				excludedTools: ["web_search"],
				mode: "shadow",
				skillTokensSaved: 200,
				toolTokensSaved: 50,
			},
		},
		{ expanded: true },
		themeMock,
	);
	const rendered = box.render(80);
	const allText = rendered.join("\n");
	assert.ok(allText.includes("code-simplification"));
	assert.ok(allText.includes("duckdb-query-optimization"));
	assert.ok(allText.includes("web_search"));
});

test("message renderer with no details renders raw content", async () => {
	const { registeredRenderers } = register(config());
	const renderer = registeredRenderers.get("pruning-result");
	assert.ok(renderer);

	const themeMock = {
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
	};

	const box = renderer(
		{ content: "Plain pruning message", display: true },
		{ expanded: false },
		themeMock,
	);
	const rendered = box.render(80);
	assert.ok(rendered.some((line: string) => line.includes("Plain pruning message")));
});

test("no completeFn available → error message returned (no prompt modification)", async () => {
	__setCompleteFn(null);
	const { handlers } = register(config());
	const result = await runBeforeAgentStart(handlers, "Refactor code", realisticSkills) as { systemPrompt?: string; message?: any } | undefined;
	assert.ok(result?.message, "should return an error message");
	assert.equal(result.message.customType, "pruning-result");
	assert.ok(String(result.message.content).includes("No completion function available"));
	assert.equal(result.systemPrompt, undefined);
});
