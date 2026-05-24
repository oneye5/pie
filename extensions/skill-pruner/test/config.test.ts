import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG, DEFAULT_TOOL_CONFIG, loadConfig } from "../config.js";

function tempSettings(content: string): string {
	const dir = mkdtempSync(path.join(tmpdir(), "skill-pruner-config-"));
	const settingsPath = path.join(dir, "settings.json");
	writeFileSync(settingsPath, content, "utf-8");
	return settingsPath;
}

function captureWarns<T>(fn: () => T): { result: T; warnings: string[] } {
	const original = console.warn;
	const warnings: string[] = [];
	console.warn = (message?: unknown) => { warnings.push(String(message)); };
	try {
		return { result: fn(), warnings };
	} finally {
		console.warn = original;
	}
}

test("loadConfig returns defaults for a missing settings file", () => {
	const { result, warnings } = captureWarns(() => loadConfig(path.join(tmpdir(), "missing-skill-pruner-settings.json")));
	assert.equal(result.mode, DEFAULT_CONFIG.mode);
	assert.deepEqual(result.skills, DEFAULT_CONFIG.skills);
	assert.equal(result.model, DEFAULT_CONFIG.model);
	assert.equal(result.provider, DEFAULT_CONFIG.provider);
	assert.equal(result.thinkingLevel, DEFAULT_CONFIG.thinkingLevel);
	assert.ok(warnings.some((warning) => warning.includes("settings.json not found")));
});

test("loadConfig returns defaults for malformed JSON", () => {
	const { result, warnings } = captureWarns(() => loadConfig(tempSettings("{")));
	assert.equal(result.mode, DEFAULT_CONFIG.mode);
	assert.deepEqual(result.skills, DEFAULT_CONFIG.skills);
	assert.ok(warnings.some((warning) => warning.includes("failed to parse")));
});

test("loadConfig returns defaults when pruning key is absent", () => {
	const { result, warnings } = captureWarns(() => loadConfig(tempSettings(JSON.stringify({ model: "example" }))));
	assert.equal(result.mode, DEFAULT_CONFIG.mode);
	assert.deepEqual(result.skills, DEFAULT_CONFIG.skills);
	assert.deepEqual(warnings, []);
});

test("loadConfig parses a valid full config", () => {
	const settingsPath = tempSettings(JSON.stringify({
		pruning: {
			mode: "shadow",
			model: "claude-sonnet-4",
			provider: "anthropic",
			thinkingLevel: "high",
			skills: {
				strategy: "topK",
				ceiling: 4,
				pinned: ["debugging-and-error-recovery"],
			},
		},
	}));

	const result = loadConfig(settingsPath);
	assert.equal(result.mode, "shadow");
	assert.equal(result.model, "claude-sonnet-4");
	assert.equal(result.provider, "anthropic");
	assert.equal(result.thinkingLevel, "high");
	assert.deepEqual(result.skills, {
		strategy: "topK",
		ceiling: 4,
		pinned: ["debugging-and-error-recovery"],
	});
	assert.ok(result.tools);
	assert.equal(result.tools.ceiling, DEFAULT_TOOL_CONFIG.ceiling);
});

test("loadConfig defaults only invalid mode and warns", () => {
	const { result, warnings } = captureWarns(() => loadConfig(tempSettings(JSON.stringify({
		pruning: { mode: "invalid", skills: { ceiling: 3 } },
	}))));
	assert.equal(result.mode, DEFAULT_CONFIG.mode);
	assert.equal(result.skills.ceiling, 3);
	assert.ok(warnings.some((warning) => warning.includes("invalid pruning.mode")));
});

test("loadConfig resets invalid ceiling to defaults", () => {
	const { result, warnings } = captureWarns(() => loadConfig(tempSettings(JSON.stringify({
		pruning: { skills: { ceiling: -1 } },
	}))));
	assert.equal(result.skills.ceiling, DEFAULT_CONFIG.skills.ceiling);
	assert.ok(warnings.some((warning) => warning.includes("ceiling")));
});

test("loadConfig defaults invalid pinned values", () => {
	const { result, warnings } = captureWarns(() => loadConfig(tempSettings(JSON.stringify({
		pruning: { skills: { pinned: ["valid", 42] } },
	}))));
	assert.deepEqual(result.skills.pinned, []);
	assert.ok(warnings.some((warning) => warning.includes("pinned")));
});

test("loadConfig parses model and provider fields", () => {
	const settingsPath = tempSettings(JSON.stringify({
		pruning: {
			model: "gpt-5.4-mini",
			provider: "github-copilot",
			thinkingLevel: "minimal",
		},
	}));
	const result = loadConfig(settingsPath);
	assert.equal(result.model, "gpt-5.4-mini");
	assert.equal(result.provider, "github-copilot");
	assert.equal(result.thinkingLevel, "minimal");
});

test("loadConfig defaults invalid model/provider", () => {
	const { result, warnings } = captureWarns(() => loadConfig(tempSettings(JSON.stringify({
		pruning: { model: "", provider: 123 },
	}))));
	assert.equal(result.model, DEFAULT_CONFIG.model);
	assert.equal(result.provider, DEFAULT_CONFIG.provider);
	assert.ok(warnings.some((w) => w.includes("model")));
	assert.ok(warnings.some((w) => w.includes("provider")));
});

test("loadConfig parses strategy for skills and tools", () => {
	const settingsPath = tempSettings(JSON.stringify({
		pruning: {
			skills: { strategy: "topK" },
			tools: { strategy: "topK", ceiling: 15 },
		},
	}));
	const result = loadConfig(settingsPath);
	assert.equal(result.skills.strategy, "topK");
	assert.equal(result.tools!.strategy, "topK");
	assert.equal(result.tools!.ceiling, 15);
});

test("loadConfig defaults invalid strategy", () => {
	const { result, warnings } = captureWarns(() => loadConfig(tempSettings(JSON.stringify({
		pruning: { skills: { strategy: "invalid" } },
	}))));
	assert.equal(result.skills.strategy, DEFAULT_CONFIG.skills.strategy);
	assert.ok(warnings.some((w) => w.includes("strategy")));
});

test("loadConfig loads tools config with dependencies", () => {
	const settingsPath = tempSettings(JSON.stringify({
		pruning: {
			tools: {
				dependencies: { edit: ["read"], subagent: ["bash"] },
				ceiling: 12,
			},
		},
	}));
	const result = loadConfig(settingsPath);
	assert.ok(result.tools);
	assert.deepEqual(result.tools.dependencies.edit, ["read"]);
	assert.deepEqual(result.tools.dependencies.subagent, ["bash"]);
	assert.equal(result.tools.ceiling, 12);
});

test("loadConfig defaults tools config when absent", () => {
	const settingsPath = tempSettings(JSON.stringify({ pruning: { mode: "auto" } }));
	const result = loadConfig(settingsPath);
	assert.ok(result.tools);
	assert.equal(result.tools.ceiling, DEFAULT_TOOL_CONFIG.ceiling);
});

test("loadConfig warns on invalid tools ceiling", () => {
	const { result, warnings } = captureWarns(() => loadConfig(tempSettings(JSON.stringify({
		pruning: { tools: { ceiling: -1 } },
	}))));
	assert.ok(result.tools);
	assert.equal(result.tools.ceiling, DEFAULT_TOOL_CONFIG.ceiling);
	assert.ok(warnings.some((w) => w.includes("ceiling")));
});
