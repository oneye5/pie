/**
 * Tests for bridge.ts — the thin pass-through between the subagent
 * extension and the analytics stratified ranker.
 *
 * The bridge's contract is small but load-bearing:
 *   - surface whatever the ranker returns, and
 *   - swallow any ranker failure and return EMPTY assignments (so callers fall
 *     back to the active model).
 *
 * We inject a mock ranker via an ESM `resolve` hook (same pattern as
 * modes.test.ts) so we can drive both branches deterministically and sub-ms:
 * a ranker that THROWS (exercises the bridge's catch) and a ranker that returns
 * known data (exercises the surfacing path with non-empty assignments). This
 * replaces the previous source-text regex checks ("uses dynamic import",
 * "awaits the ranker result", "re-exports types") which passed even when the
 * behaviour was broken.
 *
 * Run: npx tsx --test extensions/subagent/test/bridge.test.ts
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getBucketAssignments } from "../bridge.js";
import type { SimpleModelConfig, BucketAssignments } from "../bridge.js";

// ---------------------------------------------------------------------------
// Mock ranker (injectable via an ESM resolve hook)
// ---------------------------------------------------------------------------
// The hook always redirects `../../analysis/scripts/stratified-ranker.js` to an
// in-memory mock, so the bridge's `await import(...)` + `return await
// computeBucketAssignments(...)` path is exercised against a ranker we fully
// control. The mock reads its per-call behaviour from
// `globalThis.__MOCK_RANKER_BEHAVIOR__` on each invocation.

const MOCK_RANKER_SOURCE = [
	"export async function computeBucketAssignments(analyticsDir, modelConfig){",
	"  const b = globalThis.__MOCK_RANKER_BEHAVIOR__;",
	"  if (b && b.throw) throw new Error(b.throw);",
	"  if (b && b.assignments) return b.assignments;",
	"  return { small: [], medium: [], frontier: [] };",
	"}",
].join("\n");

const __mockDir = mkdtempSync(path.join(tmpdir(), "bridge-mock-ranker-"));
const __mockRankerPath = path.join(__mockDir, "mock-ranker.mjs");
writeFileSync(__mockRankerPath, MOCK_RANKER_SOURCE, "utf-8");
const __hookPath = path.join(__mockDir, "hook.mjs");
writeFileSync(
	__hookPath,
	[
		"export async function resolve(specifier, context, nextResolve){",
		"  if (specifier.includes('stratified-ranker')) {",
		`    return { url: ${JSON.stringify(pathToFileURL(__mockRankerPath).href)}, shortCircuit: true };`,
		"  }",
		"  return nextResolve(specifier, context);",
		"}",
	].join("\n"),
	"utf-8",
);
// Register before any getBucketAssignments call: getBucketAssignments lazily
// does `await import("../../analysis/scripts/stratified-ranker.js")`, which the
// registered resolve hook redirects to the in-memory mock.
Module.register(pathToFileURL(__hookPath));

// Prevent mock behaviour from leaking across tests.
afterEach(() => { (globalThis as any).__MOCK_RANKER_BEHAVIOR__ = undefined; });

function setMockBehavior(b: any): void {
	(globalThis as any).__MOCK_RANKER_BEHAVIOR__ = b;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EMPTY: BucketAssignments = { small: [], medium: [], frontier: [] };

const SAMPLE_CONFIG: SimpleModelConfig[] = [
	{ id: "model-a", eligible: true, thinking: ["medium"], disabled_reason: null, cost: 1 },
	{ id: "model-b", eligible: true, thinking: ["high"], disabled_reason: null, cost: 5 },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getBucketAssignments", () => {
	it("surfaces the ranker's assignments when it succeeds with data", async () => {
		// Replaces the old "uses dynamic import" / "re-exports types" source-text
		// regex checks: the bridge could only surface the mock's known data if it
		// actually dynamically imported the (mocked) ranker and awaited its
		// result, so this proves the delegation path end-to-end.
		const known: BucketAssignments = {
			small: ["tiny-model"],
			medium: ["sonnet-a", "sonnet-b"],
			frontier: ["opus-x"],
		};
		setMockBehavior({ assignments: known });
		const result = await getBucketAssignments("/irrelevant/with/mock", SAMPLE_CONFIG);
		assert.deepStrictEqual(result, known);
		assert.equal(result.medium.length, 2);
		assert.ok(result.medium.includes("sonnet-a"));
	});

	it("returns EMPTY when the ranker throws (catch block)", async () => {
		// Replaces the old "awaits the ranker result" source-text regex check: if
		// the bridge returned the unawaited promise (or failed to await), a
		// rejecting ranker would surface as an unhandled rejection rather than the
		// EMPTY fallback — so this asserts the `return await` + try/catch.
		setMockBehavior({ throw: "ranker exploded" });
		const result = await getBucketAssignments("/irrelevant/with/mock", SAMPLE_CONFIG);
		assert.deepStrictEqual(result, EMPTY);
	});

	it("returns EMPTY when the ranker returns empty assignments", async () => {
		// The bridge is a pure pass-through on the happy path, so an empty ranker
		// result surfaces as EMPTY (mirrors the real ranker's missing/empty-dir
		// behaviour without depending on filesystem state).
		setMockBehavior({ assignments: EMPTY });
		const result = await getBucketAssignments("/irrelevant/with/mock", SAMPLE_CONFIG);
		assert.deepStrictEqual(result, EMPTY);
	});
});
