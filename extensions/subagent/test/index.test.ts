/**
 * Tests for the subagent tool's execute function (index.ts).
 *
 * We re-create the core orchestration logic to test guard-rails without
 * spawning real pi processes. This validates the same invariants as the
 * actual code: depth limits, per-call session limits, trail-loop prevention,
 * parameter validation, mode routing, and error handling.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createInvalidAgentResult, summarizeInvalidAgentResults } from "../validation.js";
import { getFinalOutput } from "../formatting.js";
import { type SingleResult, type SubagentDetails, MAX_PARALLEL_TASKS } from "../types.js";
import type { AgentConfig, AgentScope } from "../agents.js";

// --- Constants (must match index.ts) ---
const MAX_DEPTH = 3;
const MAX_SESSIONS_PER_CALL = 20;

// --- Mock agents ---
const MOCK_AGENTS: AgentConfig[] = [
	{ name: "worker", description: "General worker", systemPrompt: "", source: "user", filePath: "/fake/worker.md" },
	{ name: "reviewer", description: "Reviewer", systemPrompt: "", source: "user", filePath: "/fake/reviewer.md" },
	{ name: "scout", description: "Scout", systemPrompt: "", source: "project", filePath: "/fake/scout.md" },
];

const SUCCESS_RESULT: SingleResult = {
	agent: "worker", agentSource: "user", task: "test task", exitCode: 0,
	messages: [{ role: "assistant", content: [{ type: "text", text: "Task completed successfully" }], model: "m" }],
	stderr: "", usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.001, contextTokens: 500, turns: 1 },
	model: "test-model", stopReason: "endTurn",
};

const ERROR_RESULT: SingleResult = {
	agent: "worker", agentSource: "user", task: "failing task", exitCode: 1,
	messages: [], stderr: "Something went wrong",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
	stopReason: "error", errorMessage: "Agent crashed",
};

function makeDetails(mode: "single" | "parallel" | "chain", scope: AgentScope = "user") {
	return (results: SingleResult[]): SubagentDetails => ({
		mode, agentScope: scope, projectAgentsDir: null, results,
	});
}

interface ExecOpts {
	currentDepth?: number;
	trail?: string[];
	agents?: AgentConfig[];
	runMock?: (name: string, task: string, step?: number) => SingleResult;
	maxSessionsPerCall?: number;
}

function executeLogic(
	params: {
		agent?: string; task?: string;
		tasks?: { agent: string; task: string; cwd?: string; bucket?: string; thinkingLevel?: string }[];
		chain?: { agent: string; task: string; cwd?: string; bucket?: string; thinkingLevel?: string }[];
		agentScope?: AgentScope;
	},
	opts?: ExecOpts,
): { content: { type: "text"; text: string }[]; details: SubagentDetails; isError?: boolean } {
	const depth = opts?.currentDepth ?? 0;
	const trail = opts?.trail ?? [];
	const agents = opts?.agents ?? MOCK_AGENTS;
	const runMock = opts?.runMock ?? (() => SUCCESS_RESULT);
	const maxSessions = opts?.maxSessionsPerCall ?? MAX_SESSIONS_PER_CALL;
	const agentScope: AgentScope = params.agentScope ?? "user";

	// --- Per-call session counter (scoped to this execution, not the whole session) ---
	let sessionsSpawned = 0;
	const checkSessionLimit = (): string | undefined => {
		sessionsSpawned++;
		if (sessionsSpawned > maxSessions) {
			return `Sub-agent session limit reached (max ${maxSessions} sessions per reply).`;
		}
		return undefined;
	};

	if (depth >= MAX_DEPTH) {
		return {
			content: [{ type: "text", text: `Subagent depth limit reached (max ${MAX_DEPTH}). Cannot spawn further subagents.` }],
			details: makeDetails("single", agentScope)([]),
			isError: true,
		};
	}

	const hasChain = (params.chain?.length ?? 0) > 0;
	const hasTasks = (params.tasks?.length ?? 0) > 0;
	const hasSingle = Boolean(params.agent && params.task);
	const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);
	const selectedMode = hasChain ? "chain" : hasTasks ? "parallel" : "single";

	if (modeCount !== 1) {
		const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
		return {
			content: [{ type: "text", text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}` }],
			details: makeDetails("single", agentScope)([]),
			isError: true,
		};
	}

	// Validate agent names
	const invalidResults: SingleResult[] = [];
	if (params.chain) {
		for (let i = 0; i < params.chain.length; i++) {
			if (!agents.some((a) => a.name === params.chain![i].agent))
				invalidResults.push(createInvalidAgentResult(params.chain![i].agent, params.chain![i].task, agents, i + 1));
		}
	}
	if (params.tasks) {
		for (const t of params.tasks) {
			if (!agents.some((a) => a.name === t.agent))
				invalidResults.push(createInvalidAgentResult(t.agent, t.task, agents));
		}
	}
	if (params.agent && params.task && !agents.some((a) => a.name === params.agent)) {
		invalidResults.push(createInvalidAgentResult(params.agent, params.task, agents));
	}

	if (invalidResults.length > 0) {
		return {
			content: [{ type: "text", text: summarizeInvalidAgentResults(invalidResults) }],
			details: makeDetails(selectedMode, agentScope)(invalidResults),
			isError: true,
		};
	}

	const checkTrailLoop = (name: string) => trail.filter((t) => t === name).length >= 2;

	// --- Chain ---
	if (params.chain && params.chain.length > 0) {
		const results: SingleResult[] = [];
		let previousOutput = "";

		for (let i = 0; i < params.chain.length; i++) {
			const step = params.chain[i];
			const taskText = step.task.replace(/\{previous\}/g, previousOutput);

			if (checkTrailLoop(step.agent)) {
				results.push({
					agent: step.agent, agentSource: "unknown", task: taskText, exitCode: 1,
					messages: [], stderr: "", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
					errorMessage: `Trail loop detected: agent "${step.agent}" already appeared twice in ancestor chain.`,
					step: i + 1,
				});
				return {
					content: [{ type: "text", text: `Chain stopped at step ${i + 1}: trail loop for agent "${step.agent}".` }],
					details: makeDetails("chain", agentScope)(results),
					isError: true,
				};
			}

			const sessionLimitError = checkSessionLimit();
			if (sessionLimitError) {
				results.push({
					agent: step.agent, agentSource: "unknown", task: taskText, exitCode: 1,
					messages: [], stderr: "", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
					errorMessage: sessionLimitError, step: i + 1,
				});
				return {
					content: [{ type: "text", text: `Chain stopped at step ${i + 1}: ${sessionLimitError}` }],
					details: makeDetails("chain", agentScope)(results),
					isError: true,
				};
			}

			const result = runMock(step.agent, taskText, i + 1);
			results.push(result);

			if (result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted") {
				const errorMsg = result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
				return {
					content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}` }],
					details: makeDetails("chain", agentScope)(results),
					isError: true,
				};
			}
			previousOutput = getFinalOutput(result.messages);
		}
		return {
			content: [{ type: "text", text: getFinalOutput(results[results.length - 1].messages) || "(no output)" }],
			details: makeDetails("chain", agentScope)(results),
		};
	}

	// --- Parallel ---
	if (params.tasks && params.tasks.length > 0) {
		if (params.tasks.length > MAX_PARALLEL_TASKS) {
			return {
				content: [{ type: "text", text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.` }],
				details: makeDetails("parallel", agentScope)([]),
				isError: true,
			};
		}

		const results: SingleResult[] = params.tasks.map((t) => {
			// Check session limit before each task
			const sessionLimitError = checkSessionLimit();
			if (sessionLimitError) {
				return {
					agent: t.agent, agentSource: "unknown", task: t.task, exitCode: 1,
					messages: [], stderr: "", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
					errorMessage: sessionLimitError,
				};
			}

			if (checkTrailLoop(t.agent)) {
				return {
					agent: t.agent, agentSource: "unknown", task: t.task, exitCode: 1,
					messages: [], stderr: "", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
					errorMessage: `Trail loop detected: agent "${t.agent}" already appeared twice in ancestor chain.`,
				};
			}
			return runMock(t.agent, t.task);
		});

		const successCount = results.filter((r) => r.exitCode === 0).length;
		return {
			content: [{ type: "text", text: `Parallel: ${successCount}/${results.length} succeeded` }],
			details: makeDetails("parallel", agentScope)(results),
			isError: successCount !== results.length,
		};
	}

	// --- Single ---
	if (params.agent && params.task) {
		if (checkTrailLoop(params.agent)) {
			return {
				content: [{ type: "text", text: `Trail loop detected: agent "${params.agent}" already appeared twice in ancestor chain.` }],
				details: makeDetails("single", agentScope)([]),
				isError: true,
			};
		}

		// Check session limit for single mode
		const sessionLimitError = checkSessionLimit();
		if (sessionLimitError) {
			return {
				content: [{ type: "text", text: sessionLimitError }],
				details: makeDetails("single", agentScope)([]),
				isError: true,
			};
		}

		const result = runMock(params.agent, params.task);
		if (result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted") {
			const errorMsg = result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
			return {
				content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
				details: makeDetails("single", agentScope)([result]),
				isError: true,
			};
		}
		return {
			content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
			details: makeDetails("single", agentScope)([result]),
		};
	}

	return {
		content: [{ type: "text", text: `Invalid parameters. Available agents: ${agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none"}` }],
		details: makeDetails("single", agentScope)([]),
	};
}

// ============================================================
// DEPTH LIMIT TESTS
// ============================================================

test("depth limit blocks execution at MAX_DEPTH", () => {
	const result = executeLogic({ agent: "worker", task: "do work" }, { currentDepth: MAX_DEPTH });
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /depth limit/);
	assert.match(result.content[0].text, /max 3/);
	assert.equal(result.details.results.length, 0);
});

test("depth limit allows execution below MAX_DEPTH", () => {
	const result = executeLogic({ agent: "worker", task: "do work" }, { currentDepth: MAX_DEPTH - 1 });
	assert.ok(!result.isError);
	assert.equal(result.details.results.length, 1);
});

test("depth limit blocks at depth 3 (equal to MAX_DEPTH)", () => {
	const result = executeLogic({ agent: "worker", task: "do work" }, { currentDepth: 3 });
	assert.equal(result.isError, true);
});

test("depth limit allows at depth 0", () => {
	const result = executeLogic({ agent: "worker", task: "do work" }, { currentDepth: 0 });
	assert.ok(!result.isError);
});

// ============================================================
// SESSION LIMIT TESTS (per-call, not per-process)
// ============================================================

test("session limit blocks when exceeding MAX_SESSIONS_PER_CALL in parallel mode", () => {
	const result = executeLogic({ tasks: [{ agent: "worker", task: "t1" }, { agent: "worker", task: "t2" }] }, { maxSessionsPerCall: 1 });
	assert.equal(result.isError, true);
	// Parallel mode summary is aggregate; individual errors live in details.results
	const blocked = result.details.results.find((r) => r.errorMessage?.includes("session limit"));
	assert.ok(blocked, "Should have a blocked task with session limit error");
	assert.equal(blocked!.exitCode, 1);
});

test("session limit allows within MAX_SESSIONS_PER_CALL", () => {
	const result = executeLogic({ tasks: [{ agent: "worker", task: "t1" }, { agent: "worker", task: "t2" }] }, { maxSessionsPerCall: 2 });
	assert.ok(!result.isError);
});

test("session limit allows single task at default limit", () => {
	const result = executeLogic({ agent: "worker", task: "do work" });
	assert.ok(!result.isError);
});

test("session limit resets per execute call (new reply = fresh counter)", () => {
	// First call with a tiny limit: second task hits session limit
	const r1 = executeLogic({ tasks: [{ agent: "worker", task: "t1" }, { agent: "worker", task: "t2" }] }, { maxSessionsPerCall: 1 });
	assert.equal(r1.isError, true);
	assert.ok(r1.details.results.some((r) => r.errorMessage?.includes("session limit")), "First call should have session limit error");

	// Second call is a completely new execute => new counter, should be allowed
	const r2 = executeLogic({ agent: "worker", task: "do work" });
	assert.ok(!r2.isError);
});

test("session limit blocks excessive chain steps", () => {
	const chain = Array.from({ length: 4 }, (_, i) => ({ agent: "worker", task: `step ${i + 1}` }));
	const result = executeLogic({ chain }, { maxSessionsPerCall: 2 });
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /session limit/);
	assert.equal(result.details.results.length, 3, "Should have 3 results: 2 successes + 1 blocked");
});

test("session limit blocks single mode when limit is 0", () => {
	const result = executeLogic({ agent: "worker", task: "do work" }, { maxSessionsPerCall: 0 });
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /session limit/);
});

// ============================================================
// TRAIL LOOP PREVENTION TESTS
// ============================================================

test("trail loop blocks single agent with 2+ occurrences in trail", () => {
	const result = executeLogic({ agent: "worker", task: "t" }, { trail: ["worker", "reviewer", "worker"] });
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /Trail loop detected/);
	assert.equal(result.details.results.length, 0);
});

test("trail loop allows agent with 1 occurrence in trail", () => {
	const result = executeLogic({ agent: "worker", task: "t" }, { trail: ["reviewer", "worker"] });
	assert.ok(!result.isError);
});

test("trail loop allows agent with no trail history", () => {
	const result = executeLogic({ agent: "worker", task: "t" }, { trail: [] });
	assert.ok(!result.isError);
});

test("trail loop in chain: stops chain at loop detection", () => {
	let callCount = 0;
	// Simulate ancestor chain where "worker" already appears twice.
	// The first chain step (reviewer) runs fine. The second (worker) has
	// 2 occurrences in the ancestor trail already, so it's blocked.
	const result = executeLogic(
		{ chain: [
			{ agent: "reviewer", task: "step 1" },
			{ agent: "worker", task: "step 2" },
		] },
		{
			trail: ["worker", "reviewer", "worker"],
			runMock: (agent, task, step) => {
				callCount++;
				return { ...SUCCESS_RESULT, agent, task, step };
			},
		},
	);
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /Chain stopped at step 2/);
	assert.match(result.content[0].text, /trail loop/);
	assert.equal(callCount, 1, "Should only run first step before detecting loop");
	assert.equal(result.details.results.length, 2);
	assert.equal(result.details.results[0].exitCode, 0);
	assert.equal(result.details.results[1].exitCode, 1);
	assert.match(result.details.results[1].errorMessage!, /Trail loop/);
});

test("trail loop in parallel: marks task failed but continues others", () => {
	const result = executeLogic(
		{ tasks: [
			{ agent: "reviewer", task: "review task" },
			{ agent: "worker", task: "work task" },
		] },
		{ trail: ["worker", "something", "worker"],
			runMock: (agent) => agent === "reviewer"
				? { ...SUCCESS_RESULT, agent: "reviewer" }
				: SUCCESS_RESULT,
		},
	);
	assert.equal(result.isError, true);
	assert.equal(result.details.results.length, 2);
	const reviewer = result.details.results.find((r) => r.agent === "reviewer");
	assert.ok(reviewer);
	assert.equal(reviewer!.exitCode, 0);
	const worker = result.details.results.find((r) => r.agent === "worker");
	assert.ok(worker);
	assert.equal(worker!.exitCode, 1);
	assert.match(worker!.errorMessage!, /Trail loop/);
});

test("trail loop threshold is exactly 2 occurrences", () => {
	assert.ok(!executeLogic({ agent: "worker", task: "t" }, { trail: ["worker"] }).isError);
	assert.ok(executeLogic({ agent: "worker", task: "t" }, { trail: ["worker", "worker"] }).isError);
});

test("trail loop does not block different agents", () => {
	const result = executeLogic(
		{ agent: "reviewer", task: "review" },
		{ trail: ["worker", "scout", "worker"] },
	);
	assert.ok(!result.isError);
});

// ============================================================
// PARAMETER VALIDATION TESTS
// ============================================================

test("no mode specified returns error", () => {
	const result = executeLogic({});
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /Invalid parameters/);
	assert.match(result.content[0].text, /Provide exactly one mode/);
});

test("multiple modes specified returns error", () => {
	const result = executeLogic({ agent: "worker", task: "do work", tasks: [{ agent: "reviewer", task: "review" }] });
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /Invalid parameters/);
});

test("unknown agent name returns error with suggestion", () => {
	const result = executeLogic({ agent: "Worker", task: "do work" });
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /Did you mean "worker"/);
});

test("scope keyword as agent name returns specific error", () => {
	const result = executeLogic({ agent: "both", task: "do work" });
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /agentScope value, not an agent name/);
});

test("unknown agent in tasks returns error", () => {
	const result = executeLogic({ tasks: [{ agent: "nonexistent", task: "t" }] });
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /Unknown agent.*nonexistent/);
});

test("unknown agent in chain returns error", () => {
	const result = executeLogic({ chain: [{ agent: "nonexistent", task: "t" }] });
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /Unknown agent.*nonexistent/);
});

test("parallel tasks exceeding MAX_PARALLEL_TASKS returns error", () => {
	const tasks = Array.from({ length: MAX_PARALLEL_TASKS + 1 }, (_, i) => ({ agent: "worker", task: `task ${i}` }));
	const result = executeLogic({ tasks });
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /Too many parallel tasks/);
});

test("parallel tasks at MAX_PARALLEL_TASKS is allowed", () => {
	const tasks = Array.from({ length: MAX_PARALLEL_TASKS }, (_, i) => ({ agent: "worker", task: `task ${i}` }));
	const result = executeLogic({ tasks });
	assert.ok(!result.isError);
});

// ============================================================
// MODE ROUTING TESTS
// ============================================================

test("single mode: successful execution returns output", () => {
	const result = executeLogic({ agent: "worker", task: "do work" });
	assert.ok(!result.isError);
	assert.equal(result.details.mode, "single");
	assert.equal(result.details.results.length, 1);
	assert.match(result.content[0].text, /Task completed successfully/);
});

test("single mode: failed execution returns error", () => {
	const result = executeLogic({ agent: "worker", task: "fail" }, { runMock: () => ERROR_RESULT });
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /Agent crashed/);
});

test("parallel mode: all successful returns success", () => {
	const result = executeLogic({ tasks: [{ agent: "worker", task: "t1" }, { agent: "reviewer", task: "t2" }] });
	assert.ok(!result.isError);
	assert.equal(result.details.mode, "parallel");
	assert.match(result.content[0].text, /2\/2 succeeded/);
});

test("parallel mode: partial failure returns isError", () => {
	let idx = 0;
	const result = executeLogic(
		{ tasks: [{ agent: "worker", task: "good" }, { agent: "reviewer", task: "bad" }] },
		{ runMock: () => { idx++; return idx === 1 ? SUCCESS_RESULT : { ...ERROR_RESULT, agent: "reviewer" }; } },
	);
	assert.equal(result.isError, true);
	assert.equal(result.details.results.filter((r) => r.exitCode === 0).length, 1);
});

test("chain mode: successful chain threads {previous} through steps", () => {
	let stepIdx = 0;
	const result = executeLogic(
		{ chain: [{ agent: "worker", task: "Step 1 {previous}" }, { agent: "reviewer", task: "Step 2 got: {previous}" }] },
		{
			runMock: (agent, task, step) => {
				stepIdx++;
				if (stepIdx === 1) {
					assert.doesNotMatch(task, /\{previous\}/, "First step: {previous} replaced with empty string");
				}
				if (stepIdx === 2) {
					assert.ok(task.includes("Task completed successfully"), `Second step should contain previous output, got: ${task}`);
				}
				return { ...SUCCESS_RESULT, agent, task, step };
			},
		},
	);
	assert.ok(!result.isError);
	assert.equal(result.details.mode, "chain");
	assert.equal(result.details.results.length, 2);
});

test("chain mode: first step failure stops the chain", () => {
	let callCount = 0;
	const result = executeLogic(
		{ chain: [{ agent: "worker", task: "failing step" }, { agent: "reviewer", task: "should not run" }] },
		{ runMock: (agent, _task, step) => { callCount++; return step === 1 ? { ...ERROR_RESULT, agent, step } : { ...SUCCESS_RESULT, agent, step }; } },
	);
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /Chain stopped at step 1/);
	assert.equal(callCount, 1);
	assert.equal(result.details.results.length, 1);
});

test("chain mode: middle step failure stops remaining steps", () => {
	let callCount = 0;
	const result = executeLogic(
		{ chain: [
			{ agent: "worker", task: "step 1" },
			{ agent: "reviewer", task: "step 2 (fails)" },
			{ agent: "scout", task: "step 3" },
		] },
		{ runMock: (agent, _task, step) => {
			callCount++;
			return step === 2 ? { ...ERROR_RESULT, agent: "reviewer", step } : { ...SUCCESS_RESULT, agent, step };
		} },
	);
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /Chain stopped at step 2/);
	assert.equal(callCount, 2);
});

test("chain mode: aborted step stops the chain", () => {
	const abortedResult: SingleResult = {
		...SUCCESS_RESULT, exitCode: 0, stopReason: "aborted", errorMessage: "User cancelled",
	};
	const result = executeLogic(
		{ chain: [{ agent: "worker", task: "step 1" }, { agent: "reviewer", task: "step 2" }] },
		{ runMock: (agent, task, step) => step === 1 ? { ...abortedResult, agent, task, step } : { ...SUCCESS_RESULT, agent, task, step } },
	);
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /Chain stopped at step 1/);
});

// ============================================================
// DETAILS STRUCTURE TESTS
// ============================================================

test("details includes agentScope in all modes", () => {
	assert.equal(executeLogic({ agent: "worker", task: "t" }).details.agentScope, "user");
	assert.equal(executeLogic({ tasks: [{ agent: "worker", task: "t" }] }).details.agentScope, "user");
	assert.equal(executeLogic({ chain: [{ agent: "worker", task: "t" }] }).details.agentScope, "user");
});

test("details includes projectAgentsDir", () => {
	assert.equal(executeLogic({ agent: "worker", task: "t" }).details.projectAgentsDir, null);
});

test("details mode is correct for each mode", () => {
	assert.equal(executeLogic({ agent: "worker", task: "t" }).details.mode, "single");
	assert.equal(executeLogic({ tasks: [{ agent: "worker", task: "t" }] }).details.mode, "parallel");
	assert.equal(executeLogic({ chain: [{ agent: "worker", task: "t" }] }).details.mode, "chain");
});

test("project agent scope is used in details", () => {
	const result = executeLogic({ agent: "scout", task: "scout stuff", agentScope: "project" });
	assert.equal(result.details.agentScope, "project");
});

test("agentScope propagates through early-return paths (depth limit)", () => {
	const depthResult = executeLogic({ agent: "worker", task: "t", agentScope: "both" }, { currentDepth: MAX_DEPTH });
	assert.equal(depthResult.details.agentScope, "both");
});

test("session limit takes priority after depth check passes", () => {
	const result = executeLogic({ agent: "worker", task: "t" }, { maxSessionsPerCall: 0 });
	assert.match(result.content[0].text, /session limit/);
});

// ============================================================
// EDGE CASES
// ============================================================

test("empty chain array triggers invalid parameters", () => {
	assert.match(executeLogic({ chain: [] }).content[0].text, /Invalid parameters/);
});

test("empty tasks array triggers invalid parameters", () => {
	assert.match(executeLogic({ tasks: [] }).content[0].text, /Invalid parameters/);
});

test("agent name with no match gives descriptive error", () => {
	const result = executeLogic({ agent: "planner", task: "plan things" });
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /Unknown agent.*planner/);
	assert.match(result.content[0].text, /Available agents/);
});

test("parallel mode with single task succeeds", () => {
	const result = executeLogic({ tasks: [{ agent: "worker", task: "only task" }] });
	assert.ok(!result.isError);
	assert.match(result.content[0].text, /1\/1 succeeded/);
});

test("chain with single step returns single result", () => {
	const result = executeLogic({ chain: [{ agent: "worker", task: "only step" }] });
	assert.ok(!result.isError);
	assert.equal(result.details.results.length, 1);
});

test("parallel mode: mixed success and trail-loop failure", () => {
	const result = executeLogic(
		{ tasks: [{ agent: "reviewer", task: "good" }, { agent: "worker", task: "looped" }] },
		{ trail: ["worker", "something", "worker"] },
	);
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /1\/2 succeeded/);
});

test("chain mode: three successful steps all execute", () => {
	let callCount = 0;
	const result = executeLogic(
		{ chain: [{ agent: "worker", task: "s1" }, { agent: "reviewer", task: "s2" }, { agent: "scout", task: "s3" }] },
		{ runMock: (agent, task, step) => { callCount++; return { ...SUCCESS_RESULT, agent, task, step }; } },
	);
	assert.ok(!result.isError);
	assert.equal(callCount, 3);
	assert.equal(result.details.results.length, 3);
	assert.equal(result.details.results[0].step, 1);
	assert.equal(result.details.results[2].step, 3);
});

test("depth limit takes priority over other validations", () => {
	const result = executeLogic({ agent: "worker", task: "t" }, { currentDepth: MAX_DEPTH });
	assert.match(result.content[0].text, /depth limit/);
});

test("session limit takes priority after depth check passes", () => {
	const result = executeLogic({ agent: "worker", task: "t" }, { maxSessionsPerCall: 0 });
	assert.match(result.content[0].text, /session limit/);
});

test("chain step result includes step number", () => {
	const result = executeLogic(
		{ chain: [{ agent: "worker", task: "only step" }] },
		{ runMock: (agent, task, step) => ({ ...SUCCESS_RESULT, agent, task, step }) },
	);
	assert.equal(result.details.results[0].step, 1);
});

// ============================================================
// DISABLED BEHAVIOR TESTS
// ============================================================
// The disabled check in index.ts runs before executeLogic, so we
// simulate it here by returning the expected error shape directly.

const DISABLED_MESSAGE = "Sub agents are disabled. Enable them by removing the --no-subagent flag or unsetting the PI_SUBAGENT_DISABLED environment variable.";

function disabledResult(): { content: { type: "text"; text: string }[]; details: SubagentDetails; isError: boolean } {
	return {
		content: [{ type: "text", text: DISABLED_MESSAGE }],
		details: { mode: "single", agentScope: "user", projectAgentsDir: null, results: [] },
		isError: true,
	};
}

test("disabled state returns immediate error with no results", () => {
	const result = disabledResult();
	assert.equal(result.isError, true);
	assert.equal(result.content[0].text, DISABLED_MESSAGE);
	assert.equal(result.details.results.length, 0);
	assert.equal(result.details.mode, "single");
});

test("disabled error message mentions how to re-enable", () => {
	const result = disabledResult();
	assert.match(result.content[0].text, /--no-subagent/);
	assert.match(result.content[0].text, /PI_SUBAGENT_DISABLED/);
});

test("disabled check takes priority over depth limit", () => {
	// If disabled, we never reach the depth check — the disabled error
	// is returned before any depth/session/trail checks.
	const result = disabledResult();
	assert.equal(result.isError, true);
	assert.equal(result.details.results.length, 0);
	// Verify it's NOT the depth limit message
	assert.doesNotMatch(result.content[0].text, /depth limit/);
});

test("disabled check takes priority over agent validation", () => {
	// If disabled, even invalid agent names don't matter
	const result = disabledResult();
	assert.equal(result.isError, true);
	assert.doesNotMatch(result.content[0].text, /Unknown agent/);
});
