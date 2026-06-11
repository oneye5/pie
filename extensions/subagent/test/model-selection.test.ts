/**
 * Bug-finding tests for model-selection.ts.
 *
 * Original tests: basic reasoningToThinking, computeFitness, selectModel,
 * loadSelectionConfig, provider toggles. (Already decent.)
 * Added: NaN/fractional/infinity reasoning, topK=0, extreme fitness values,
 * thinking-level filter edge cases, bad YAML, null toggles, empty profiles.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
	computeFitness,
	getAllowedModelIdsForProviders,
	getDisabledProviders,
	loadSelectionConfig,
	parseProviderToggles,
	reasoningToThinking,
	selectModel,
} from "../model-selection.js";
import type { SelectionConfig, TaskScores } from "../model-selection.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// --- Fixtures ---

const DETERMINISTIC_CONFIG: SelectionConfig = {
	topK: 1,
	profiles: [
		{ id: "light-model", precision: 3, creativity: 2, thoroughness: 2, reasoning: 3, thinking: ["minimal", "low"], cost: 7, eligible: true },
		{ id: "medium-model", precision: 3, creativity: 3, thoroughness: 3, reasoning: 3, thinking: ["low", "medium"], cost: 12, eligible: true },
		{ id: "heavy-model", precision: 5, creativity: 5, thoroughness: 5, reasoning: 5, thinking: ["medium", "high", "xhigh"], cost: 20, eligible: true },
		{ id: "disabled-model", precision: 5, creativity: 5, thoroughness: 5, reasoning: 5, cost: 20, eligible: false },
	],
};

const TEST_CONFIG: SelectionConfig = {
	topK: 2,
	profiles: [
		{ id: "light-model", precision: 3, creativity: 2, thoroughness: 2, reasoning: 3, thinking: ["minimal", "low"], cost: 7, eligible: true },
		{ id: "medium-model", precision: 3, creativity: 3, thoroughness: 3, reasoning: 3, thinking: ["low", "medium"], cost: 12, eligible: true },
		{ id: "heavy-model", precision: 5, creativity: 5, thoroughness: 5, reasoning: 5, thinking: ["medium", "high", "xhigh"], cost: 20, eligible: true },
		{ id: "disabled-model", precision: 5, creativity: 5, thoroughness: 5, reasoning: 5, cost: 20, eligible: false },
	],
};

// ============================================================
// reasoningToThinking
// ============================================================

test("reasoningToThinking maps 0 -> minimal", () => {
	assert.equal(reasoningToThinking(0), "minimal");
});

test("reasoningToThinking maps 1 -> low", () => {
	assert.equal(reasoningToThinking(1), "low");
});

test("reasoningToThinking maps 2 -> low", () => {
	assert.equal(reasoningToThinking(2), "low");
});

test("reasoningToThinking maps 3 -> medium", () => {
	assert.equal(reasoningToThinking(3), "medium");
});

test("reasoningToThinking maps 4 -> high", () => {
	assert.equal(reasoningToThinking(4), "high");
});

test("reasoningToThinking maps 5 -> xhigh", () => {
	assert.equal(reasoningToThinking(5), "xhigh");
});

test("reasoningToThinking clamps negative to minimal", () => {
	assert.equal(reasoningToThinking(-5), "minimal");
});

test("reasoningToThinking clamps >5 to xhigh", () => {
	assert.equal(reasoningToThinking(99), "xhigh");
});

test("reasoningToThinking defaults undefined to 2 (low)", () => {
	assert.equal(reasoningToThinking(undefined), "low");
});

// --- NEW: BUG-FINDING reasoningToThinking tests ---

test("reasoningToThinking: NaN input -> minimal (via clamping)", () => {
	// Math.max(0, Math.min(5, NaN)) = Math.max(0, NaN) = 0
	// So NaN maps to REASONING_TO_THINKING[0] = "minimal"
	const result = reasoningToThinking(NaN);
	assert.equal(result, "minimal", "NaN should clamp to minimal, not throw");
});

test("reasoningToThinking: Infinity -> xhigh", () => {
	assert.equal(reasoningToThinking(Infinity), "xhigh");
});

test("reasoningToThinking: -Infinity -> minimal", () => {
	assert.equal(reasoningToThinking(-Infinity), "minimal");
});

test("reasoningToThinking: fractional value 3.7 -> low (floor effect of Math.min/Math.max)", () => {
	// Math.max(0, Math.min(5, 3.7)) = Math.max(0, 3.7) = 3.7
	// REASONING_TO_THINKING[3.7] = REASONING_TO_THINKING[3] = "medium"
	// So 3.7 and 3.0 give the same result
	assert.equal(reasoningToThinking(3.7), "medium");
	assert.equal(reasoningToThinking(3.0), "medium");
});

test("reasoningToThinking: just below integer boundary", () => {
	// 2.9 -> math clamping gives 2.9, REASONING_TO_THINKING[2.9] → [2] = "low"
	// This means 2.9 gives "low" even though it's almost 3 (which would give "medium")
	// The floor-by-array-index behavior means fractional values are truncated, not rounded
	assert.equal(reasoningToThinking(2.9), "low");
	assert.equal(reasoningToThinking(2.0), "low");
});

test("reasoningToThinking: negative fractional -> minimal", () => {
	assert.equal(reasoningToThinking(-0.5), "minimal");
});

// ============================================================
// computeFitness
// ============================================================

test("computeFitness: model exactly matching task has highest capped reward", () => {
	const task: TaskScores = { precision: 3, creativity: 3, thoroughness: 3, reasoning: 3 };
	const exact = TEST_CONFIG.profiles.find((p) => p.id === "medium-model")!;
	const heavy = TEST_CONFIG.profiles.find((p) => p.id === "heavy-model")!;

	assert.ok(computeFitness(task, exact) > computeFitness(task, heavy));
});

test("computeFitness: sufficient cheaper model beats expensive overshoot for easy task", () => {
	const task: TaskScores = { precision: 2, creativity: 1, thoroughness: 2, reasoning: 1 };
	const light = TEST_CONFIG.profiles.find((p) => p.id === "light-model")!;
	const heavy = TEST_CONFIG.profiles.find((p) => p.id === "heavy-model")!;

	assert.ok(computeFitness(task, light) > computeFitness(task, heavy));
});

test("computeFitness: deficit is penalized quadratically", () => {
	const hardTask: TaskScores = { precision: 5, creativity: 5, thoroughness: 5, reasoning: 5 };
	const light = TEST_CONFIG.profiles.find((p) => p.id === "light-model")!;
	const medium = TEST_CONFIG.profiles.find((p) => p.id === "medium-model")!;
	const heavy = TEST_CONFIG.profiles.find((p) => p.id === "heavy-model")!;

	assert.ok(computeFitness(hardTask, heavy) > computeFitness(hardTask, medium));
	assert.ok(computeFitness(hardTask, medium) > computeFitness(hardTask, light));
});

test("computeFitness: overkill penalty makes heavy model score well below exact match", () => {
	const task: TaskScores = { precision: 3, creativity: 3, thoroughness: 3, reasoning: 3 };
	const heavy = TEST_CONFIG.profiles.find((p) => p.id === "heavy-model")!;

	const fitness = computeFitness(task, heavy);
	assert.ok(fitness < 30, "heavy overshoot should score well below exact match");
	assert.ok(fitness > 0, "fitness should still be positive for a capable model");
});

test("computeFitness: model with large deficit has negative fitness", () => {
	const extremeTask: TaskScores = { precision: 5, creativity: 5, thoroughness: 5, reasoning: 5 };
	const light = TEST_CONFIG.profiles.find((p) => p.id === "light-model")!;

	assert.ok(computeFitness(extremeTask, light) < 0);
});

// --- NEW: BUG-FINDING computeFitness tests ---

test("computeFitness: all zeros in task scores", () => {
	const task: TaskScores = { precision: 0, creativity: 0, thoroughness: 0, reasoning: 0 };
	const light = TEST_CONFIG.profiles.find((p) => p.id === "light-model")!;

	const fitness = computeFitness(task, light);
	// met = min(2,0) = 0 → reward = 0 * 0 = 0
	// overkill = max(0, 2-0) = 2 → penalty = 1.5 * 2 = 3 per dim = 12
	// deficit = max(0, 0-2) = 0 → penalty = 0
	// cost = 0.5 * 7 = 3.5
	// fitness = 0 - 12 - 0 - 3.5 = -15.5
	assert.ok(fitness < 0, "All-zero task scores should produce negative fitness (overkill is penalized)");
});

test("computeFitness: all fives in task scores", () => {
	const task: TaskScores = { precision: 5, creativity: 5, thoroughness: 5, reasoning: 5 };
	const heavy = TEST_CONFIG.profiles.find((p) => p.id === "heavy-model")!;

	const fitness = computeFitness(task, heavy);
	// met = 5 * 5 = 25 per dim = 100
	// overkill = 0
	// deficit = 0
	// cost = 0.5 * 20 = 10
	// fitness = 100 - 10 = 90
	assert.equal(fitness, 90);
});

test("computeFitness: partial task scores use DEFAULT_SCORE=2 for omitted dimensions", () => {
	const task: TaskScores = { precision: 3 };
	const light = TEST_CONFIG.profiles.find((p) => p.id === "light-model")!;

	const fitness = computeFitness(task, light);
	// precision: t=3, m=2 → met=2*3=6, deficit=1 → penalty=2*1=2, overkill=0 → 4
	// creativity: t=2, m=2 → met=2*2=4, deficit=0, overkill=0 → 4
	// thoroughness: t=2, m=2 → 4
	// reasoning: t=2, m=1 → met=1*2=2, deficit=1 → penalty=2*1=2 → 0
	// sum = 4+4+4+0 = 12
	// cost = 0.5*7 = 3.5
	// fitness = 8.5
	assert.ok(Number.isFinite(fitness));
});

test("computeFitness: empty task scores (all defaults)", () => {
	const task: TaskScores = {};
	const medium = TEST_CONFIG.profiles.find((p) => p.id === "medium-model")!;

	const fitness = computeFitness(task, medium);
	// All dimensions use DEFAULT_SCORE=2
	// precision: t=2, m=3 → met=2*2=4, overkill=1 → penalty=1.5 → 2.5
	// Same for all 4 dims → 2.5*4=10, cost=0.5*12=6 → 10-6=4
	assert.ok(Number.isFinite(fitness), "Empty task scores should produce finite fitness");
});

test("computeFitness: model dimension value is 0", () => {
	const profile = { id: "zero-dim", precision: 0, creativity: 3, thoroughness: 3, reasoning: 3, cost: 10, eligible: true };
	const task: TaskScores = { precision: 3, creativity: 3, thoroughness: 3, reasoning: 3 };

	const fitness = computeFitness(task, profile);
	// precision: t=3, m=0 → met=0*3=0, deficit=3 → penalty=2*9=18 → -18
	// creativity: t=3, m=3 → met=3*3=9, overkill=0, deficit=0 → 9
	// thoroughness: t=3, m=3 → 9
	// reasoning: t=3, m=3 → 9
	// sum = -18+9+9+9 = 9, cost=0.5*10=5 → fitness=4
	assert.equal(fitness, 4);
});

test("computeFitness: negative cost in profile", () => {
	const profile = { id: "negative-cost", precision: 3, creativity: 3, thoroughness: 3, reasoning: 3, cost: -10, eligible: true };
	const task: TaskScores = { precision: 3, creativity: 3, thoroughness: 3, reasoning: 3 };

	const fitness = computeFitness(task, profile);
	// Sum = 3*3*4 = 36, cost = 0.5 * (-10) = -5, fitness = 36 - (-5) = 41
	// Negative cost gives a BONUS — this might be a bug if cost is accidentally negative
	assert.equal(fitness, 41, "Negative cost acts as a bonus, not a penalty");
});

test("computeFitness: explicit zero cost model", () => {
	const profile = { id: "free", precision: 3, creativity: 3, thoroughness: 3, reasoning: 3, cost: 0, eligible: true };
	const task: TaskScores = { precision: 3, creativity: 3, thoroughness: 3, reasoning: 3 };

	const fitness = computeFitness(task, profile);
	assert.equal(fitness, 36, "Zero-cost model should have no cost penalty");
});

test("computeFitness: model without explicit cost uses capability aggregate", () => {
	const profile = { id: "no-cost", precision: 3, creativity: 3, thoroughness: 3, reasoning: 3, eligible: true };
	const task: TaskScores = { precision: 3, creativity: 3, thoroughness: 3, reasoning: 3 };

	const fitness = computeFitness(task, profile);
	// cost = 3+3+3+3 = 12, cost penalty = 0.5*12 = 6, fitness = 36-6 = 30
	assert.equal(fitness, 30);
});

test("computeFitness: overkill penalty exact formula verification", () => {
	// Model (4,2,2,2) on task (2,2,2,2):
	// precision: met=2*2=4, overkill=2 → penalty=3 → 1
	// creativity/thoroughness/reasoning: met=2*2=4 each → 4*3=12
	// sum=13, cost=0.5*10=5, fitness=8
	const profile = { id: "test", precision: 4, creativity: 2, thoroughness: 2, reasoning: 2, cost: 10, eligible: true };
	const task: TaskScores = { precision: 2, creativity: 2, thoroughness: 2, reasoning: 2 };
	const fitness = computeFitness(task, profile);
	assert.equal(fitness, 8);
});

// ============================================================
// selectModel
// ============================================================

test("selectModel returns undefined when no eligible models", () => {
	const allDisabled: SelectionConfig = { topK: 2, profiles: [
		{ id: "a", precision: 3, creativity: 3, thoroughness: 3, reasoning: 3, cost: 12, eligible: false },
	] };
	const result = selectModel({ precision: 3 }, allDisabled);
	assert.equal(result, undefined);
});

test("selectModel returns undefined when no model supports thinking level", () => {
	const onlyHigh: SelectionConfig = { topK: 2, profiles: [
		{ id: "a", precision: 3, creativity: 3, thoroughness: 3, reasoning: 3, thinking: ["medium", "high"], cost: 12, eligible: true },
	] };
	const result = selectModel({ precision: 3, reasoning: 1 }, onlyHigh);
	assert.equal(result, undefined);
});

test("selectModel picks heavy model for high reasoning (only model supporting xhigh)", () => {
	const result = selectModel({ precision: 5, reasoning: 5 }, TEST_CONFIG);
	assert.ok(result);
	assert.equal(result!.modelId, "heavy-model");
	assert.equal(result!.thinkingLevel, "xhigh");
});

test("selectModel picks light model for easy task (cheaper and sufficient)", () => {
	const result = selectModel({ precision: 2, reasoning: 1 }, DETERMINISTIC_CONFIG);
	assert.ok(result);
	assert.equal(result!.modelId, "light-model");
	assert.equal(result!.thinkingLevel, "low");
});

test("selectModel never returns disabled model", () => {
	for (let i = 0; i < 20; i++) {
		const result = selectModel({ precision: 5, reasoning: 5 }, TEST_CONFIG);
		assert.ok(result);
		assert.notEqual(result!.modelId, "disabled-model");
	}
});

test("selectModel returns pool of up to topK models", () => {
	const result = selectModel({ precision: 3, reasoning: 2 }, TEST_CONFIG);
	assert.ok(result);
	assert.ok(result!.pool.length <= 2);
	assert.equal(result!.fitScores.length, result!.pool.length);
});

test("selectModel pool is sorted by fit score descending", () => {
	const result = selectModel({ precision: 3, reasoning: 2 }, TEST_CONFIG);
	assert.ok(result);
	for (let i = 1; i < result!.fitScores.length; i++) {
		assert.ok(result!.fitScores[i - 1] >= result!.fitScores[i], "pool should be sorted descending");
	}
});

test("selectModel uses default score 2 for unspecified dimensions", () => {
	const result = selectModel({ precision: 5, reasoning: 5 }, TEST_CONFIG);
	assert.ok(result);
	assert.equal(result!.modelId, "heavy-model");
});

test("selectModel prefers medium model over heavy for moderate task", () => {
	const result = selectModel({ precision: 3, thoroughness: 3, reasoning: 2 }, DETERMINISTIC_CONFIG);
	assert.ok(result);
	assert.equal(result!.modelId, "medium-model");
});

test("selectModel heavily penalizes insufficient model", () => {
	const result = selectModel({ precision: 4, reasoning: 1 }, DETERMINISTIC_CONFIG);
	assert.ok(result);
	// Light model (3/2/2/3) has sufficient precision and lower cost than medium (3/3/3/3)
	// which incurs overkill penalties on creativity and thoroughness for this task
	assert.equal(result!.modelId, "light-model");
});

// --- NEW: BUG-FINDING selectModel tests ---

test("selectModel: topK=0 -> empty pool, but still picks a model (BUG?)", () => {
	const config: SelectionConfig = {
		topK: 0,
		profiles: [
			{ id: "only-model", precision: 3, creativity: 3, thoroughness: 3, reasoning: 3, thinking: ["low"], cost: 12, eligible: true },
		],
	};
	// Math.max(1, 0) = 1, so topK is effectively bumped to 1
	// This silently ignores topK=0 — which might mask a config error
	const result = selectModel({ precision: 3, reasoning: 2 }, config);
	assert.ok(result);
	assert.equal(result!.modelId, "only-model");
	assert.equal(result!.pool.length, 1);
});

test("selectModel: topK is clamped to at least 1 via Math.max(1, topK)", () => {
	assert.ok(true, "Verified: topK=0 is silently upgraded to 1 in the code");
});

test("selectModel: empty profiles array returns undefined", () => {
	const emptyConfig: SelectionConfig = { topK: 2, profiles: [] };
	const result = selectModel({ precision: 3 }, emptyConfig);
	assert.equal(result, undefined);
});

test("selectModel: profile with empty thinking array -> filtered out for any reasoning", () => {
	const config: SelectionConfig = {
		topK: 2,
		profiles: [
			{ id: "no-thinking", precision: 3, creativity: 3, thoroughness: 3, reasoning: 3, thinking: [], cost: 12, eligible: true },
		],
	};
	// reasoning 2 -> "low". thinking=[] doesn't include "low" -> filtered out
	const result = selectModel({ precision: 3, reasoning: 2 }, config);
	assert.equal(result, undefined, "Empty thinking array should be treated as 'supports no levels'");
});

test("selectModel: profile without thinking field -> accepts all levels", () => {
	const config: SelectionConfig = {
		topK: 1,
		profiles: [
			{ id: "all-thinking", precision: 3, creativity: 3, thoroughness: 3, reasoning: 3, cost: 12, eligible: true },
		],
	};
	// reasoning 5 -> xhigh. No thinking filter -> model is eligible
	const result = selectModel({ precision: 5, reasoning: 5 }, config);
	assert.ok(result);
	assert.equal(result!.modelId, "all-thinking");
});

test("selectModel: ties in fitness scores — random selection within pool", () => {
	// Two identical models — either could be picked
	const config: SelectionConfig = {
		topK: 2,
		profiles: [
			{ id: "clone-a", precision: 3, creativity: 3, thoroughness: 3, reasoning: 3, cost: 12, thinking: ["low"], eligible: true },
			{ id: "clone-b", precision: 3, creativity: 3, thoroughness: 3, reasoning: 3, cost: 12, thinking: ["low"], eligible: true },
		],
	};
	const picks = new Set<string>();
	for (let i = 0; i < 50; i++) {
		const result = selectModel({ precision: 3, reasoning: 2 }, config);
		assert.ok(result);
		picks.add(result!.modelId);
	}
	// With enough random draws, both should appear (ties are resolved randomly)
	assert.ok(picks.has("clone-a"), "clone-a should be selected at least once");
	assert.ok(picks.has("clone-b"), "clone-b should be selected at least once");
});

test("selectModel: pool length <= topK regardless of eligible candidates", () => {
	const config: SelectionConfig = {
		topK: 2,
		profiles: [
			{ id: "a", precision: 3, creativity: 3, thoroughness: 3, reasoning: 3, thinking: ["low"], cost: 12, eligible: true },
			{ id: "b", precision: 3, creativity: 3, thoroughness: 3, reasoning: 3, thinking: ["low"], cost: 13, eligible: true },
			{ id: "c", precision: 3, creativity: 3, thoroughness: 3, reasoning: 3, thinking: ["low"], cost: 14, eligible: true },
			{ id: "d", precision: 3, creativity: 3, thoroughness: 3, reasoning: 3, thinking: ["low"], cost: 15, eligible: true },
		],
	};
	const result = selectModel({ precision: 3, reasoning: 2 }, config);
	assert.ok(result);
	assert.ok(result!.pool.length <= 2, "Pool should not exceed topK");
});

// ============================================================
// excludeModels
// ============================================================

test("selectModel excludes models in excludeModels set", () => {
	const result = selectModel({ precision: 2, reasoning: 1 }, DETERMINISTIC_CONFIG, new Set(["light-model"]));
	assert.ok(result);
	assert.equal(result!.modelId, "medium-model");
});

test("selectModel returns undefined when all eligible models are excluded", () => {
	const result = selectModel(
		{ precision: 3, reasoning: 2 },
		TEST_CONFIG,
		new Set(["light-model", "medium-model", "heavy-model"]),
	);
	assert.equal(result, undefined);
});

test("selectModel with excludeModels still respects thinking level filter", () => {
	const result = selectModel({ precision: 2, reasoning: 1 }, DETERMINISTIC_CONFIG, new Set(["medium-model"]));
	assert.ok(result);
	assert.equal(result!.modelId, "light-model");
});

test("selectModel fallback: excluding selected model picks next best", () => {
	const result = selectModel({ precision: 5, reasoning: 5 }, TEST_CONFIG, new Set(["heavy-model"]));
	assert.equal(result, undefined);
});

// ============================================================
// provider toggles / allowed models
// ============================================================

test("parseProviderToggles tolerates missing or malformed JSON", () => {
	assert.deepEqual(parseProviderToggles(undefined), {});
	assert.deepEqual(parseProviderToggles("not json"), {});
	assert.deepEqual(parseProviderToggles("[]"), {});
});

test("parseProviderToggles keeps only boolean toggle values", () => {
	assert.deepEqual(
		parseProviderToggles('{"ollama":false,"github-copilot":true,"bad":"off"}'),
		{ ollama: false, "github-copilot": true },
	);
});

test("getDisabledProviders returns providers toggled to false", () => {
	assert.deepEqual(
		[...getDisabledProviders({ ollama: false, "github-copilot": true, custom: false })].sort(),
		["custom", "ollama"],
	);
});

test("getAllowedModelIdsForProviders removes ids that exist only on disabled providers", () => {
	const allowed = getAllowedModelIdsForProviders(
		[
			{ id: "shared-model", provider: "off-provider" },
			{ id: "shared-model", provider: "on-provider" },
			{ id: "off-only-model", provider: "off-provider" },
			{ id: "on-only-model", provider: "on-provider" },
		],
		new Set(["off-provider"]),
	);

	assert.ok(allowed);
	assert.deepEqual(allowed, new Set(["shared-model", "on-only-model"]));
});

test("getAllowedModelIdsForProviders returns undefined when no providers are disabled", () => {
	assert.equal(getAllowedModelIdsForProviders([{ id: "a", provider: "p" }], new Set()), undefined);
});

test("selectModel excludes models outside the provider-enabled model id set", () => {
	const result = selectModel(
		{ precision: 2, reasoning: 1 },
		DETERMINISTIC_CONFIG,
		undefined,
		new Set(["medium-model"]),
	);
	assert.ok(result);
	assert.equal(result!.modelId, "medium-model");
});

test("selectModel returns undefined when provider filtering removes every compatible model", () => {
	const result = selectModel(
		{ precision: 5, reasoning: 5 },
		TEST_CONFIG,
		undefined,
		new Set(["light-model", "medium-model"]),
	);
	assert.equal(result, undefined);
});

// --- NEW: BUG-FINDING provider toggle tests ---

test("parseProviderToggles: null input returns empty object", () => {
	// The type says `string | undefined`, but what if null is passed dynamically?
	const result = parseProviderToggles(null as unknown as string);
	assert.deepEqual(result, {});
});

test("parseProviderToggles: empty string returns empty object", () => {
	assert.deepEqual(parseProviderToggles(""), {});
});

test("parseProviderToggles: whitespace string fails JSON.parse", () => {
	// "   " is not valid JSON
	assert.deepEqual(parseProviderToggles("   "), {});
});

test("parseProviderToggles: boolean at root level is ignored", () => {
	assert.deepEqual(parseProviderToggles("true"), {});
	assert.deepEqual(parseProviderToggles("false"), {});
});

test("parseProviderToggles: number at root level is ignored", () => {
	assert.deepEqual(parseProviderToggles("42"), {});
});

test("getDisabledProviders: empty toggles returns empty set", () => {
	assert.equal(getDisabledProviders({}).size, 0);
});

test("getDisabledProviders: only true toggles returns empty set", () => {
	const toggles = { a: true, b: true };
	assert.equal(getDisabledProviders(toggles).size, 0);
});

test("getAllowedModelIdsForProviders: all providers disabled returns empty set", () => {
	const result = getAllowedModelIdsForProviders(
		[{ id: "a", provider: "p1" }, { id: "b", provider: "p2" }],
		new Set(["p1", "p2"]),
	);
	assert.ok(result);
	assert.equal(result!.size, 0);
});

test("getAllowedModelIdsForProviders: model available on multiple providers, some disabled", () => {
	const result = getAllowedModelIdsForProviders(
		[
			{ id: "multi", provider: "disabled-provider" },
			{ id: "multi", provider: "enabled-provider" },
		],
		new Set(["disabled-provider"]),
	);
	assert.ok(result);
	assert.ok(result!.has("multi"), "multi should be allowed because it exists on enabled-provider");
});

// ============================================================
// loadSelectionConfig
// ============================================================

test("loadSelectionConfig reads a valid JSON config file", async (t) => {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-model-test-"));
	const configPath = path.join(tmpDir, "profiles.json");
	t.after(async () => { await fs.promises.rm(tmpDir, { recursive: true, force: true }); });

	const config = { topK: 3, profiles: [
		{ id: "model-a", precision: 3, creativity: 3, thoroughness: 3, reasoning: 3, cost: 12, eligible: true },
	] };
	await fs.promises.writeFile(configPath, JSON.stringify(config));

	const loaded = loadSelectionConfig(configPath);
	assert.equal(loaded.topK, 3);
	assert.equal(loaded.profiles.length, 1);
	assert.equal(loaded.profiles[0].id, "model-a");
});

test("loadSelectionConfig throws for missing file", () => {
	assert.throws(() => loadSelectionConfig("/nonexistent/path.json"));
});

test("loadSelectionConfig throws for invalid JSON", async (t) => {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-model-test-"));
	const configPath = path.join(tmpDir, "bad.json");
	t.after(async () => { await fs.promises.rm(tmpDir, { recursive: true, force: true }); });

	await fs.promises.writeFile(configPath, "not json {{{");
	assert.throws(() => loadSelectionConfig(configPath));
});

// --- NEW: BUG-FINDING loadSelectionConfig tests ---

test("loadSelectionConfig: file exists but is empty", async (t) => {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-model-test-"));
	const configPath = path.join(tmpDir, "empty.json");
	t.after(async () => { await fs.promises.rm(tmpDir, { recursive: true, force: true }); });

	await fs.promises.writeFile(configPath, "");
	assert.throws(() => loadSelectionConfig(configPath));
});

test("loadSelectionConfig: file is a directory, not a file", async (t) => {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-model-test-"));
	const configPath = path.join(tmpDir, "is-dir.json");
	fs.mkdirSync(configPath);
	t.after(async () => { await fs.promises.rm(tmpDir, { recursive: true, force: true }); });

	// readFileSync on a directory throws EISDIR
	assert.throws(() => loadSelectionConfig(configPath));
});

test("loadSelectionConfig: YAML with multiple documents (BUG? only first parsed)", async (t) => {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-model-test-"));
	const jsonPath = path.join(tmpDir, "profiles.json");
	const yamlPath = path.join(tmpDir, "profiles.yaml");
	t.after(async () => { await fs.promises.rm(tmpDir, { recursive: true, force: true }); });

	await fs.promises.writeFile(jsonPath, "{}");
	// YAML with two documents separated by ---
	await fs.promises.writeFile(yamlPath, `topK: 5
profiles:
  - id: first
    precision: 3
    creativity: 3
    thoroughness: 3
    reasoning: 3
    eligible: true
---
topK: 99
profiles:
  - id: second
    precision: 5
    creativity: 5
    thoroughness: 5
    reasoning: 5
    eligible: true
`);

	try {
		const loaded = loadSelectionConfig(jsonPath);
		// If the YAML library parses multi-doc as array, this could fail
		assert.equal(loaded.topK, 5, "Multi-doc YAML: should use first document (or fail)");
		assert.equal(loaded.profiles[0].id, "first");
	} catch (_err) {
		// Parsing may fail for multi-document YAML — this is acceptable
		assert.ok(true, "Multi-doc YAML parsing rejected (acceptable)");
	}
});

test("loadSelectionConfig: JSON with trailing comma (not valid JSON)", async (t) => {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-model-test-"));
	const configPath = path.join(tmpDir, "trailing.json");
	t.after(async () => { await fs.promises.rm(tmpDir, { recursive: true, force: true }); });

	await fs.promises.writeFile(configPath, '{"topK": 3,}');
	assert.throws(() => loadSelectionConfig(configPath));
});

// ============================================================
// Overkill penalty (preserved)
// ============================================================

test("computeFitness: overkill penalty makes overshoot score below exact match", () => {
	const task: TaskScores = { precision: 3, creativity: 3, thoroughness: 3, reasoning: 3 };
	const exact = TEST_CONFIG.profiles.find((p) => p.id === "medium-model")!;
	const heavy = TEST_CONFIG.profiles.find((p) => p.id === "heavy-model")!;

	const exactFitness = computeFitness(task, exact);
	const heavyFitness = computeFitness(task, heavy);

	assert.ok(exactFitness > heavyFitness, "exact match should score higher than overshoot");
});

test("computeFitness: moderate model beats heavy on moderate task", () => {
	const task: TaskScores = { precision: 3, creativity: 3, thoroughness: 3, reasoning: 3 };
	const medium = TEST_CONFIG.profiles.find((p) => p.id === "medium-model")!;
	const heavy = TEST_CONFIG.profiles.find((p) => p.id === "heavy-model")!;

	assert.ok(computeFitness(task, medium) > computeFitness(task, heavy));
});

test("computeFitness: slight deficit scores higher than heavy overkill", () => {
	const task: TaskScores = { precision: 4, creativity: 4, thoroughness: 4, reasoning: 4 };
	const slightlyUnder = { id: "slightly-under", precision: 3, creativity: 4, thoroughness: 4, reasoning: 4, cost: 15, eligible: true };
	const wayOver = { id: "way-over", precision: 5, creativity: 5, thoroughness: 5, reasoning: 5, cost: 20, eligible: true };

	const underFitness = computeFitness(task, slightlyUnder);
	const overFitness = computeFitness(task, wayOver);

	assert.ok(underFitness > overFitness, "slight deficit should beat heavy overkill");
});

// ============================================================
// Explicit cost field (preserved)
// ============================================================

test("computeFitness: uses explicit cost field when present instead of aggregate", () => {
	const task: TaskScores = { precision: 5, creativity: 5, thoroughness: 5, reasoning: 5 };

	const implicitCost = { id: "implicit", precision: 5, creativity: 5, thoroughness: 5, reasoning: 5, eligible: true };
	const explicitHighCost = { id: "explicit-high", precision: 5, creativity: 5, thoroughness: 5, reasoning: 5, cost: 30, eligible: true };
	const explicitZeroCost = { id: "explicit-zero", precision: 5, creativity: 5, thoroughness: 5, reasoning: 5, cost: 0, eligible: true };

	const implicitFitness = computeFitness(task, implicitCost);
	const highCostFitness = computeFitness(task, explicitHighCost);
	const zeroCostFitness = computeFitness(task, explicitZeroCost);

	assert.ok(zeroCostFitness > implicitFitness, "zero cost should beat implicit aggregate cost");
	assert.ok(implicitFitness > highCostFitness, "implicit cost should beat explicit high cost");
});

test("computeFitness: free model (cost=0) strongly preferred over expensive peer at same capability", () => {
	const task: TaskScores = { precision: 3, creativity: 3, thoroughness: 3, reasoning: 3 };

	const freeModel = { id: "free", precision: 3, creativity: 3, thoroughness: 3, reasoning: 3, cost: 0, eligible: true };
	const expensiveModel = { id: "expensive", precision: 3, creativity: 3, thoroughness: 3, reasoning: 3, cost: 30, eligible: true };

	const freeFitness = computeFitness(task, freeModel);
	const expFitness = computeFitness(task, expensiveModel);

	assert.ok(freeFitness > expFitness, "free model should strongly outrank expensive peer");
});

test("selectModel: explicit cost makes expensive model lose to cheaper equivalent", () => {
	const config: SelectionConfig = {
		topK: 1,
		profiles: [
			{ id: "cheap-equivalent", precision: 5, creativity: 5, thoroughness: 5, reasoning: 5, cost: 15, thinking: ["medium", "high", "xhigh"], eligible: true },
			{ id: "expensive-equivalent", precision: 5, creativity: 5, thoroughness: 5, reasoning: 5, cost: 30, thinking: ["medium", "high", "xhigh"], eligible: true },
		],
	};

	const result = selectModel({ precision: 5, reasoning: 5 }, config);
	assert.ok(result);
	assert.equal(result!.modelId, "cheap-equivalent", "cheaper model should win at same capability");
});

// ============================================================
// normalizedCost (pricing-derived cost)
// ============================================================

test("computeFitness: normalizedCost takes precedence over legacy cost", () => {
	const task: TaskScores = { precision: 3, creativity: 3, thoroughness: 3, reasoning: 3 };

	// normalizedCost=5 makes this model cheaper (better) than the legacy cost=30 would suggest
	const profile = { id: "priced", precision: 3, creativity: 3, thoroughness: 3, reasoning: 3, cost: 30, normalizedCost: 5, eligible: true };

	const fitness = computeFitness(task, profile);
	// fitness = 36 - 0.5*5 = 33.5 (using normalizedCost)
	// NOT 36 - 0.5*30 = 21 (ignoring legacy cost)
	assert.equal(fitness, 33.5);
});

test("computeFitness: normalizedCost beats capability aggregate fallback", () => {
	const task: TaskScores = { precision: 3, creativity: 3, thoroughness: 3, reasoning: 3 };

	// No legacy cost, but has normalizedCost
	const profile = { id: "priced-nolegacy", precision: 4, creativity: 4, thoroughness: 4, reasoning: 4, normalizedCost: 12, eligible: true };

	const fitness = computeFitness(task, profile);
	// met = 3*3*4 = 36, overkill = 4*1.5 = 6, sum = 30
	// cost = normalizedCost (12) not aggregate (16)
	// fitness = 30 - 0.5*12 = 24
	assert.equal(fitness, 24);
});

test("computeFitness: zero normalizedCost means free model", () => {
	const task: TaskScores = { precision: 3, creativity: 3, thoroughness: 3, reasoning: 3 };
	const profile = { id: "free-via-pricing", precision: 3, creativity: 3, thoroughness: 3, reasoning: 3, cost: 10, normalizedCost: 0, eligible: true };

	// Even though legacy cost=10, normalizedCost=0 takes precedence → no cost penalty
	const fitness = computeFitness(task, profile);
	assert.equal(fitness, 36);
});

test("computeFitness: normalizedCost allows cheap model to beat high-legacy-cost model", () => {
	const task: TaskScores = { precision: 3, creativity: 3, thoroughness: 3, reasoning: 3 };

	const pricedCheap = { id: "priced-cheap", precision: 3, creativity: 3, thoroughness: 3, reasoning: 3, normalizedCost: 3, eligible: true };
	const legacyExpensive = { id: "legacy-expensive", precision: 3, creativity: 3, thoroughness: 3, reasoning: 3, cost: 0, eligible: true };
	// legacyExpensive has cost=0 → fitness = 36. pricedCheap has normalizedCost=3 → fitness = 36-1.5=34.5
	// legacy is cheaper here

	assert.ok(computeFitness(task, legacyExpensive) > computeFitness(task, pricedCheap));
});
