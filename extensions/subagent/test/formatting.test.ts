import test from "node:test";
import assert from "node:assert/strict";
import {
	formatTokens,
	formatUsageStats,
	formatToolCall,
	getFinalOutput,
	getDisplayItems,
	formatSelectionInfo,
} from "../formatting.js";
import type { Message } from "@mariozechner/pi-ai";
import type { DisplayItem } from "../types.js";

// Minimal theme stub — returns "color:text" so assertions can check structure
const fg = (_color: any, text: string) => `<${_color}>${text}</${_color}>`;

// --- formatTokens ---

test("formatTokens: under 1000 returns raw number", () => {
	assert.equal(formatTokens(42), "42");
	assert.equal(formatTokens(999), "999");
});

test("formatTokens: 1k-9.9k returns one decimal", () => {
	assert.equal(formatTokens(1000), "1.0k");
	assert.equal(formatTokens(9900), "9.9k");
});

test("formatTokens: 10k-999k rounds to whole k", () => {
	assert.equal(formatTokens(10000), "10k");
	assert.equal(formatTokens(500000), "500k");
});

test("formatTokens: 1M+ returns one decimal M", () => {
	assert.equal(formatTokens(1000000), "1.0M");
	assert.equal(formatTokens(2500000), "2.5M");
});

// --- formatUsageStats ---

test("formatUsageStats: empty usage returns empty string", () => {
	assert.equal(formatUsageStats({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }), "");
});

test("formatUsageStats: includes turns, tokens, cost, model", () => {
	const result = formatUsageStats(
		{ input: 5000, output: 1000, cacheRead: 0, cacheWrite: 0, cost: 0.0123, turns: 3, contextTokens: 8000 },
		"test-model",
	);
	assert.match(result, /3 turns/);
	assert.match(result, /↑5\.0k/);
	assert.match(result, /↓1\.0k/);
	assert.match(result, /\$0\.0123/);
	assert.match(result, /ctx:8\.0k/);
	assert.match(result, /test-model/);
});

test("formatUsageStats: includes cache stats when present", () => {
	const result = formatUsageStats(
		{ input: 0, output: 0, cacheRead: 2000, cacheWrite: 500, cost: 0 },
	);
	assert.match(result, /R2\.0k/);
	assert.match(result, /W500/);
});

// --- getFinalOutput ---

test("getFinalOutput returns last assistant text", () => {
	const messages: Message[] = [
		{ role: "assistant", content: [{ type: "text", text: "first" }], model: "m" },
		{ role: "user", content: [{ type: "text", text: "user msg" }], model: "m" },
		{ role: "assistant", content: [{ type: "text", text: "final answer" }], model: "m" },
	];
	assert.equal(getFinalOutput(messages), "final answer");
});

test("getFinalOutput returns empty string for no assistant messages", () => {
	const messages: Message[] = [
		{ role: "user", content: [{ type: "text", text: "hello" }], model: "m" },
	];
	assert.equal(getFinalOutput(messages), "");
});

test("getFinalOutput returns empty string for empty array", () => {
	assert.equal(getFinalOutput([]), "");
});

test("getFinalOutput skips tool-call-only assistant messages", () => {
	const messages: Message[] = [
		{
			role: "assistant",
			content: [{ type: "toolCall", name: "bash", arguments: { command: "ls" } }],
			model: "m",
		},
	];
	assert.equal(getFinalOutput(messages), "");
});

// --- getDisplayItems ---

test("getDisplayItems extracts text and tool calls from assistant messages", () => {
	const messages: Message[] = [
		{ role: "user", content: [{ type: "text", text: "user msg" }], model: "m" },
		{
			role: "assistant",
			content: [
				{ type: "text", text: "thinking..." },
				{ type: "toolCall", name: "bash", arguments: { command: "ls" } },
				{ type: "text", text: "done" },
			],
			model: "m",
		},
	];
	const items = getDisplayItems(messages);
	assert.equal(items.length, 3);
	assert.equal(items[0].type, "text");
	assert.equal((items[0] as any).text, "thinking...");
	assert.equal(items[1].type, "toolCall");
	assert.equal((items[1] as any).name, "bash");
	assert.equal(items[2].type, "text");
	assert.equal((items[2] as any).text, "done");
});

