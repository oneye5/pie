import test from "node:test";
import assert from "node:assert/strict";
import { selectModel, reasoningToThinking, computeFitness, loadSelectionConfig } from "../model-selection.js";
import type { SelectionConfig, TaskScores } from "../model-selection.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// --- Fixtures ---

// Config with topK=1 for deterministic single-model selection tests
const DETERMINISTIC_CONFIG: SelectionConfig = {
	topK: 1,
	profiles: [
		{ id: "light-model", precision: 2, creativity: 2, thoroughness: 2, reasoning: 1, thinking: ["minimal", "low"], eligible: true },
		{ id: "medium-model", precision: 3, creativity: 3, thoroughness: 3, reasoning: 3, thinking: ["low", "medium"], eligible: true },
		{ id: "heavy-model", precision: 5, creativity: 5, thoroughness: 5, reasoning: 5, thinking: ["medium", "high", "xhigh"], eligible: true },
		{ id: "disabled-model", precision: 5, creativity: 5, thoroughness: 5, reasoning: 5, eligible: false },
	],
};

const TEST_CONFIG: SelectionConfig = {
	topK: 2,
	profiles: [
		{ id: "light-model", precision: 2, creativity: 2, thoroughness: 2, reasoning: 1, thinking: ["minimal", "low"], eligible: true },
		{ id: "medium-model", precision: 3, creativity: 3, thoroughness: 3, reasoning: 3, thinking: ["low", "medium"], eligible: true },
		{ id: "heavy-model", precision: 5, creativity: 5, thoroughness: 5, reasoning: 5, thinking: ["medium", "high", "xhigh"], eligible: true },
		{ id: "disabled-model", precision: 5, creativity: 5, thoroughness: 5, reasoning: 5, eligible: false },
	],
};

// --- reasoningToThinking ---

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

// --- computeFitness ---

test("computeFitness: model exactly matching task has highest capped reward", () => {
	const task: TaskScores = { precision: 3, creativity: 3, thoroughness: 3, reasoning: 3 };
	const exact = TEST_CONFIG.profiles.find((p) => p.id === "medium-model")!;
	const heavy = TEST_CONFIG.profiles.find((p) => p.id === "heavy-model")!;

	// Exact match should have higher fitness than heavy overshoot because
	// heavy pays more cost penalty while capped reward is identical
	assert.ok(computeFitness(task, exact) > computeFitness(task, heavy));
});

test("computeFitness: sufficient cheaper model beats expensive overshoot for easy task", () => {
	const task: TaskScores = { precision: 2, creativity: 1, thoroughness: 2, reasoning: 1 };
	const light = TEST_CONFIG.profiles.find((p) => p.id === "light-model")!;
	const heavy = TEST_CONFIG.profiles.find((p) => p.id === "heavy-model")!;

	// Light model fully meets the requirement and is cheaper → should win
	assert.ok(computeFitness(task, light) > computeFitness(task, heavy));
});

test("computeFitness: deficit is penalized quadratically", () => {
	const hardTask: TaskScores = { precision: 5, creativity: 5, thoroughness: 5, reasoning: 5 };
	const light = TEST_CONFIG.profiles.find((p) => p.id === "light-model")!;
	const medium = TEST_CONFIG.profiles.find((p) => p.id === "medium-model")!;
	const heavy = TEST_CONFIG.profiles.find((p) => p.id === "heavy-model")!;

	// For a hard task, the order should be heavy > medium > light
	assert.ok(computeFitness(hardTask, heavy) > computeFitness(hardTask, medium));
	assert.ok(computeFitness(hardTask, medium) > computeFitness(hardTask, light));
});

test("computeFitness: surplus bonus is smaller than capped reward", () => {
	const task: TaskScores = { precision: 3, creativity: 3, thoroughness: 3, reasoning: 3 };
	const heavy = TEST_CONFIG.profiles.find((p) => p.id === "heavy-model")!;

	const fitness = computeFitness(task, heavy);
	// Heavy model has surplus of 2 per dim (5-3=2), surplus bonus = 0.3*2*4 = 2.4
	// But capped base is min(5,3)*3*4 = 36, and cost penalty = 0.5*20 = 10
	// Fitness = 36 + 2.4 - 0 - 10 = 28.4 (not 50 as dot product would give)
	assert.ok(fitness < 40, "fitness should be well below the old dot-product of 50");
	assert.ok(fitness > 0, "fitness should still be positive for a capable model");
});

