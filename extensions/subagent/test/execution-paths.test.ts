import test from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import type { AgentConfig } from "../agents.js";
import { runSingleAgent } from "../runner.js";
import { execute, validateSubagentParams } from "../src/execute.js";

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "worker",
		description: "test agent",
		systemPrompt: "",
		source: "user",
		filePath: "worker.md",
		...overrides,
	};
}

function makeModelRegistry() {
	const model = { id: "model-a", provider: "test" } as any;
	return {
		getAvailable: () => [model],
		getAll: () => [model],
		find: (_provider: string, id: string) => (id === model.id ? model : undefined),
	} as any;
}

function makeParentBridge() {
	const calls = {
		cancelAll: 0,
	};
	const bridge = {
		select: async () => undefined,
		confirm: async () => true,
		input: async () => undefined,
		notify: () => undefined,
		cancelAll: () => {
			calls.cancelAll++;
		},
	};
	return { bridge, calls };
}

function createFakeSdk(options?: {
	onPrompt?: (emit: (event: any) => void) => Promise<void>;
}) {
	const state = {
		setUIContextCalls: 0,
		abortCalls: 0,
		disposeCalls: 0,
		unsubscribeCalls: 0,
		promptCalls: 0,
	};

	const listeners: Array<(event: any) => void> = [];
	let releasePrompt: (() => void) | undefined;

	const session = {
		agent: { state: { model: { id: "session-model" } } },
		extensionRunner: {
			setUIContext: (_ctx: unknown) => {
				state.setUIContextCalls++;
			},
		},
		subscribe: (cb: (event: any) => void) => {
			listeners.push(cb);
			return () => {
				state.unsubscribeCalls++;
			};
		},
		prompt: async (_prompt: string) => {
			state.promptCalls++;
			if (options?.onPrompt) {
				await options.onPrompt((event) => {
					for (const listener of listeners) listener(event);
				});
				return;
			}
			await new Promise<void>((resolve) => {
				releasePrompt = resolve;
			});
		},
		abort: async () => {
			state.abortCalls++;
			releasePrompt?.();
		},
		dispose: () => {
			state.disposeCalls++;
		},
	};

	const sdk = {
		createSession: async () => ({ session }),
		createResourceLoader: () => ({ reload: async () => undefined }),
		createSessionManager: () => ({}),
		getAgentDir: () => ".",
	};

	return { sdk, state };
}

test("runSingleAgent returns successful result and captures usage/model", async () => {
	const { sdk, state } = createFakeSdk({
		onPrompt: async (emit) => {
			emit({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "done" }],
					usage: {
						input: 11,
						output: 5,
						cacheRead: 2,
						cacheWrite: 1,
						totalTokens: 16,
						cost: { total: 0.42 },
					},
					model: "assistant-model",
					stopReason: "completed",
				},
			});
		},
	});

	const result = await runSingleAgent(
		process.cwd(),
		[makeAgent()],
		"worker",
		"do work",
		undefined,
		undefined,
		undefined,
		undefined,
		(results) => ({ mode: "single", agentScope: "user", projectAgentsDir: null, results }),
		makeModelRegistry(),
		undefined,
		{ modelId: "model-a", bucket: "medium", thinkingLevel: "low", pool: ["model-a"], fallback: false },
		undefined,
		undefined,
		undefined,
		{ sdk: sdk as any, timeoutMs: 50 },
	);

	assert.equal(result.exitCode, 0);
	assert.equal(result.model, "assistant-model");
	assert.equal(result.usage.input, 11);
	assert.equal(result.usage.output, 5);
	assert.equal(result.usage.cost, 0.42);
	assert.equal(state.promptCalls, 1);
	assert.equal(state.unsubscribeCalls, 1);
	assert.equal(state.disposeCalls, 1);
});

test("runSingleAgent handles already-aborted parent signal and settles pending UI", async () => {
	const { sdk, state } = createFakeSdk({
		onPrompt: async () => undefined,
	});
	const { bridge, calls } = makeParentBridge();
	const controller = new AbortController();
	controller.abort();

	const result = await runSingleAgent(
		process.cwd(),
		[makeAgent()],
		"worker",
		"do work",
		undefined,
		undefined,
		controller.signal,
		undefined,
		(results) => ({ mode: "single", agentScope: "user", projectAgentsDir: null, results }),
		makeModelRegistry(),
		undefined,
		undefined,
		undefined,
		"tool-1",
		bridge,
		{ sdk: sdk as any, timeoutMs: 50 },
	);

	assert.equal(result.exitCode, 1);
	assert.equal(result.errorMessage, "Subagent was aborted");
	assert.equal(calls.cancelAll, 1);
	assert.equal(state.abortCalls, 1);
	assert.equal(state.setUIContextCalls, 1);
	assert.equal(state.unsubscribeCalls, 1);
	assert.equal(state.disposeCalls, 1);
});

