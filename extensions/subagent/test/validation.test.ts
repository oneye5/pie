import test from "node:test";
import assert from "node:assert/strict";
import {
	buildUnknownAgentError,
	createInvalidAgentResult,
	findSuggestedAgentName,
	formatAvailableAgents,
	summarizeInvalidAgentResults,
} from "../validation.js";
import type { AgentConfig } from "../agents.js";

// --- Fixtures ---

const MOCK_AGENTS: AgentConfig[] = [
	{
		name: "worker",
		description: "General-purpose worker",
		systemPrompt: "You are a worker.",
		source: "user",
		filePath: "/fake/worker.md",
	},
	{
		name: "reviewer",
		description: "Code reviewer",
		systemPrompt: "You are a reviewer.",
		source: "user",
		filePath: "/fake/reviewer.md",
	},
	{
		name: "scout",
		description: "Scout agent",
		systemPrompt: "You are a scout.",
		source: "project",
		filePath: "/fake/scout.md",
	},
];

// --- formatAvailableAgents ---

test("formatAvailableAgents lists quoted names", () => {
	const result = formatAvailableAgents(MOCK_AGENTS);
	assert.equal(result, '"worker", "reviewer", "scout"');
});

test("formatAvailableAgents returns 'none' for empty list", () => {
	assert.equal(formatAvailableAgents([]), "none");
});

// --- findSuggestedAgentName ---

test("findSuggestedAgentName finds case-insensitive match", () => {
	assert.equal(findSuggestedAgentName("Worker", MOCK_AGENTS), "worker");
	assert.equal(findSuggestedAgentName("REVIEWER", MOCK_AGENTS), "reviewer");
});

test("findSuggestedAgentName returns undefined for no match", () => {
	assert.equal(findSuggestedAgentName("planner", MOCK_AGENTS), undefined);
});

test("findSuggestedAgentName trims whitespace", () => {
	assert.equal(findSuggestedAgentName("  worker  ", MOCK_AGENTS), "worker");
});

// --- buildUnknownAgentError ---

test("buildUnknownAgentError suggests correct name on case mismatch", () => {
	const err = buildUnknownAgentError("Worker", MOCK_AGENTS);
	assert.match(err, /Did you mean "worker"/);
});

test("buildUnknownAgentError detects scope keyword misuse", () => {
	const err = buildUnknownAgentError("both", MOCK_AGENTS);
	assert.match(err, /is an agentScope value, not an agent name/);
});

test("buildUnknownAgentError includes worker hint when worker exists", () => {
	const err = buildUnknownAgentError("nonexistent", MOCK_AGENTS);
	assert.match(err, /try "worker"/);
});

test("buildUnknownAgentError omits worker hint when no worker agent", () => {
	const noWorker = MOCK_AGENTS.filter((a) => a.name !== "worker");
	const err = buildUnknownAgentError("nonexistent", noWorker);
	assert.doesNotMatch(err, /try "worker"/);
});

test("buildUnknownAgentError lists available agents", () => {
	const err = buildUnknownAgentError("nonexistent", MOCK_AGENTS);
	assert.match(err, /Available agents: "worker", "reviewer", "scout"/);
});

// --- createInvalidAgentResult ---

test("createInvalidAgentResult builds error result with stderr", () => {
	const result = createInvalidAgentResult("bad-agent", "do stuff", MOCK_AGENTS);
	assert.equal(result.agent, "bad-agent");
	assert.equal(result.task, "do stuff");
	assert.equal(result.exitCode, 1);
	assert.equal(result.agentSource, "unknown");
	assert.equal(result.messages.length, 0);
	assert.ok(result.stderr.length > 0);
	assert.equal(result.usage.input, 0);
	assert.equal(result.usage.cost, 0);
});

test("createInvalidAgentResult includes step number when provided", () => {
	const result = createInvalidAgentResult("bad-agent", "task", MOCK_AGENTS, 3);
	assert.equal(result.step, 3);
});

test("createInvalidAgentResult omits step when not provided", () => {
	const result = createInvalidAgentResult("bad-agent", "task", MOCK_AGENTS);
	assert.equal(result.step, undefined);
});

// --- summarizeInvalidAgentResults ---

test("summarizeInvalidAgentResults returns single error directly", () => {
	const results = [createInvalidAgentResult("x", "t", MOCK_AGENTS)];
	const summary = summarizeInvalidAgentResults(results);
	// Single result returns the stderr directly — no wrapping prefix
	assert.equal(summary, results[0].stderr);
});

test("summarizeInvalidAgentResults wraps multiple errors", () => {
	const results = [
		createInvalidAgentResult("bad1", "t1", MOCK_AGENTS),
		createInvalidAgentResult("bad2", "t2", MOCK_AGENTS),
	];
	const summary = summarizeInvalidAgentResults(results);
	assert.match(summary, /Invalid agent names in 2 subagent tasks/);
	assert.match(summary, /\[bad1\]/);
	assert.match(summary, /\[bad2\]/);
});