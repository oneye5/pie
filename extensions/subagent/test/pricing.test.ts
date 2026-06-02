/**
 * Tests for pricing.ts — ModelTokenPricing parser, normalization, and cost resolution.
 *
 * Covers: parser behavior (complete, missing, partial, zero, malformed),
 * normalization formula, fallback order, rejection of negative/invalid prices.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
	estimateNormalizedCost,
	parseModelPricing,
	resolveModelCost,
	type ModelTokenPricing,
} from "../pricing.js";

// ============================================================
// parseModelPricing
// ============================================================

test("parseModelPricing: complete valid pricing returns all fields", () => {
	const result = parseModelPricing({ input: 1.5, output: 5.0, cacheRead: 0.25, cacheWrite: 0.5 });
	assert.deepEqual(result, { input: 1.5, output: 5.0, cacheRead: 0.25, cacheWrite: 0.5 });
});

test("parseModelPricing: free/local model (all zeros) returns valid zero pricing", () => {
	const result = parseModelPricing({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	assert.deepEqual(result, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});

test("parseModelPricing: missing cost field returns undefined", () => {
	assert.equal(parseModelPricing(undefined), undefined);
	assert.equal(parseModelPricing(null), undefined);
});

test("parseModelPricing: non-object cost returns undefined", () => {
	assert.equal(parseModelPricing("string"), undefined);
	assert.equal(parseModelPricing(42), undefined);
	assert.equal(parseModelPricing([]), undefined);
	assert.equal(parseModelPricing(true), undefined);
});

test("parseModelPricing: partial pricing missing input defaults to 0", () => {
	const result = parseModelPricing({ output: 5.0 });
	assert.deepEqual(result, { input: 0, output: 5.0, cacheRead: 0, cacheWrite: 0 });
});

test("parseModelPricing: partial pricing missing output defaults to 0", () => {
	const result = parseModelPricing({ input: 1.5 });
	assert.deepEqual(result, { input: 1.5, output: 0, cacheRead: 0, cacheWrite: 0 });
});

test("parseModelPricing: negative input is rejected", () => {
	assert.equal(parseModelPricing({ input: -1, output: 5 }), undefined);
});

test("parseModelPricing: negative output is rejected", () => {
	assert.equal(parseModelPricing({ input: 1, output: -5 }), undefined);
});

test("parseModelPricing: negative cacheRead is rejected", () => {
	assert.equal(parseModelPricing({ input: 1, output: 5, cacheRead: -0.1 }), undefined);
});

test("parseModelPricing: negative cacheWrite is rejected", () => {
	assert.equal(parseModelPricing({ input: 1, output: 5, cacheWrite: -0.1 }), undefined);
});

test("parseModelPricing: NaN input is rejected", () => {
	assert.equal(parseModelPricing({ input: NaN, output: 5 }), undefined);
});

test("parseModelPricing: Infinity input is rejected", () => {
	assert.equal(parseModelPricing({ input: Infinity, output: 5 }), undefined);
});

test("parseModelPricing: string values are rejected", () => {
	assert.equal(parseModelPricing({ input: "1.5", output: 5 }), undefined);
	assert.equal(parseModelPricing({ input: 1.5, output: "5" }), undefined);
});

test("parseModelPricing: empty object returns zero pricing", () => {
	const result = parseModelPricing({});
	assert.deepEqual(result, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});

// ============================================================
// estimateNormalizedCost
// ============================================================

test("estimateNormalizedCost: baseline model (sonnet-4.6: $3/$15) normalizes to ~10", () => {
	const pricing: ModelTokenPricing = { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 };
	// blended = (3*3 + 15) / 4 = 24/4 = 6.00
	// normalized = 10 * sqrt(6.00 / 6.00) = 10
	const cost = estimateNormalizedCost(pricing);
	assert.ok(cost >= 9.9 && cost <= 10.1, `Expected ~10, got ${cost}`);
});

test("estimateNormalizedCost: free model normalizes to 0", () => {
	const pricing: ModelTokenPricing = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	assert.equal(estimateNormalizedCost(pricing), 0);
});

test("estimateNormalizedCost: expensive model gets higher penalty than cheap model", () => {
	const cheap: ModelTokenPricing = { input: 0.25, output: 2.00, cacheRead: 0.025, cacheWrite: 0 };
	// blended = (3*0.25 + 2) / 4 = 2.75/4 = 0.6875
	// normalized = 10 * sqrt(0.6875 / 6) ≈ 3.38

	const expensive: ModelTokenPricing = { input: 5.00, output: 25.00, cacheRead: 0.50, cacheWrite: 6.25 };
	// blended = (3*5 + 25) / 4 = 40/4 = 10.00
	// normalized = 10 * sqrt(10 / 6) ≈ 12.91

	assert.ok(estimateNormalizedCost(expensive) > estimateNormalizedCost(cheap));
});

test("estimateNormalizedCost: very expensive model (gpt-5.5: $5/$30) > baseline", () => {
	const pricing: ModelTokenPricing = { input: 5.00, output: 30.00, cacheRead: 0.50, cacheWrite: 0 };
	// blended = (15 + 30) / 4 = 11.25
	// normalized = 10 * sqrt(11.25 / 6) ≈ 13.69
	const cost = estimateNormalizedCost(pricing);
	assert.ok(cost > 10, `gpt-5.5 should be above baseline, got ${cost}`);
	assert.ok(cost < 20, `gpt-5.5 should not be extreme, got ${cost}`);
});

test("estimateNormalizedCost: cheap model (gpt-5-mini: $0.25/$2) < baseline", () => {
	const pricing: ModelTokenPricing = { input: 0.25, output: 2.00, cacheRead: 0.025, cacheWrite: 0 };
	// blended = (0.75 + 2) / 4 = 0.6875
	// normalized = 10 * sqrt(0.6875 / 6) ≈ 3.38
	const cost = estimateNormalizedCost(pricing);
	assert.ok(cost < 10, `gpt-5-mini should be below baseline, got ${cost}`);
	assert.ok(cost > 0, "gpt-5-mini should have non-zero cost");
});

test("estimateNormalizedCost: all models produce non-negative finite results", () => {
	const testPrices: ModelTokenPricing[] = [
		{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		{ input: 0.25, output: 2.00, cacheRead: 0, cacheWrite: 0 },
		{ input: 1.00, output: 5.00, cacheRead: 0.10, cacheWrite: 1.25 },
		{ input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 },
		{ input: 5.00, output: 30.00, cacheRead: 0.50, cacheWrite: 0 },
		{ input: 0.20, output: 1.25, cacheRead: 0.02, cacheWrite: 0 },
		{ input: 0.0817, output: 0.0817, cacheRead: 0, cacheWrite: 0 }, // ollama cloud cheap
		{ input: 0.2050, output: 0.2050, cacheRead: 0, cacheWrite: 0 },  // ollama cloud expensive
	];

	for (const pricing of testPrices) {
		const cost = estimateNormalizedCost(pricing);
		assert.ok(Number.isFinite(cost), `Cost should be finite for ${JSON.stringify(pricing)}, got ${cost}`);
		assert.ok(cost >= 0, `Cost should be non-negative for ${JSON.stringify(pricing)}, got ${cost}`);
	}
});

test("estimateNormalizedCost: caching fields do not affect the blended cost", () => {
	// cacheRead and cacheWrite are NOT used in the 3:1 input:output blend
	const noCache: ModelTokenPricing = { input: 3.00, output: 15.00, cacheRead: 0, cacheWrite: 0 };
	const withCache: ModelTokenPricing = { input: 3.00, output: 15.00, cacheRead: 100, cacheWrite: 100 };
	assert.equal(estimateNormalizedCost(noCache), estimateNormalizedCost(withCache));
});

// ============================================================
// resolveModelCost
// ============================================================

test("resolveModelCost: uses pricing when available", () => {
	const records = new Map([
		["test-model", [{ id: "test-model", provider: "test", pricing: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 } }]],
	]);
	const result = resolveModelCost("test-model", records, 30, 18);
	assert.equal(result.usedSource, "pricing");
	assert.ok(result.normalizedCost > 0, "Should have non-zero normalized cost");
});

test("resolveModelCost: uses legacy cost when pricing missing", () => {
	const result = resolveModelCost("test-model", new Map(), 12, 16);
	assert.equal(result.usedSource, "legacy");
	assert.equal(result.normalizedCost, 12);
});

test("resolveModelCost: uses aggregate when both pricing and legacy missing", () => {
	const result = resolveModelCost("test-model", new Map(), undefined, 16);
	assert.equal(result.usedSource, "aggregate");
	assert.equal(result.normalizedCost, 16);
});

test("resolveModelCost: uses aggregate when legacy is undefined and pricing missing", () => {
	const result = resolveModelCost("test-model", new Map(), undefined, 12);
	assert.equal(result.usedSource, "aggregate");
	assert.equal(result.normalizedCost, 12);
});

test("resolveModelCost: pricing beats legacy when both available", () => {
	const records = new Map([
		["test-model", [{ id: "test-model", provider: "test", pricing: { input: 1, output: 5, cacheRead: 0, cacheWrite: 0 } }]],
	]);
	// With pricing: blended = (3*1+5)/4 = 2. normalized = 10*sqrt(2/6) ≈ 5.77
	// Legacy cost = 30
	const result = resolveModelCost("test-model", records, 30, 18);
	assert.equal(result.usedSource, "pricing");
	assert.ok(result.normalizedCost < 30, "Pricing-based cost should differ from legacy value");
});

test("resolveModelCost: free pricing + zero legacy cost = 0 cost", () => {
	const records = new Map([
		["free-model", [{ id: "free-model", provider: "local", pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }]],
	]);
	const result = resolveModelCost("free-model", records, 0, 8);
	assert.equal(result.usedSource, "pricing");
	assert.equal(result.normalizedCost, 0);
});

test("resolveModelCost: model not found in pricing map falls back to legacy", () => {
	const records = new Map([
		["other-model", [{ id: "other-model", provider: "test", pricing: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 } }]],
	]);
	const result = resolveModelCost("my-model", records, 15, 20);
	assert.equal(result.usedSource, "legacy");
	assert.equal(result.normalizedCost, 15);
});

test("resolveModelCost: duplicate ids across providers — uses first matching record", () => {
	const records = new Map([
		["dup-model", [
			{ id: "dup-model", provider: "provider-a", pricing: { input: 1, output: 5, cacheRead: 0, cacheWrite: 0 } },
			{ id: "dup-model", provider: "provider-b", pricing: { input: 10, output: 50, cacheRead: 0, cacheWrite: 0 } },
		]],
	]);
	const result = resolveModelCost("dup-model", records, undefined, 18);
	assert.equal(result.usedSource, "pricing");
	// First record wins
	const expected = estimateNormalizedCost({ input: 1, output: 5, cacheRead: 0, cacheWrite: 0 });
	assert.equal(result.normalizedCost, expected);
});

test("resolveModelCost: returns all source types correctly", () => {
	// Pricing path
	const r1 = resolveModelCost("m", new Map([["m", [{ id: "m", provider: "p", pricing: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 } }]]]), undefined, 18);
	assert.equal(r1.usedSource, "pricing");

	// Legacy path
	const r2 = resolveModelCost("m", new Map(), 10, 18);
	assert.equal(r2.usedSource, "legacy");

	// Aggregate path
	const r3 = resolveModelCost("m", new Map(), undefined, 18);
	assert.equal(r3.usedSource, "aggregate");
});

// ============================================================
// loadModelPricing (filesystem-based)
// ============================================================

import { loadModelPricing } from "../pricing.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

test("loadModelPricing: reads valid models.json", async (t) => {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-pricing-test-"));
	const filePath = path.join(tmpDir, "models.json");
	t.after(async () => { await fs.promises.rm(tmpDir, { recursive: true, force: true }); });

	const models = {
		providers: {
			copilot: {
				models: [
					{ id: "claude-sonnet-4.6", cost: { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 } },
					{ id: "gpt-5.5", cost: { input: 5.00, output: 30.00, cacheRead: 0.50, cacheWrite: 0 } },
				],
			},
			ollama: {
				models: [
					{ id: "deepseek-v4-pro:cloud", cost: { input: 0.0817, output: 0.0817, cacheRead: 0, cacheWrite: 0 } },
				],
			},
		},
	};
	await fs.promises.writeFile(filePath, JSON.stringify(models));

	const records = loadModelPricing(filePath);
	assert.equal(records.size, 3);
	assert.ok(records.has("claude-sonnet-4.6"));
	assert.ok(records.has("gpt-5.5"));
	assert.ok(records.has("deepseek-v4-pro:cloud"));

	const claude = records.get("claude-sonnet-4.6")![0];
	assert.equal(claude.provider, "copilot");
	assert.deepEqual(claude.pricing, { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 });
});

test("loadModelPricing: missing file returns empty map", () => {
	const records = loadModelPricing("/nonexistent/path/models.json");
	assert.equal(records.size, 0);
});

test("loadModelPricing: malformed JSON returns empty map", async (t) => {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-pricing-test-"));
	const filePath = path.join(tmpDir, "models.json");
	t.after(async () => { await fs.promises.rm(tmpDir, { recursive: true, force: true }); });

	await fs.promises.writeFile(filePath, "{ not json");
	const records = loadModelPricing(filePath);
	assert.equal(records.size, 0);
});

test("loadModelPricing: empty providers returns empty map", async (t) => {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-pricing-test-"));
	const filePath = path.join(tmpDir, "models.json");
	t.after(async () => { await fs.promises.rm(tmpDir, { recursive: true, force: true }); });

	await fs.promises.writeFile(filePath, JSON.stringify({ providers: {} }));
	assert.equal(loadModelPricing(filePath).size, 0);
});

test("loadModelPricing: model with no cost field is skipped", async (t) => {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-pricing-test-"));
	const filePath = path.join(tmpDir, "models.json");
	t.after(async () => { await fs.promises.rm(tmpDir, { recursive: true, force: true }); });

	const models = {
		providers: {
			copilot: {
				models: [
					{ id: "no-cost-model" },
				],
			},
		},
	};
	await fs.promises.writeFile(filePath, JSON.stringify(models));

	// Model without cost field: parseModelPricing returns undefined → model is not added to pricing map
	const records = loadModelPricing(filePath);
	assert.equal(records.size, 0);
});

test("loadModelPricing: model with negative cost is skipped", async (t) => {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-pricing-test-"));
	const filePath = path.join(tmpDir, "models.json");
	t.after(async () => { await fs.promises.rm(tmpDir, { recursive: true, force: true }); });

	const models = {
		providers: {
			copilot: {
				models: [
					{ id: "bad-cost", cost: { input: -1, output: 5 } },
				],
			},
		},
	};
	await fs.promises.writeFile(filePath, JSON.stringify(models));

	const records = loadModelPricing(filePath);
	assert.equal(records.size, 0, "Model with negative cost should be skipped");
});

test("loadModelPricing: model with no id is skipped", async (t) => {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-pricing-test-"));
	const filePath = path.join(tmpDir, "models.json");
	t.after(async () => { await fs.promises.rm(tmpDir, { recursive: true, force: true }); });

	const models = {
		providers: {
			copilot: {
				models: [{ cost: { input: 3, output: 15 } }],
			},
		},
	};
	await fs.promises.writeFile(filePath, JSON.stringify(models));
	assert.equal(loadModelPricing(filePath).size, 0);
});

test("loadModelPricing: provider without models array is handled gracefully", async (t) => {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-pricing-test-"));
	const filePath = path.join(tmpDir, "models.json");
	t.after(async () => { await fs.promises.rm(tmpDir, { recursive: true, force: true }); });

	await fs.promises.writeFile(filePath, JSON.stringify({ providers: { copilot: {} } }));
	assert.equal(loadModelPricing(filePath).size, 0);
});

test("loadModelPricing: nullish providers field", async (t) => {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-pricing-test-"));
	const filePath = path.join(tmpDir, "models.json");
	t.after(async () => { await fs.promises.rm(tmpDir, { recursive: true, force: true }); });

	await fs.promises.writeFile(filePath, JSON.stringify({}));
	assert.equal(loadModelPricing(filePath).size, 0);
});

test("loadModelPricing: zero-cost model is loaded correctly", async (t) => {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-pricing-test-"));
	const filePath = path.join(tmpDir, "models.json");
	t.after(async () => { await fs.promises.rm(tmpDir, { recursive: true, force: true }); });

	const models = {
		providers: {
			ollama: {
				models: [
					{ id: "local-model", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
				],
			},
		},
	};
	await fs.promises.writeFile(filePath, JSON.stringify(models));

	const records = loadModelPricing(filePath);
	assert.equal(records.size, 1);
	const entry = records.get("local-model")![0];
	assert.deepEqual(entry.pricing, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});