test("runSingleAgent returns timeout failure and calls cancelAll", async () => {
	const { sdk, state } = createFakeSdk();
	const { bridge, calls } = makeParentBridge();

	const result = await runSingleAgent(
		process.cwd(),
		[makeAgent()],
		"worker",
		"do work",
		undefined,
		undefined,
		undefined,
		undefined,
		(results) => ({ mode: "single", agentScope: "user", projectAgentsDir: null, results }),
		makeModelRegistry(),
		undefined,
		undefined,
		undefined,
		"tool-timeout",
		bridge,
		{ sdk: sdk as any, timeoutMs: 10 },
	);

	assert.equal(result.exitCode, 1);
	assert.equal(result.stopReason, "timeout");
	assert.match(result.errorMessage ?? "", /timed out after 0.01s/);
	assert.equal(calls.cancelAll, 1);
	assert.ok(state.abortCalls >= 1);
	assert.equal(state.unsubscribeCalls, 1);
	assert.equal(state.disposeCalls, 1);
});

test("runSingleAgent with timeout disabled and no parent signal completes normally", async () => {
	// Default (env unset) = no timeout. With no parent signal either, the prompt
	// runs uninterrupted until it completes naturally — exercises the
	// `!parentSignal && timeoutMs <= 0` branch of buildCombinedAbortSignal.
	const prevTimeout = process.env.PI_SUBAGENT_TIMEOUT_MS;
	delete process.env.PI_SUBAGENT_TIMEOUT_MS;
	try {
		const { sdk, state } = createFakeSdk({
			onPrompt: async (emit) => {
				emit({
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "done" }],
						usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
						model: "m",
						stopReason: "completed",
					},
				});
			},
		});

		const result = await runSingleAgent(
			process.cwd(),
			[makeAgent()],
			"worker",
			"do work",
			undefined,
			undefined,
			undefined, // no parent signal
			undefined,
			(results) => ({ mode: "single", agentScope: "user", projectAgentsDir: null, results }),
			makeModelRegistry(),
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			{ sdk: sdk as any }, // no timeoutMs seam → default (disabled)
		);

		assert.equal(result.exitCode, 0);
		assert.equal(result.model, "m");
		assert.equal(state.promptCalls, 1);
		assert.equal(state.unsubscribeCalls, 1);
		assert.equal(state.disposeCalls, 1);
	} finally {
		if (prevTimeout === undefined) delete process.env.PI_SUBAGENT_TIMEOUT_MS;
		else process.env.PI_SUBAGENT_TIMEOUT_MS = prevTimeout;
	}
});

test("runSingleAgent with timeout disabled: parent abort interrupts without timeout stamp", async () => {
	// Default (env unset) = no timeout. A hanging prompt must be interruptible
	// via the parent abort signal, and the result must NOT be stamped as a
	// timeout — exercises the `parentSignal && timeoutMs <= 0` branch.
	const prevTimeout = process.env.PI_SUBAGENT_TIMEOUT_MS;
	delete process.env.PI_SUBAGENT_TIMEOUT_MS;
	try {
		const { sdk, state } = createFakeSdk(); // prompt hangs until abort
		const { bridge, calls } = makeParentBridge();
		const controller = new AbortController();

		const resultPromise = runSingleAgent(
			process.cwd(),
			[makeAgent()],
			"worker",
			"do work",
			undefined,
			undefined,
			controller.signal,
			undefined,
			(results) => ({ mode: "single", agentScope: "user", projectAgentsDir: null, results }),
			makeModelRegistry(),
			undefined,
			undefined,
			undefined,
			"tool-no-timeout",
			bridge,
			{ sdk: sdk as any }, // no timeoutMs seam → default (disabled)
		);

		setTimeout(() => controller.abort(), 5);
		const result = await resultPromise;

		assert.equal(result.exitCode, 1);
		assert.notEqual(result.stopReason, "timeout");
		assert.doesNotMatch(result.errorMessage ?? "", /timed out/);
		assert.ok(state.abortCalls >= 1);
		assert.equal(calls.cancelAll, 1);
		assert.equal(state.unsubscribeCalls, 1);
		assert.equal(state.disposeCalls, 1);
	} finally {
		if (prevTimeout === undefined) delete process.env.PI_SUBAGENT_TIMEOUT_MS;
		else process.env.PI_SUBAGENT_TIMEOUT_MS = prevTimeout;
	}
});

