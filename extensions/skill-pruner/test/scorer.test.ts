import test from "node:test";
import assert from "node:assert/strict";
import type { Skill } from "@mariozechner/pi-coding-agent";
import { DEFAULT_CONFIG } from "../config.js";
import {
	applyThreshold,
	computeKeywordOverlap,
	computeNameMatch,
	computeTriggerMatch,
	extractTriggers,
	scoreSkills,
} from "../scorer.js";
import type { PruningConfig, ScoredSkill } from "../types.js";

function skill(name: string, description: string): Skill {
	return {
		name,
		description,
		filePath: `/skills/${name}/SKILL.md`,
		baseDir: `/skills/${name}`,
		sourceInfo: {} as Skill["sourceInfo"],
		disableModelInvocation: false,
	};
}

function scored(name: string, compositeScore: number): ScoredSkill {
	return {
		skill: skill(name, `Use when ${name}.`),
		name,
		triggerScore: 0,
		keywordScore: 0,
		nameScore: 0,
		triggerNormalized: 0,
		keywordNormalized: 0,
		nameNormalized: 0,
		compositeScore,
	};
}

function config(overrides: Partial<PruningConfig["skills"]> = {}): PruningConfig {
	return {
		mode: "auto",
		skills: { ...DEFAULT_CONFIG.skills, ...overrides, pinned: overrides.pinned ?? [] },
	};
}

test("extractTriggers extracts positive Use when clauses", () => {
	assert.deepEqual(extractTriggers("Use when refactoring code. Other text."), {
		positive: ["refactoring code"],
		negative: [],
	});
});

test("extractTriggers extracts negative clauses", () => {
	assert.deepEqual(extractTriggers("Do not use for simple descriptive statistics."), {
		positive: [],
		negative: ["simple descriptive statistics"],
	});
});

test("extractTriggers handles mixed comma-separated and case-insensitive prefixes", () => {
	assert.deepEqual(extractTriggers("use for APIs, module boundaries. DO NOT USE WHEN writing UI, styling pages!"), {
		positive: ["apis", "module boundaries"],
		negative: ["writing ui", "styling pages"],
	});
});

test("extractTriggers returns empty arrays when there are no markers", () => {
	assert.deepEqual(extractTriggers("This skill helps with code quality."), { positive: [], negative: [] });
});

test("computeTriggerMatch gives high score for full positive overlap", () => {
	const score = computeTriggerMatch("Please compare treatment groups", {
		positive: ["comparing treatment groups"],
		negative: [],
	});
	assert.ok(score > 0.9);
});

test("computeTriggerMatch returns 0 for no overlap", () => {
	assert.equal(computeTriggerMatch("frontend styling", { positive: ["duckdb query optimization"], negative: [] }), 0);
});

test("computeTriggerMatch applies negative penalty", () => {
	const score = computeTriggerMatch("comparing treatment groups with simple descriptive statistics", {
		positive: ["comparing treatment groups"],
		negative: ["simple descriptive statistics"],
	});
	assert.equal(score, 0.5);
});

test("computeTriggerMatch applies the +0.3 bonus once when tokens overlap", () => {
	const score = computeTriggerMatch("auth", { positive: ["auth refactor migration"], negative: [] });
	assert.ok(score > 1 / 3);
	assert.equal(Number(score.toFixed(3)), 0.633);
});

test("computeKeywordOverlap removes stop words", () => {
	assert.equal(computeKeywordOverlap("the alpha and", "alpha"), 1);
});

test("computeKeywordOverlap weights name-token matches higher than body-only matches", () => {
	const bodyOnly = computeKeywordOverlap("zeta", "zeta filler", []);
	const nameWeighted = computeKeywordOverlap("zeta", "filler", ["zeta"]);
	assert.ok(nameWeighted > bodyOnly);
});

test("computeNameMatch splits hyphenated names and skips connectors", () => {
	assert.equal(computeNameMatch("Please review code quality", "code-review-and-quality"), 1);
	assert.equal(computeNameMatch("Please review code", "code-review-and-quality"), 2 / 3);
});

