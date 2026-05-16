import test from "node:test";
import assert from "node:assert/strict";
import {
	AGENT_SCOPE_VALUES,
	MAX_CONCURRENCY,
	MAX_MODEL_RETRIES,
	MAX_PARALLEL_TASKS,
	COLLAPSED_ITEM_COUNT,
} from "../types.js";

// --- Constants ---

test("MAX_PARALLEL_TASKS is 8", () => {
	assert.equal(MAX_PARALLEL_TASKS, 8);
});

test("MAX_CONCURRENCY is 4", () => {
	assert.equal(MAX_CONCURRENCY, 4);
});

test("COLLAPSED_ITEM_COUNT is 10", () => {
	assert.equal(COLLAPSED_ITEM_COUNT, 10);
});

test("MAX_MODEL_RETRIES is 5", () => {
	assert.equal(MAX_MODEL_RETRIES, 5);
});

test("AGENT_SCOPE_VALUES contains user, project, both", () => {
	assert.ok(AGENT_SCOPE_VALUES.has("user"));
	assert.ok(AGENT_SCOPE_VALUES.has("project"));
	assert.ok(AGENT_SCOPE_VALUES.has("both"));
	assert.equal(AGENT_SCOPE_VALUES.size, 3);
});