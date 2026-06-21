/**
 * Tests for types.ts exported constants.
 *
 * Only constant-invariant tests live here: relationships and boundaries that
 * must hold for the exported constants (MAX_*, COLLAPSED_ITEM_COUNT,
 * TASK_PREVIEW_*, PARALLEL_SUMMARY_PREVIEW, AGENT_SCOPE_VALUES). Construct-
 * then-equal tautologies (build an object, then assert the fields you just
 * set) were removed — they exercised no real code and gave false confidence.
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
} from "../types.js";

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
// AGENT_SCOPE_VALUES — must match the AgentScope union ("user" | "project" | "both")
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
