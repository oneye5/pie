/**
 * Direct unit tests for the pure selection logic in
 * extensions/skill-pruner/src/pruning.ts.
 *
 * pruning.ts transitively imports state.ts, which runtime-imports
 * `formatSkillsForPrompt` from `@mariozechner/pi-coding-agent`. That package
 * is not resolvable from the repo root under tsx, so this file uses the same
 * createRequire + Module._resolveFilename mock bootstrap as the existing
 * integration.test.ts / copilot-headers.test.ts, then requires pruning.ts.
 *
 * These tests mock the LLM selection inputs as plain data and assert the
 * branches the orchestrator relies on: ceiling clamp, pinned-forced,
 * LLM-omitted exclusion, and the null-vs-explicitly-empty fail-open split.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

import type { PruningConfig } from "../types.js";
import type { Skill, ToolInfo } from "@mariozechner/pi-coding-agent";

installSdkResolverForTests();
const require = createRequire(import.meta.url);
const {
	shouldSkipPruning,
	resolveVisibleSkills,
	applySkillSelection,
	applyToolSelection,
} = require("../src/pruning.ts") as typeof import("../src/pruning.js");

function installSdkResolverForTests(): void {
	// Isolate from host extension-toggle state (see integration.test.ts).
	delete process.env.PIE_EXTENSION_TOGGLES_JSON;

	const mockDir = mkdtempSync(path.join(tmpdir(), "skill-pruner-pruning-mock-"));
	const sdkPath = path.join(mockDir, "pi-coding-agent.cjs");
	writeFileSync(sdkPath, "exports.formatSkillsForPrompt = () => '';\n", "utf-8");
	const tuiPath = path.join(mockDir, "pi-tui.cjs");
	writeFileSync(tuiPath, "class Box{constructor(){}addChild(){}}class Text{constructor(t){this.text=t;}}module.exports={Box,Text};\n", "utf-8");

	const moduleWithResolver = Module as typeof Module & {
		_resolveFilename: (request: string, parent?: unknown, isMain?: boolean, options?: unknown) => string;
	};
	const originalResolveFilename = moduleWithResolver._resolveFilename;
	moduleWithResolver._resolveFilename = function resolveFilename(request, parent, isMain, options): string {
		if (request === "@mariozechner/pi-coding-agent") return sdkPath;
		if (request === "@mariozechner/pi-tui") return tuiPath;
		return originalResolveFilename.call(this, request, parent, isMain, options);
	};
}

function skill(name: string, overrides: Partial<Skill> = {}): Skill {
	return {
		name,
		description: `desc for ${name}`,
		filePath: `/repo/skills/${name}/SKILL.md`,
		baseDir: `/repo/skills/${name}`,
		sourceInfo: {} as Skill["sourceInfo"],
		disableModelInvocation: false,
		...overrides,
	};
}

function skillsConfig(overrides: Partial<PruningConfig["skills"]> = {}): PruningConfig["skills"] {
	return { strategy: "discretion", ceiling: 8, pinned: [], alwaysKeep: [], ...overrides };
}

function config(overrides: Partial<PruningConfig> = {}): PruningConfig {
	const result: PruningConfig = {
		mode: "auto",
		model: "gpt-5-mini",
		provider: "github-copilot",
		thinkingLevel: "minimal",
		skills: skillsConfig(),
		...overrides,
	};
	return result;
}

function toolsConfig(overrides: Partial<NonNullable<PruningConfig["tools"]>> = {}): NonNullable<PruningConfig["tools"]> {
	return {
		strategy: "discretion",
		ceiling: 10,
		dependencies: { edit: ["read"], subagent: ["bash"] },
		alwaysKeep: [],
		...overrides,
	};
}

const allTools: ToolInfo[] = [
	{ name: "read", description: "Read file contents" },
	{ name: "edit", description: "Edit a file" },
	{ name: "bash", description: "Execute a bash command" },
	{ name: "subagent", description: "Delegate tasks" },
	{ name: "web_search", description: "Search the web" },
] as unknown as ToolInfo[];

const visibleSkills = [skill("alpha"), skill("beta"), skill("gamma")];

// ---------------------------------------------------------------------------
// shouldSkipPruning
// ---------------------------------------------------------------------------

test("shouldSkipPruning: off mode -> skip with reason 'off'", () => {
	const r = shouldSkipPruning({ prompt: "a sufficiently long prompt" } as any, config({ mode: "off" }));
	assert.deepEqual(r, { skip: true, reason: "off" });
});

test("shouldSkipPruning: short prompt -> skip with reason 'too-short'", () => {
	const r = shouldSkipPruning({ prompt: "hi" } as any, config({ mode: "auto" }));
	assert.deepEqual(r, { skip: true, reason: "too-short" });
});

test("shouldSkipPruning: prompt is trimmed before the length check", () => {
	// "   hi   " trims to "hi" (2 chars < MIN_PROMPT_LENGTH=8)
	const r = shouldSkipPruning({ prompt: "   hi   " } as any, config({ mode: "auto" }));
	assert.deepEqual(r, { skip: true, reason: "too-short" });
});

test("shouldSkipPruning: valid prompt in auto mode -> not skipped", () => {
	const r = shouldSkipPruning({ prompt: "refactor this code for clarity" } as any, config({ mode: "auto" }));
	assert.deepEqual(r, { skip: false });
});

test("shouldSkipPruning: exactly MIN_PROMPT_LENGTH (8) chars is not skipped", () => {
	const r = shouldSkipPruning({ prompt: "12345678" } as any, config({ mode: "auto" }));
	assert.deepEqual(r, { skip: false });
});

test("shouldSkipPruning: disabled-by-toggle overrides a valid prompt", () => {
	process.env.PIE_EXTENSION_TOGGLES_JSON = JSON.stringify({ "skill-pruner": false });
	try {
		const r = shouldSkipPruning({ prompt: "refactor this code for clarity" } as any, config({ mode: "auto" }));
		assert.deepEqual(r, { skip: true, reason: "disabled-by-toggle" });
	} finally {
		delete process.env.PIE_EXTENSION_TOGGLES_JSON;
	}
});

test("shouldSkipPruning: malformed toggle JSON is treated as not disabled", () => {
	process.env.PIE_EXTENSION_TOGGLES_JSON = "{not json";
	try {
		const r = shouldSkipPruning({ prompt: "refactor this code for clarity" } as any, config({ mode: "auto" }));
		assert.deepEqual(r, { skip: false });
	} finally {
		delete process.env.PIE_EXTENSION_TOGGLES_JSON;
	}
});

// ---------------------------------------------------------------------------
// resolveVisibleSkills
// ---------------------------------------------------------------------------

test("resolveVisibleSkills: filters out disabled skills", () => {
	const skills = [skill("alpha"), skill("hidden", { disableModelInvocation: true }), skill("beta")];
	const { visibleSkills: vis, visibleSkillNames, effectivePinned } = resolveVisibleSkills(skills, config());
	assert.deepEqual(vis.map((s) => s.name), ["alpha", "beta"]);
	assert.deepEqual([...visibleSkillNames], ["alpha", "beta"]);
	assert.deepEqual(effectivePinned, []);
});

test("resolveVisibleSkills: effectivePinned unions pinned + alwaysKeep and drops missing/disabled", () => {
	const skills = [skill("alpha"), skill("beta"), skill("hidden", { disableModelInvocation: true })];
	const cfg = config({
		skills: skillsConfig({ pinned: ["alpha", "beta", "hidden", "ghost"], alwaysKeep: ["beta"] }),
	});
	const { effectivePinned } = resolveVisibleSkills(skills, cfg);
	// alpha + beta visible & kept; hidden is disabled (dropped); ghost not visible (dropped)
	assert.deepEqual(effectivePinned, ["alpha", "beta"]);
});

test("resolveVisibleSkills: disabled skill named in pinned is dropped (not forced)", () => {
	const skills = [skill("alpha"), skill("off", { disableModelInvocation: true })];
	const cfg = config({ skills: skillsConfig({ pinned: ["off"] }) });
	const { visibleSkills: vis, effectivePinned } = resolveVisibleSkills(skills, cfg);
	assert.deepEqual(vis.map((s) => s.name), ["alpha"]);
	assert.deepEqual(effectivePinned, []);
});

// ---------------------------------------------------------------------------
// applySkillSelection
// ---------------------------------------------------------------------------

test("applySkillSelection: clamps LLM selection down to the ceiling", () => {
	const skills = [skill("alpha"), skill("beta"), skill("gamma"), skill("delta"), skill("epsilon")];
	const r = applySkillSelection(
		skills,
		["alpha", "beta", "gamma", "delta", "epsilon"],
		[],
		config({ skills: skillsConfig({ ceiling: 2 }) }),
		false,
	);
	assert.ok(r.includedSkillNames.length <= 2, `ceiling 2 but got ${r.includedSkillNames.length}`);
	assert.equal(r.excludedSkillNames.length, 3);
	assert.equal(r.failOpenReason, undefined);
});

test("applySkillSelection: ceiling is raised to at least the pinned count", () => {
	const skills = [skill("a"), skill("b"), skill("c"), skill("d")];
	// ceiling 1 but 2 pinned -> all pinned must fit
	const r = applySkillSelection(
		skills,
		["c"],
		["a", "b"],
		config({ skills: skillsConfig({ ceiling: 1, pinned: ["a", "b"] }) }),
		false,
	);
	assert.ok(r.includedSkillNames.includes("a"));
	assert.ok(r.includedSkillNames.includes("b"));
});

test("applySkillSelection: forces pinned skills in even when LLM omits them", () => {
	const r = applySkillSelection(
		visibleSkills,
		["gamma"],
		["alpha"],
		config({ skills: skillsConfig({ pinned: ["alpha"] }) }),
		false,
	);
	assert.ok(r.includedSkillNames.includes("alpha"), "pinned alpha must be included");
	assert.ok(r.includedSkillNames.includes("gamma"));
	assert.ok(!r.excludedSkillNames.includes("alpha"));
});

test("applySkillSelection: excludes LLM-omitted non-pinned skills", () => {
	const r = applySkillSelection(visibleSkills, ["alpha"], [], config(), false);
	assert.deepEqual(r.includedSkillNames, ["alpha"]);
	assert.deepEqual(r.excludedSkillNames, ["beta", "gamma"]);
});

test("applySkillSelection: null selection -> all included, NO fail-open reason", () => {
	const r = applySkillSelection(visibleSkills, null, [], config(), false);
	assert.deepEqual(r.includedSkillNames, ["alpha", "beta", "gamma"]);
	assert.deepEqual(r.excludedSkillNames, []);
	assert.equal(r.failOpenReason, undefined);
});

test("applySkillSelection: explicitly empty selection honored -> all excluded, no fail-open", () => {
	const r = applySkillSelection(visibleSkills, [], [], config(), true);
	assert.deepEqual(r.includedSkillNames, []);
	assert.deepEqual(r.excludedSkillNames, ["alpha", "beta", "gamma"]);
	assert.equal(r.failOpenReason, undefined);
});

test("applySkillSelection: empty non-explicitly-empty selection -> fail-open keeps all with reason", () => {
	// Realistic path: LLM responded but every pick was filtered out as unknown,
	// yielding an empty (non-null, non-explicitly-empty) selection.
	const r = applySkillSelection(visibleSkills, [], [], config(), false);
	assert.deepEqual(r.includedSkillNames, ["alpha", "beta", "gamma"]);
	assert.deepEqual(r.excludedSkillNames, []);
	assert.ok(r.failOpenReason, "fail-open reason should be set");
	assert.match(r.failOpenReason!, /fail-open/i);
});

// ---------------------------------------------------------------------------
// applyToolSelection
// ---------------------------------------------------------------------------

test("applyToolSelection: null selection -> all included, no reason", () => {
	const r = applyToolSelection(allTools, null, config({ tools: toolsConfig() }), false);
	assert.deepEqual(r.includedToolNames, allTools.map((t) => t.name));
	assert.deepEqual(r.excludedToolNames, []);
	assert.equal(r.failOpenReason, undefined);
});

test("applyToolSelection: explicit empty honored -> all excluded, no reason", () => {
	const r = applyToolSelection(allTools, [], config({ tools: toolsConfig() }), true);
	assert.deepEqual(r.includedToolNames, []);
	assert.deepEqual(r.excludedToolNames, allTools.map((t) => t.name));
	assert.equal(r.failOpenReason, undefined);
});

test("applyToolSelection: empty non-explicitly-empty selection -> fail-open keeps all", () => {
	// Realistic path: LLM responded but every pick was filtered out as unknown,
	// yielding an empty (non-null, non-explicitly-empty) selection.
	const r = applyToolSelection(allTools, [], config({ tools: toolsConfig() }), false);
	assert.deepEqual(r.includedToolNames, allTools.map((t) => t.name));
	assert.deepEqual(r.excludedToolNames, []);
	assert.ok(r.failOpenReason);
});

test("applyToolSelection: alwaysKeep tools included even when LLM omits them", () => {
	const cfg = config({ tools: toolsConfig({ alwaysKeep: ["web_search"] }) });
	const r = applyToolSelection(allTools, ["read"], cfg, false);
	assert.ok(r.includedToolNames.includes("web_search"));
	assert.ok(r.includedToolNames.includes("read"));
	assert.ok(!r.includedToolNames.includes("edit"));
});

test("applyToolSelection: dependencies pulled in (edit -> read) even when LLM omits them", () => {
	const cfg = config({ tools: toolsConfig({ dependencies: { edit: ["read"] } }) });
	const r = applyToolSelection(allTools, ["edit"], cfg, false);
	assert.ok(r.includedToolNames.includes("edit"));
	assert.ok(r.includedToolNames.includes("read"), "read should be pulled in as a dependency of edit");
	assert.ok(r.excludedToolNames.includes("bash"));
});

test("applyToolSelection: transitive dependencies expand beyond the configured ceiling", () => {
	// a -> b -> c -> read chain; ceiling 2; LLM selects only "a"
	const cfg = config({
		tools: toolsConfig({ ceiling: 2, dependencies: { a: ["b"], b: ["c"], c: ["read"] } }),
	});
	const toolsWithABC = [
		...allTools,
		{ name: "a", description: "da" },
		{ name: "b", description: "db" },
		{ name: "c", description: "dc" },
	] as unknown as ToolInfo[];
	const r = applyToolSelection(toolsWithABC, ["a"], cfg, false);
	assert.ok(r.includedToolNames.includes("a"));
	assert.ok(r.includedToolNames.includes("b"));
	assert.ok(r.includedToolNames.includes("c"));
	assert.ok(r.includedToolNames.includes("read"));
	assert.ok(r.includedToolNames.length > 2, "deps expand beyond ceiling");
});

test("applyToolSelection: no tools config -> all included regardless of LLM selection", () => {
	const r = applyToolSelection(allTools, ["read"], config(), false);
	assert.deepEqual(r.includedToolNames, allTools.map((t) => t.name));
	assert.deepEqual(r.excludedToolNames, []);
	assert.equal(r.failOpenReason, undefined);
});

test("applyToolSelection: empty allTools -> empty included/excluded", () => {
	const r = applyToolSelection([], ["read"], config({ tools: toolsConfig() }), false);
	assert.deepEqual(r.includedToolNames, []);
	assert.deepEqual(r.excludedToolNames, []);
});
