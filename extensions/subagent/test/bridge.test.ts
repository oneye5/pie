/**
 * Tests for bridge.ts — the thin pass-through between the subagent
 * extension and the analytics stratified ranker.
 *
 * Run: npx tsx --test extensions/subagent/test/bridge.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { SimpleModelConfig, BucketAssignments } from "../bridge.js";

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
  it("returns empty assignments when analytics directory is missing (real ranker path)", async () => {
    // Without mocking — use the real ranker with a nonexistent analytics dir.
    // The real ranker catches the load error internally and returns empty.
    const { getBucketAssignments } = await import("../bridge.js");
    const result = await getBucketAssignments("/nonexistent/analytics/dir", SAMPLE_CONFIG);
    assert.deepStrictEqual(result, EMPTY);
  });

  it("returns empty assignments when analytics directory is empty", async () => {
    const { getBucketAssignments } = await import("../bridge.js");
    const { tmpdir } = await import("node:os");
    const { mkdtemp } = await import("node:fs/promises");
    const { join } = await import("node:path");

    const emptyDir = await mkdtemp(join(tmpdir(), "bridge-test-"));
    const result = await getBucketAssignments(emptyDir, SAMPLE_CONFIG);
    // Empty dir → 0 scored runs → bootstrap gate → empty assignments
    assert.deepStrictEqual(result, EMPTY);
  });

  it("uses dynamic import — not a static top-level import", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const sourcePath = path.resolve(import.meta.dirname, "../bridge.ts");
    const source = await fs.readFile(sourcePath, "utf-8");

    // No top-level static import of the ranker module
    const staticImportPattern = /^import\s+.*stratified-ranker/m;
    assert.ok(
      !staticImportPattern.test(source),
      "bridge.ts should not have a static import of stratified-ranker",
    );

    // There should be a dynamic import() call referencing the ranker
    const dynamicImportPattern = /import\s*\(\s*["'].*stratified-ranker/m;
    assert.ok(
      dynamicImportPattern.test(source),
      "bridge.ts should use dynamic import() for stratified-ranker",
    );
  });

  it("awaits the ranker result (not just returning the promise)", async () => {
    // Verify the bridge uses `await` on the ranker's result, so async
    // rejections are caught by the try/catch block.
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const sourcePath = path.resolve(import.meta.dirname, "../bridge.ts");
    const source = await fs.readFile(sourcePath, "utf-8");

    // The bridge should have `return await computeBucketAssignments(...)` not
    // just `return computeBucketAssignments(...)`
    assert.ok(
      source.includes("return await computeBucketAssignments"),
      "bridge.ts should await the computeBucketAssignments call for proper error handling",
    );
  });

  it("re-exports BucketAssignments and SimpleModelConfig types from ranker", async () => {
    // Verify the bridge re-exports types from the stratified ranker (single source of truth)
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const sourcePath = path.resolve(import.meta.dirname, "../bridge.ts");
    const source = await fs.readFile(sourcePath, "utf-8");

    assert.ok(
      source.includes("export type") && source.includes("stratified-ranker"),
      "bridge.ts should re-export types from the stratified ranker module",
    );
  });
});