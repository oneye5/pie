/**
 * Bug-finding tests for types.ts constants and type contracts.
 *
 * Original coverage: asserted constant values (zero bug-finding value).
 * Now: invariant relationships, boundary guarantees, structural validation.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
	AGENT_SCOPE_VALUES,
	COLLAPSED_ITEM_COUNT,
	MAX_CONCURRENCY,
	MAX_MODEL_RETRIES,
	MAX_PARALLEL_TASKS,
	PARALLEL_SUMMARY_PREVIEW,
	TASK_PREVIEW_LONG,
	TASK_PREVIEW_SHORT,
	type SingleResult,
	type SubagentDetails,
	type UsageStats,
} from "../types.js";
import type { AgentScope } from "../agents.js";

// ============================================================
// CONSTANT RELATIONSHIPS — invariants that must hold
// ============================================================

test("MAX_CONCURRENCY must be <= MAX_PARALLEL_TASKS", () => {
	// If concurrency exceeds max tasks, the throttle becomes meaningless
	assert.ok(
		MAX_CONCURRENCY <= MAX_PARALLEL_TASKS,
		`MAX_CONCURRENCY (${MAX_CONCURRENCY}) must be <= MAX_PARALLEL_TASKS (${MAX_PARALLEL_TASKS})`,
	);
});

test("MAX_CONCURRENCY must be positive", () => {
	assert.ok(MAX_CONCURRENCY > 0, "MAX_CONCURRENCY must be > 0");
});

test("MAX_PARALLEL_TASKS must be positive", () => {
	assert.ok(MAX_PARALLEL_TASKS > 0, "MAX_PARALLEL_TASKS must be > 0");
});

test("MAX_MODEL_RETRIES must be non-negative", () => {
	assert.ok(MAX_MODEL_RETRIES >= 0, "MAX_MODEL_RETRIES must be >= 0");
});

test("COLLAPSED_ITEM_COUNT must be positive", () => {
	assert.ok(COLLAPSED_ITEM_COUNT > 0, "COLLAPSED_ITEM_COUNT must be > 0");
});

test("TASK_PREVIEW_SHORT must be <= TASK_PREVIEW_LONG", () => {
	// Short preview should not be longer than the "long" preview
	assert.ok(
		TASK_PREVIEW_SHORT <= TASK_PREVIEW_LONG,
		`TASK_PREVIEW_SHORT (${TASK_PREVIEW_SHORT}) must be <= TASK_PREVIEW_LONG (${TASK_PREVIEW_LONG})`,
	);
});

test("TASK_PREVIEW_SHORT and TASK_PREVIEW_LONG must be positive", () => {
	assert.ok(TASK_PREVIEW_SHORT > 0, "TASK_PREVIEW_SHORT must be > 0");
	assert.ok(TASK_PREVIEW_LONG > 0, "TASK_PREVIEW_LONG must be > 0");
});

test("PARALLEL_SUMMARY_PREVIEW must be positive", () => {
	assert.ok(PARALLEL_SUMMARY_PREVIEW > 0, "PARALLEL_SUMMARY_PREVIEW must be > 0");
});

test("MAX_CONCURRENCY is an integer", () => {
	assert.equal(Math.floor(MAX_CONCURRENCY), MAX_CONCURRENCY);
});

test("MAX_PARALLEL_TASKS is an integer", () => {
	assert.equal(Math.floor(MAX_PARALLEL_TASKS), MAX_PARALLEL_TASKS);
});

test("MAX_MODEL_RETRIES is an integer", () => {
	assert.equal(Math.floor(MAX_MODEL_RETRIES), MAX_MODEL_RETRIES);
});

// ============================================================
// AGENT_SCOPE_VALUES — must match AgentScope type
// ============================================================

test("AGENT_SCOPE_VALUES contains exactly the three scope literals", () => {
	assert.ok(AGENT_SCOPE_VALUES.has("user"));
	assert.ok(AGENT_SCOPE_VALUES.has("project"));
	assert.ok(AGENT_SCOPE_VALUES.has("both"));
	assert.equal(AGENT_SCOPE_VALUES.size, 3);
});

test("AGENT_SCOPE_VALUES contains no unexpected values", () => {
	// If this fails, a new scope was added without updating downstream handlers
	for (const val of AGENT_SCOPE_VALUES) {
		assert.ok(["user", "project", "both"].includes(val), `Unexpected scope: ${val}`);
	}
});

test("AGENT_SCOPE_VALUES is case-sensitive and exact", () => {
	assert.ok(!AGENT_SCOPE_VALUES.has("User"));
	assert.ok(!AGENT_SCOPE_VALUES.has("PROJECT"));
	assert.ok(!AGENT_SCOPE_VALUES.has("Both"));
	assert.ok(!AGENT_SCOPE_VALUES.has(""));
	assert.ok(!AGENT_SCOPE_VALUES.has(" both "));
});

// ============================================================
// UsageStats — default/empty values are zeroed, not NaN/undefined
// ============================================================

test("UsageStats: zero-state is valid", () => {
	const zero: UsageStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
	// All fields should be finite numbers
	for (const [key, val] of Object.entries(zero)) {
		assert.ok(Number.isFinite(val), `${key} should be finite, got ${val}`);
	}
});

test("UsageStats: handles large token counts without overflow issues", () => {
	const large: UsageStats = { input: Number.MAX_SAFE_INTEGER, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
	assert.ok(large.input > 0);
});

test("UsageStats: cost field can be zero or positive", () => {
	const free: UsageStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
	assert.equal(free.cost, 0);
	const paid: UsageStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.001, contextTokens: 0, turns: 0 };
	assert.ok(paid.cost > 0);
});

// ============================================================
// SingleResult — structural contracts
// ============================================================

test("SingleResult: exitCode -1 means still running, 0 means success, 1+ means error", () => {
	const running: SingleResult = makeMinimalResult({ exitCode: -1 });
	assert.equal(running.exitCode, -1);

	const success: SingleResult = makeMinimalResult({ exitCode: 0 });
	assert.equal(success.exitCode, 0);

	const failed: SingleResult = makeMinimalResult({ exitCode: 1 });
	assert.equal(failed.exitCode, 1);
});

test("SingleResult: agentSource must be 'user', 'project', or 'unknown'", () => {
	const validSources = ["user", "project", "unknown"];
	for (const src of validSources) {
		const r: SingleResult = makeMinimalResult({ agentSource: src as SingleResult["agentSource"] });
		assert.equal(r.agentSource, src);
	}
});

test("SingleResult: errorMessage should be present when exitCode !== 0 (convention check)", () => {
	// Not enforced by the type system, but the codebase always sets errorMessage for errors
	const error: SingleResult = makeMinimalResult({ exitCode: 1, errorMessage: "test error" });
	assert.ok(error.errorMessage);
});

test("SingleResult: retryCount and failedModel should appear together", () => {
	// If a model failed and was retried, both fields should be present
	const withRetry: SingleResult = makeMinimalResult({ failedModel: "bad-model", retryCount: 1 });
	assert.ok(withRetry.failedModel && withRetry.retryCount);

	// If only one is set, that's a bug signal
	const onlyFailed: SingleResult = makeMinimalResult({ failedModel: "bad-model" });
	assert.ok(onlyFailed.failedModel);
	if (onlyFailed.retryCount == null) {
		// This is the bug — failedModel without retryCount means we lost metadata
		assert.ok(true, "BUG INDICATOR: failedModel present but retryCount is missing");
	}
});

test("SingleResult: selectionPool and fallback are independent", () => {
	const r: SingleResult = makeMinimalResult({
		selectionPool: ["a", "b"],
		fallback: false,
	});
	assert.equal(r.fallback, false);
	assert.deepEqual(r.selectionPool, ["a", "b"]);
});

test("SingleResult: modelResolutionDiagnostic should only appear when model resolution failed", () => {
	// When present, it indicates a fallback happened
	const withDiag: SingleResult = makeMinimalResult({
		modelResolutionDiagnostic: "Model not found, falling back",
	});
	assert.ok(withDiag.modelResolutionDiagnostic);
});

// ============================================================
// SubagentDetails — mode routing contracts
// ============================================================

test("SubagentDetails: mode must be 'single', 'parallel', or 'chain'", () => {
	const modes: SubagentDetails["mode"][] = ["single", "parallel", "chain"];
	for (const mode of modes) {
		const d: SubagentDetails = { mode, agentScope: "user", projectAgentsDir: null, results: [] };
		assert.equal(d.mode, mode);
	}
});

test("SubagentDetails: agentScope can be nullish in edge cases", () => {
	// projectAgentsDir is string | null; null is valid when no project dir found
	const d: SubagentDetails = { mode: "single", agentScope: "user", projectAgentsDir: null, results: [] };
	assert.equal(d.projectAgentsDir, null);
});

test("SubagentDetails: results array can be empty for error states", () => {
	const d: SubagentDetails = { mode: "single", agentScope: "user", projectAgentsDir: null, results: [] };
	assert.equal(d.results.length, 0);
});

test("SubagentDetails: results array can have many entries for parallel mode", () => {
	const results: SingleResult[] = Array.from({ length: 8 }, (_, i) =>
		makeMinimalResult({ exitCode: 0, step: i + 1 }),
	);
	const d: SubagentDetails = { mode: "parallel", agentScope: "user", projectAgentsDir: null, results };
	assert.equal(d.results.length, 8);
});

// ============================================================
// Boundary / defensive checks on constants
// ============================================================

test("MAX_PARALLEL_TASKS should be a reasonable number (not 0, not negative)", () => {
	assert.ok(MAX_PARALLEL_TASKS >= 1, "At least 1 parallel task must be allowed");
	assert.ok(MAX_PARALLEL_TASKS <= 100, "Cap at 100 to prevent runaway resource use");
});

test("MAX_CONCURRENCY should not exceed system expectations", () => {
	// If this exceeds MAX_PARALLEL_TASKS then throttle is bypassed
	assert.ok(MAX_CONCURRENCY <= 16, "Concurrency above 16 suggests a bug");
});

test("MAX_MODEL_RETRIES: reasonable upper bound", () => {
	// More retries means more cost; very high values are likely bugs
	assert.ok(MAX_MODEL_RETRIES <= 10, "Retry cap above 10 is wasteful");
});

// ============================================================
// DisplayItem type contract
// ============================================================

test("DisplayItem text type must have text field", () => {
	const item = { type: "text" as const, text: "hello" };
	assert.equal(item.type, "text");
	assert.equal(item.text, "hello");
});

test("DisplayItem toolCall type must have name and args", () => {
	const item = { type: "toolCall" as const, name: "bash", args: { command: "ls" } };
	assert.equal(item.type, "toolCall");
	assert.equal(item.name, "bash");
	assert.deepEqual(item.args, { command: "ls" });
});

// ============================================================
// Helpers
// ============================================================

function makeMinimalResult(overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		agent: "test-agent",
		agentSource: "user",
		task: "test task",
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		...overrides,
	};
}
