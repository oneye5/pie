/**
 * Tests for pure utility functions from the runner module.
 *
 * runner.ts imports @mariozechner/pi-coding-agent which isn't available locally,
 * so we inline-test the pure mapWithConcurrencyLimit logic that's defined there.
 * The actual subprocess spawning logic (runSingleAgent, getPiInvocation,
 * writePromptToTempFile) all depend on the pi SDK and are tested
 * indirectly via the orchestration tests in index.test.ts.
 */

import test from "node:test";
import assert from "node:assert/strict";

/**
 * Re-implemented from runner.ts for isolated testing.
 * The contract is: process N items with at most C concurrent workers,
 * preserving order of results.
 */
async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

// --- Tests ---

test("mapWithConcurrencyLimit: empty input returns empty array", async () => {
	const result = await mapWithConcurrencyLimit([], 4, async (x) => x * 2);
	assert.deepEqual(result, []);
});

test("mapWithConcurrencyLimit: maps all items preserving order", async () => {
	const items = [1, 2, 3, 4, 5];
	const result = await mapWithConcurrencyLimit(items, 2, async (x) => x * 10);
	assert.deepEqual(result, [10, 20, 30, 40, 50]);
});

test("mapWithConcurrencyLimit: respects concurrency limit", async () => {
	let maxConcurrent = 0;
	let currentConcurrent = 0;
	const items = [1, 2, 3, 4, 5, 6];
	const concurrency = 2;

	const result = await mapWithConcurrencyLimit(items, concurrency, async (x, _i) => {
		currentConcurrent++;
		if (currentConcurrent > maxConcurrent) maxConcurrent = currentConcurrent;
		await new Promise((r) => setTimeout(r, 10));
		currentConcurrent--;
		return x * 2;
	});

	assert.deepEqual(result, [2, 4, 6, 8, 10, 12]);
	assert.ok(maxConcurrent <= concurrency, `Expected max <= ${concurrency}, got ${maxConcurrent}`);
});

test("mapWithConcurrencyLimit: concurrency of 1 runs sequentially", async () => {
	const order: number[] = [];
	const items = [10, 20, 30];
	await mapWithConcurrencyLimit(items, 1, async (x) => {
		order.push(x);
		await new Promise((r) => setTimeout(r, 5));
		return x;
	});
	assert.deepEqual(order, [10, 20, 30]);
});

test("mapWithConcurrencyLimit: passes index to callback", async () => {
	const items = ["a", "b", "c"];
	const indices: number[] = [];
	await mapWithConcurrencyLimit(items, 2, async (_x, i) => {
		indices.push(i);
		return i;
	});
	assert.deepEqual(indices.sort(), [0, 1, 2]);
});

test("mapWithConcurrencyLimit: propagates errors", async () => {
	const items = [1, 2, 3];
	await assert.rejects(
		() => mapWithConcurrencyLimit(items, 2, async (x) => {
			if (x === 2) throw new Error("boom");
			return x;
		}),
		{ message: "boom" },
	);
});

test("mapWithConcurrencyLimit: handles single item", async () => {
	const result = await mapWithConcurrencyLimit([42], 4, async (x) => x * 2);
	assert.deepEqual(result, [84]);
});

test("mapWithConcurrencyLimit: concurrency larger than items", async () => {
	const items = [1, 2];
	const result = await mapWithConcurrencyLimit(items, 100, async (x) => x);
	assert.deepEqual(result, [1, 2]);
});

test("mapWithConcurrencyLimit: high concurrency with many items", async () => {
	const items = Array.from({ length: 20 }, (_, i) => i);
	const result = await mapWithConcurrencyLimit(items, 4, async (x) => x * 3);
	assert.deepEqual(result, items.map((x) => x * 3));
});

test("mapWithConcurrencyLimit: order preserved even with variable timing", async () => {
	const items = [1, 2, 3, 4, 5];
	// Even items are slower — order should still be preserved
	const result = await mapWithConcurrencyLimit(items, 5, async (x) => {
		const delay = x % 2 === 0 ? 20 : 5;
		await new Promise((r) => setTimeout(r, delay));
		return x * 10;
	});
	assert.deepEqual(result, [10, 20, 30, 40, 50]);
});