test("computeFitness: model with large deficit has negative fitness", () => {
	const extremeTask: TaskScores = { precision: 5, creativity: 5, thoroughness: 5, reasoning: 5 };
	const light = TEST_CONFIG.profiles.find((p) => p.id === "light-model")!;

	// Light model (2,2,2,1) has deficit 3,3,3,4 against a 5,5,5,5 task
	// Quadratic penalty should dominate → negative fitness
	assert.ok(computeFitness(extremeTask, light) < 0);
});

// --- selectModel ---

test("selectModel returns undefined when no eligible models", () => {
	const allDisabled: SelectionConfig = { topK: 2, profiles: [
		{ id: "a", precision: 3, creativity: 3, thoroughness: 3, reasoning: 3, eligible: false },
	] };
	const result = selectModel({ precision: 3 }, allDisabled);
	assert.equal(result, undefined);
});

test("selectModel returns undefined when no model supports thinking level", () => {
	// low thinking level required, but only medium/high supported
	const onlyHigh: SelectionConfig = { topK: 2, profiles: [
		{ id: "a", precision: 3, creativity: 3, thoroughness: 3, reasoning: 3, thinking: ["medium", "high"], eligible: true },
	] };
	// reasoning 1 -> low thinking
	const result = selectModel({ precision: 3, reasoning: 1 }, onlyHigh);
	assert.equal(result, undefined);
});

test("selectModel picks heavy model for high reasoning (only model supporting xhigh)", () => {
	const result = selectModel({ precision: 5, reasoning: 5 }, TEST_CONFIG);
	assert.ok(result);
	// with reasoning 5 -> xhigh, only heavy-model supports xhigh
	assert.equal(result!.modelId, "heavy-model");
	assert.equal(result!.thinkingLevel, "xhigh");
});

test("selectModel picks light model for easy task (cheaper and sufficient)", () => {
	const result = selectModel({ precision: 2, reasoning: 1 }, DETERMINISTIC_CONFIG);
	assert.ok(result);
	// reasoning 1 -> low, both light and medium support low
	// light is sufficient for the task and cheaper → should win
	assert.equal(result!.modelId, "light-model");
	assert.equal(result!.thinkingLevel, "low");
});

test("selectModel never returns disabled model", () => {
	// Run many times to cover randomness in top-K selection
	for (let i = 0; i < 20; i++) {
		const result = selectModel({ precision: 5, reasoning: 5 }, TEST_CONFIG);
		assert.ok(result);
		assert.notEqual(result!.modelId, "disabled-model");
	}
});

test("selectModel returns pool of up to topK models", () => {
	const result = selectModel({ precision: 3, reasoning: 2 }, TEST_CONFIG);
	assert.ok(result);
	// reasoning 2 -> low, light + medium support low; topK=2 so pool is 2
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
	// Task that needs (3,2,3,2) — medium model is sufficient, heavy is overkill
	const result = selectModel({ precision: 3, thoroughness: 3, reasoning: 2 }, DETERMINISTIC_CONFIG);
	assert.ok(result);
	// reasoning 2 -> low thinking → light and medium are candidates
	// medium (3,3,3,3) meets requirements, light (2,2,2,1) has deficits
	// medium should be top-ranked
	assert.equal(result!.modelId, "medium-model");
});

test("selectModel heavily penalizes insufficient model", () => {
	// Task needing precision=4 with only light/medium available at low thinking
	// light has precision=2 (deficit of 2 → penalty=3*4=12 per dim)
	// medium has precision=3 (deficit of 1 → penalty=3*1=3)
	const result = selectModel({ precision: 4, reasoning: 1 }, DETERMINISTIC_CONFIG);
	assert.ok(result);
	// medium should be selected (much closer to the requirement)
	assert.equal(result!.modelId, "medium-model");
})

// --- loadSelectionConfig ---

test("loadSelectionConfig reads a valid JSON config file", async (t) => {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-model-test-"));
	const configPath = path.join(tmpDir, "profiles.json");
	t.after(async () => { await fs.promises.rm(tmpDir, { recursive: true, force: true }); });

	const config = { topK: 3, profiles: [
		{ id: "model-a", precision: 3, creativity: 3, thoroughness: 3, reasoning: 3, eligible: true },
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