test("runSingleAgent honours PI_SUBAGENT_TIMEOUT_MS env var (no seam): hanging prompt times out", async () => {
	// End-to-end: a positive env var (with no _internal.timeoutMs seam) drives
	// resolveSubagentTimeoutMs -> buildCombinedAbortSignal(timeoutMs > 0) ->
	// AbortSignal.timeout fires -> session.abort -> applyTimeoutFailure.
	const prevTimeout = process.env.PI_SUBAGENT_TIMEOUT_MS;
	process.env.PI_SUBAGENT_TIMEOUT_MS = "20";
	try {
		const { sdk, state } = createFakeSdk(); // prompt hangs until abort
		const { bridge, calls } = makeParentBridge();

		const result = await runSingleAgent(
			process.cwd(),
			[makeAgent()],
			"worker",
			"do work",
			undefined,
			undefined,
			undefined, // no parent signal — only the env-var timeout can interrupt
			undefined,
			(results) => ({ mode: "single", agentScope: "user", projectAgentsDir: null, results }),
			makeModelRegistry(),
			undefined,
			undefined,
			undefined,
			"tool-env-timeout",
			bridge,
			{ sdk: sdk as any }, // no timeoutMs seam — env var is the source of truth
		);

		assert.equal(result.exitCode, 1);
		assert.equal(result.stopReason, "timeout");
		assert.match(result.errorMessage ?? "", /timed out after 0.02s/);
		assert.ok(state.abortCalls >= 1);
		assert.equal(calls.cancelAll, 1);
		assert.equal(state.unsubscribeCalls, 1);
		assert.equal(state.disposeCalls, 1);
	} finally {
		if (prevTimeout === undefined) delete process.env.PI_SUBAGENT_TIMEOUT_MS;
		else process.env.PI_SUBAGENT_TIMEOUT_MS = prevTimeout;
	}
});

test("validateSubagentParams enforces exactly one mode and validates agent names", () => {
	const agents = [makeAgent({ name: "worker" })];

	const invalidMode = validateSubagentParams({}, agents);
	assert.equal(invalidMode.ok, false);

	const invalidAgent = validateSubagentParams({ agent: "missing", task: "x" } as any, agents);
	assert.equal(invalidAgent.ok, true);
	if (!invalidAgent.ok) {
		assert.fail("expected valid mode with invalid-agent result");
	}
	assert.equal(invalidAgent.invalidResults.length, 1);
	assert.equal(invalidAgent.invalidResults[0].exitCode, 1);

	const validSingle = validateSubagentParams({ agent: "worker", task: "x" } as any, agents);
	assert.equal(validSingle.ok, true);
	if (!validSingle.ok) {
		assert.fail("expected single mode validation to pass");
	}
	assert.equal(validSingle.mode, "single");
	assert.equal(validSingle.invalidResults.length, 0);
});

test("execute returns disabled response before any discovery", async () => {
	const response = await execute(
		"tool-1",
		{ agent: "worker", task: "x" } as any,
		new AbortController().signal,
		() => undefined,
		{ cwd: process.cwd() } as any,
		{} as any,
		() => true,
	);

	assert.equal(response.isError, true);
	assert.match(response.content[0].text, /Sub agents are disabled/);
});

test("execute returns depth-limit response when nested depth is exhausted", async () => {
	const previousDepth = process.env.PI_SUBAGENT_DEPTH;
	process.env.PI_SUBAGENT_DEPTH = "3";
	try {
		const response = await execute(
			"tool-2",
			{ agent: "worker", task: "x" } as any,
			new AbortController().signal,
			() => undefined,
			{ cwd: process.cwd() } as any,
			{} as any,
			() => false,
		);
		assert.equal(response.isError, true);
		assert.match(response.content[0].text, /depth limit reached/i);
	} finally {
		if (previousDepth === undefined) {
			delete process.env.PI_SUBAGENT_DEPTH;
		} else {
			process.env.PI_SUBAGENT_DEPTH = previousDepth;
		}
	}
});

test("execute returns mode-count error for invalid mode selection", async () => {
	const tempDir = await mkdtemp(path.join(os.tmpdir(), "subagent-mode-test-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = tempDir;
	try {
		const response = await execute(
			"tool-3",
			{} as any,
			new AbortController().signal,
			() => undefined,
			{ cwd: tempDir, hasUI: false } as any,
			{} as any,
			() => false,
		);
		assert.equal(response.isError, true);
		assert.match(response.content[0].text, /Provide exactly one mode/);
	} finally {
		if (previousAgentDir === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		}
		await rm(tempDir, { recursive: true, force: true });
	}
});
