import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG, loadConfig } from "../config.js";

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
	assert.deepEqual(result, DEFAULT_CONFIG);
	assert.ok(warnings.some((warning) => warning.includes("settings.json not found")));
});

test("loadConfig returns defaults for malformed JSON", () => {
	const { result, warnings } = captureWarns(() => loadConfig(tempSettings("{")));
	assert.deepEqual(result, DEFAULT_CONFIG);
	assert.ok(warnings.some((warning) => warning.includes("failed to parse")));
});

test("loadConfig returns defaults when pruning key is absent", () => {
	const { result, warnings } = captureWarns(() => loadConfig(tempSettings(JSON.stringify({ model: "example" }))));
	assert.deepEqual(result, DEFAULT_CONFIG);
	assert.deepEqual(warnings, []);
});

test("loadConfig parses a valid full config", () => {
	const settingsPath = tempSettings(JSON.stringify({
		pruning: {
			mode: "shadow",
			skills: {
				ceiling: 4,
				floor: 1,
				scoreThreshold: 0.7,
				gapThreshold: 0.2,
				pinned: ["debugging-and-error-recovery"],
			},
		},
	}));

	assert.deepEqual(loadConfig(settingsPath), {
		mode: "shadow",
		skills: {
			ceiling: 4,
			floor: 1,
			scoreThreshold: 0.7,
			gapThreshold: 0.2,
			pinned: ["debugging-and-error-recovery"],
		},
	});
});

test("loadConfig defaults only invalid mode and warns", () => {
	const { result, warnings } = captureWarns(() => loadConfig(tempSettings(JSON.stringify({
		pruning: { mode: "invalid", skills: { ceiling: 3, floor: 1 } },
	}))));
	assert.equal(result.mode, DEFAULT_CONFIG.mode);
	assert.equal(result.skills.ceiling, 3);
	assert.equal(result.skills.floor, 1);
	assert.ok(warnings.some((warning) => warning.includes("invalid pruning.mode")));
});

test("loadConfig resets invalid ceiling/floor to defaults", () => {
	const { result, warnings } = captureWarns(() => loadConfig(tempSettings(JSON.stringify({
		pruning: { skills: { ceiling: 1, floor: 3 } },
	}))));
	assert.equal(result.skills.ceiling, DEFAULT_CONFIG.skills.ceiling);
	assert.equal(result.skills.floor, DEFAULT_CONFIG.skills.floor);
	assert.ok(warnings.some((warning) => warning.includes("ceiling/floor")));
});

test("loadConfig defaults thresholds outside [0,1]", () => {
	const { result, warnings } = captureWarns(() => loadConfig(tempSettings(JSON.stringify({
		pruning: { skills: { scoreThreshold: -0.1, gapThreshold: 1.1 } },
	}))));
	assert.equal(result.skills.scoreThreshold, DEFAULT_CONFIG.skills.scoreThreshold);
	assert.equal(result.skills.gapThreshold, DEFAULT_CONFIG.skills.gapThreshold);
	assert.equal(warnings.length, 2);
});

test("loadConfig defaults invalid pinned values", () => {
	const { result, warnings } = captureWarns(() => loadConfig(tempSettings(JSON.stringify({
		pruning: { skills: { pinned: ["valid", 42] } },
	}))));
	assert.deepEqual(result.skills.pinned, []);
	assert.ok(warnings.some((warning) => warning.includes("pinned")));
});