test("getDisplayItems skips user messages", () => {
	const messages: Message[] = [
		{ role: "user", content: [{ type: "text", text: "skip me" }], model: "m" },
		{ role: "assistant", content: [{ type: "text", text: "keep me" }], model: "m" },
	];
	const items = getDisplayItems(messages);
	assert.equal(items.length, 1);
	assert.equal((items[0] as any).text, "keep me");
});

// --- formatToolCall ---

test("formatToolCall: bash shows command preview", () => {
	const result = formatToolCall("bash", { command: "echo hello" }, fg);
	assert.match(result, /\$ /);
	assert.match(result, /echo hello/);
});

test("formatToolCall: bash truncates long commands", () => {
	const longCmd = "a".repeat(100);
	const result = formatToolCall("bash", { command: longCmd }, fg);
	// Preview is 60 chars + "..."
	assert.match(result, /aaa\.\.\./);
});

test("formatToolCall: read shows file path", () => {
	const result = formatToolCall("read", { file_path: "/tmp/test.ts" }, fg);
	assert.match(result, /read/);
	assert.match(result, /test\.ts/);
});

test("formatToolCall: read shows offset/limit range", () => {
	const result = formatToolCall("read", { file_path: "/tmp/test.ts", offset: 10, limit: 5 }, fg);
	assert.match(result, /10-14/);
});

test("formatToolCall: write shows file path and line count", () => {
	const result = formatToolCall(
		"write",
		{ file_path: "/tmp/test.ts", content: "line1\nline2\nline3" },
		fg,
	);
	assert.match(result, /write/);
	assert.match(result, /3 lines/);
});

test("formatToolCall: edit shows file path", () => {
	const result = formatToolCall("edit", { file_path: "/tmp/test.ts" }, fg);
	assert.match(result, /edit/);
	assert.match(result, /test\.ts/);
});

test("formatToolCall: unknown tool shows JSON args", () => {
	const result = formatToolCall("custom-tool", { foo: "bar" }, fg);
	assert.match(result, /custom-tool/);
	assert.match(result, /foo/);
});

// --- formatSelectionInfo ---

test("formatSelectionInfo returns undefined when no scores or model", () => {
	assert.equal(formatSelectionInfo({}, fg), undefined);
});

test("formatSelectionInfo shows task scores", () => {
	const result = formatSelectionInfo(
		{ taskScores: { precision: 3, creativity: 1, reasoning: 5, thoroughness: 4 } },
		fg,
	);
	assert.ok(result);
	assert.match(result!, /p3/);
	assert.match(result!, /c1/);
	assert.match(result!, /r5/);
	assert.match(result!, /t4/);
});

test("formatSelectionInfo shows selected model with pool", () => {
	const result = formatSelectionInfo(
		{
			taskScores: { precision: 3 },
			selectedModel: "model-a",
			selectionPool: ["model-a", "model-b"],
			selectionFitScores: [10, 8],
		},
		fg,
	);
	assert.ok(result);
	assert.match(result!, /model-a/);
	assert.match(result!, /model-b/);
});

test("formatSelectionInfo shows thinking level alongside scores", () => {
	const result = formatSelectionInfo(
		{ taskScores: { precision: 3 }, thinkingLevel: "high" },
		fg,
	);
	assert.ok(result);
	assert.match(result!, /high/);
});

test("formatSelectionInfo shows fallback info when model failed and was retried", () => {
	const result = formatSelectionInfo(
		{
			taskScores: { precision: 3 },
			selectedModel: "model-b",
			selectionPool: ["model-b", "model-c"],
			selectionFitScores: [8, 6],
			failedModel: "model-a",
			retryCount: 1,
		},
		fg,
	);
	assert.ok(result);
	assert.match(result!, /fallback #1/);
	assert.match(result!, /skipped model-a/);
});

test("formatSelectionInfo hides fallback info when no failed model", () => {
	const result = formatSelectionInfo(
		{
			taskScores: { precision: 3 },
			selectedModel: "model-b",
			selectionPool: ["model-b"],
			selectionFitScores: [8],
		},
		fg,
	);
	assert.ok(result);
	assert.ok(!result!.includes("fallback"));
});