test("computeNameMatch returns 1 for full-name substring", () => {
	assert.equal(computeNameMatch("Run /skill:duckdb-query-optimization", "duckdb-query-optimization"), 1);
});

test("scoreSkills uses normalized components and 0.5/0.3/0.2 composite weights", () => {
	const scores = scoreSkills("alpha beta", "", [
		skill("alpha-tool", "Use when alpha beta."),
		skill("gamma-tool", "Use when gamma."),
	], DEFAULT_CONFIG);

	for (const score of scores) {
		assert.equal(
			score.compositeScore,
			0.5 * score.triggerNormalized + 0.3 * score.keywordNormalized + 0.2 * score.nameNormalized,
		);
	}
	assert.ok(scores[0].compositeScore > scores[1].compositeScore);
});

test("scoreSkills normalizes degenerate all-equal components to 0.5", () => {
	const scores = scoreSkills("unrelated", "", [
		skill("alpha-tool", "General helper."),
		skill("beta-tool", "Another helper."),
	], DEFAULT_CONFIG);

	assert.deepEqual(scores.map((score) => score.triggerNormalized), [0.5, 0.5]);
	assert.deepEqual(scores.map((score) => score.nameNormalized), [0.5, 0.5]);
	assert.deepEqual(scores.map((score) => score.compositeScore), [0.5, 0.5]);
});

test("applyThreshold enforces floor by topping up", () => {
	const result = applyThreshold([scored("a", 1), scored("b", 0.1), scored("c", 0.05)], [], config({ floor: 2, ceiling: 5, scoreThreshold: 0.9, gapThreshold: 1 }));
	assert.deepEqual(result.included.map((s) => s.name), ["a", "b"]);
});

test("applyThreshold enforces ceiling", () => {
	const result = applyThreshold([scored("a", 1), scored("b", 0.9), scored("c", 0.8)], [], config({ floor: 1, ceiling: 2, scoreThreshold: 0, gapThreshold: 1 }));
	assert.deepEqual(result.included.map((s) => s.name), ["a", "b"]);
	assert.deepEqual(result.excluded.map((s) => s.name), ["c"]);
});

test("applyThreshold truncates at a large score gap", () => {
	const result = applyThreshold([scored("a", 1), scored("b", 0.6), scored("c", 0.59)], [], config({ floor: 1, ceiling: 5, scoreThreshold: 0, gapThreshold: 0.3 }));
	assert.deepEqual(result.included.map((s) => s.name), ["a"]);
});

test("applyThreshold always includes pinned skills and respects ceiling for scored additions", () => {
	const result = applyThreshold([scored("a", 1), scored("b", 0.9), scored("pinned", 0)], ["pinned"], config({ floor: 1, ceiling: 2, scoreThreshold: 0, gapThreshold: 1, pinned: ["pinned"] }));
	assert.deepEqual(result.included.map((s) => s.name), ["pinned", "a"]);
	assert.equal(result.included[0].pinned, true);
});

test("applyThreshold keeps pinned skills even when they exceed ceiling", () => {
	const result = applyThreshold([scored("p1", 0), scored("p2", 0), scored("a", 1)], ["p1", "p2"], config({ floor: 1, ceiling: 1, pinned: ["p1", "p2"] }));
	assert.deepEqual(result.included.map((s) => s.name), ["p1", "p2"]);
	assert.deepEqual(result.excluded.map((s) => s.name), ["a"]);
});

test("applyThreshold all-equal degenerate case includes only floor by name asc", () => {
	const result = applyThreshold([scored("charlie", 0), scored("alpha", 0), scored("bravo", 0)], [], config({ floor: 2, ceiling: 5 }));
	assert.deepEqual(result.included.map((s) => s.name), ["alpha", "bravo"]);
	assert.deepEqual(result.excluded.map((s) => s.name), ["charlie"]);
});
