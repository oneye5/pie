import test from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { readFileSync } from "node:fs";

import {
	getAllowedModelIdsForProviders,
	getDisabledProviders,
	loadSelectionConfig,
	selectModel,
	type ModelProviderRef,
	type SelectionConfig,
	type TaskScores,
} from "../model-selection.js";
import { loadModelPricing, resolveModelCost } from "../pricing.js";

// tsx compiles .ts files to CJS where __dirname is available.
declare const __dirname: string;

type RegistryConfig = SelectionConfig & {
	providers?: Record<string, { models?: Array<{ id?: unknown }> }>;
};

function repoRoot(): string {
	return path.resolve(__dirname, "..", "..", "..");
}

function loadRealConfig(topK = 1): RegistryConfig {
	const root = repoRoot();
	const config = loadSelectionConfig(path.join(root, "model-profiles.json")) as RegistryConfig;
	const pricingRecords = loadModelPricing(path.join(root, "models.json"));

	config.topK = topK;
	for (const profile of config.profiles) {
		const aggregate = profile.precision + profile.creativity + profile.thoroughness + profile.reasoning;
		const resolved = resolveModelCost(profile.id, pricingRecords, profile.cost, aggregate);
		if (resolved.usedSource === "pricing") {
			profile.normalizedCost = resolved.normalizedCost;
		}
	}

	return config;
}

function providerRefs(config: RegistryConfig): ModelProviderRef[] {
	const refs: ModelProviderRef[] = [];
	let providers = config.providers;
	if (!providers) {
		const modelsConfig = JSON.parse(readFileSync(path.join(repoRoot(), "models.json"), "utf-8")) as RegistryConfig;
		providers = modelsConfig.providers;
	}
	for (const [provider, providerData] of Object.entries(providers ?? {})) {
		for (const model of providerData.models ?? []) {
			if (typeof model.id === "string") refs.push({ id: model.id, provider });
		}
		for (const id of Object.keys((providerData as { modelOverrides?: Record<string, unknown> }).modelOverrides ?? {})) {
			refs.push({ id, provider });
		}
	}
	return refs;
}

function selectReal(scores: TaskScores, topK = 1, excludeModels?: Set<string>): ReturnType<typeof selectModel> {
	return selectModel(scores, loadRealConfig(topK), excludeModels);
}

test("real registry applies token pricing before selection", () => {
	const config = loadRealConfig();
	const priced = config.profiles.find((profile) => profile.id === "gpt-5-mini");

	assert.ok(priced, "expected gpt-5-mini profile to exist");
	assert.equal(typeof priced.normalizedCost, "number");
	assert.ok(Number.isFinite(priced.normalizedCost));
	assert.ok(priced.normalizedCost! > 0);
});

test("real registry selects a cheap sufficient model for easy low-reasoning tasks", () => {
	const result = selectReal({ precision: 2, creativity: 2, thoroughness: 2, reasoning: 1 });

	assert.ok(result);
	assert.equal(result.thinkingLevel, "low");
	assert.equal(result.pool[0], "gpt-5-mini");
	assert.equal(result.modelId, "gpt-5-mini");
});

test("real registry keeps moderate tasks off expensive frontier overkill models", () => {
	const result = selectReal({ precision: 3, creativity: 3, thoroughness: 3, reasoning: 3 }, 5);

	assert.ok(result);
	assert.equal(result.thinkingLevel, "medium");
	assert.equal(result.pool[0], "minimax-m2.7:cloud");
	assert.equal(result.fitScores.length, result.pool.length);
	assert.deepEqual([...result.fitScores].sort((a, b) => b - a), result.fitScores);

	const expensiveOverkill = new Set(["claude-opus-4.7", "gpt-5.5", "deepseek-v4-pro:cloud"]);
	assert.deepEqual(result.pool.filter((id) => expensiveOverkill.has(id)), []);
});

test("real registry selects top capability models for x-high reasoning tasks", () => {
	const result = selectReal({ precision: 5, creativity: 4, thoroughness: 5, reasoning: 5 });

	assert.ok(result);
	assert.equal(result.thinkingLevel, "xhigh");
	assert.equal(result.pool[0], "nemotron-3-ultra:cloud");
	assert.equal(result.modelId, "nemotron-3-ultra:cloud");
});

test("real registry retry exclusion picks the next best compatible model", () => {
	const result = selectReal(
		{ precision: 5, creativity: 4, thoroughness: 5, reasoning: 5 },
		1,
		new Set(["deepseek-v4-pro:cloud", "nemotron-3-ultra:cloud"]),
	);

	assert.ok(result);
	assert.equal(result.thinkingLevel, "xhigh");
	assert.equal(result.modelId, "gpt-5.5");
});

test("real registry provider filtering restricts selections to enabled providers", () => {
	const config = loadRealConfig(5);
	const refs = providerRefs(config);
	const refById = new Map(refs.map((ref) => [ref.id, ref.provider]));

	const ollamaOnly = getAllowedModelIdsForProviders(refs, getDisabledProviders({ "github-copilot": false }));
	const ollamaResult = selectModel(
		{ precision: 2, creativity: 2, thoroughness: 2, reasoning: 1 },
		config,
		undefined,
		ollamaOnly,
	);
	assert.ok(ollamaResult);
	assert.ok(ollamaResult.pool.length > 0);
	assert.deepEqual(ollamaResult.pool.map((id) => refById.get(id)), ollamaResult.pool.map(() => "ollama"));

	const copilotOnly = getAllowedModelIdsForProviders(refs, getDisabledProviders({ ollama: false }));
	const copilotResult = selectModel(
		{ precision: 2, creativity: 2, thoroughness: 2, reasoning: 1 },
		config,
		undefined,
		copilotOnly,
	);
	assert.ok(copilotResult);
	assert.ok(copilotResult.pool.length > 0);
	assert.deepEqual(copilotResult.pool.map((id) => refById.get(id)), copilotResult.pool.map(() => "github-copilot"));
});