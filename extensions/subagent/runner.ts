/**
 * In-process subagent runner. Uses the pi SDK directly via `createAgentSession`
 * so subagents share the parent's auth, model registry, and OAuth tokens.
 *
 * This replaces the previous CLI-subprocess approach (`pi --mode json -p ...`),
 * which failed for newer models routed through the GitHub Copilot gateway.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { Message, Model } from "@mariozechner/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	type ModelRegistry,
	SessionManager,
} from "@mariozechner/pi-coding-agent";
import type { AgentConfig } from "./agents.js";
import { getFinalOutput } from "./formatting.js";
import type { ThinkingLevel } from "./model-selection.js";
import { resolveExecutionModel } from "./model-resolution.js";
import type { OnUpdateCallback, SingleResult, SubagentDetails } from "./types.js";
import { createInvalidAgentResult } from "./validation.js";

/**
 * Per-prompt timeout: if the model doesn't produce a complete response within
 * this window, the prompt is aborted and the subagent reports a timeout error.
 * Prevents subagents from hanging indefinitely on unresponsive providers.
 */
const SUBAGENT_PROMPT_TIMEOUT_MS = 600_000; // 10 minutes

/**
 * Async-local context carried through nested subagent invocations.
 * Replaces the old PI_SUBAGENT_DEPTH / PI_SUBAGENT_TRAIL environment variables
 * (which only worked across subprocess boundaries).
 */
export interface SubagentRuntimeContext {
	depth: number;
	trail: string[];
}

export const subagentRuntime = new AsyncLocalStorage<SubagentRuntimeContext>();

/** Read current runtime context, falling back to legacy env vars for outermost call. */
export function readRuntimeContext(): SubagentRuntimeContext {
	const store = subagentRuntime.getStore();
	if (store) return store;
	const depth = parseInt(process.env.PI_SUBAGENT_DEPTH ?? "0", 10);
	const trail = (process.env.PI_SUBAGENT_TRAIL ?? "").split(",").filter(Boolean);
	return { depth, trail };
}

export async function mapWithConcurrencyLimit<TIn, TOut>(
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

/**
 * Build the initial SingleResult for a subagent run. The result is mutated
 * in place as the session streams events back. Usage counters start at zero.
 */
function createInitialResult(
	agent: AgentConfig,
	agentName: string,
	task: string,
	step: number | undefined,
	actualModelId: string,
	modelResolutionDiagnostic: string | undefined,
): SingleResult {
	const result: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: -1,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: actualModelId,
		step,
	};
	if (modelResolutionDiagnostic) {
		result.modelResolutionDiagnostic = modelResolutionDiagnostic;
	}
	return result;
}

/** Build the update emitter that publishes partial state to the parent UI. */
function createUpdateEmitter(
	result: SingleResult,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	streamingTextRef: { value: string },
): () => void {
	return () => {
		if (!onUpdate) return;
		// Prefer the final output from completed messages; fall back to in-flight streaming text.
		const finalOutput = getFinalOutput(result.messages);
		const text = finalOutput || streamingTextRef.value || "(running...)";
		onUpdate({
			content: [{ type: "text", text }],
			details: makeDetails([result]),
		});
	};
}

/** Record a completed assistant message's usage and metadata into the result. */
function recordAssistantMessage(result: SingleResult, msg: any): void {
	result.usage.turns++;
	const usage = msg.usage;
	if (usage) {
		result.usage.input += usage.input || 0;
		result.usage.output += usage.output || 0;
		result.usage.cacheRead += usage.cacheRead || 0;
		result.usage.cacheWrite += usage.cacheWrite || 0;
		result.usage.cost += usage.cost?.total || 0;
		result.usage.contextTokens = usage.totalTokens || 0;
	}
	if (msg.model) result.model = msg.model;
	if (msg.stopReason) result.stopReason = msg.stopReason;
	if (msg.errorMessage) result.errorMessage = msg.errorMessage;
}

/** Wire up a subscription to session events, mutating `result` and emitting updates. */
function subscribeToSession(
	session: { subscribe: (cb: (event: any) => void) => () => void },
	result: SingleResult,
	emitUpdate: () => void,
	streamingTextRef: { value: string },
): () => void {
	return session.subscribe((event) => {
		if (event.type === "message_update") {
			handleMessageUpdate(event, result, emitUpdate, streamingTextRef);
			return;
		}
		if (event.type === "tool_execution_start" && event.toolName) {
			result.runningTools = [...(result.runningTools ?? []), event.toolName];
			emitUpdate();
			return;
		}
		if (event.type === "tool_execution_end" && event.toolName) {
			result.runningTools = (result.runningTools ?? []).filter((t) => t !== event.toolName);
			emitUpdate();
			return;
		}
		if (event.type === "message_end" && event.message) {
			handleMessageEnd(event.message, result, emitUpdate, streamingTextRef);
		}
	});
}

/** Handle streaming text_delta events from the assistant. */
function handleMessageUpdate(
	event: any,
	result: SingleResult,
	emitUpdate: () => void,
	streamingTextRef: { value: string },
): void {
	// Accumulate streaming text deltas so the user sees output as it arrives.
	// The SDK delivers events in order per message: message_start → message_update* → message_end.
	// A single `streamingText` buffer is sufficient because only one assistant
	// message streams at a time in the subagent's single-prompt session.
	if (event.assistantMessageEvent?.type === "text_delta" && event.assistantMessageEvent.delta) {
		streamingTextRef.value += event.assistantMessageEvent.delta;
		result.streamingText = streamingTextRef.value;
		emitUpdate();
	}
}

/** Handle a completed message, recording usage and resetting streaming buffers. */
function handleMessageEnd(
	rawMessage: any,
	result: SingleResult,
	emitUpdate: () => void,
	streamingTextRef: { value: string },
): void {
	const msg = rawMessage as Message;
	if (msg.role === "assistant" || msg.role === "toolResult") {
		result.messages.push(msg);
	}
	if (msg.role === "assistant") {
		recordAssistantMessage(result, rawMessage);
		// Clear streaming text once a complete assistant message is committed.
		// (Only assistant messages produce text_delta events, so only reset on those.)
		streamingTextRef.value = "";
		result.streamingText = undefined;
	}
	emitUpdate();
}

/** Build a per-call abort signal that fires on either the parent signal or the timeout. */
function buildCombinedAbortSignal(parentSignal: AbortSignal | undefined): {
	timeoutSignal: AbortSignal;
	onAbort: (handler: () => void) => () => void;
} {
	const timeoutSignal = AbortSignal.timeout(SUBAGENT_PROMPT_TIMEOUT_MS);
	const signal = parentSignal ? AbortSignal.any([parentSignal, timeoutSignal]) : timeoutSignal;
	const onAbort = (handler: () => void): (() => void) => {
		signal.addEventListener("abort", handler, { once: true });
		return () => signal.removeEventListener("abort", handler);
	};
	return { timeoutSignal, onAbort };
}

/** Apply a timeout-failure to a result. */
function applyTimeoutFailure(result: SingleResult): void {
	result.exitCode = 1;
	result.stopReason = "timeout";
	result.errorMessage = `Subagent timed out after ${SUBAGENT_PROMPT_TIMEOUT_MS / 1000}s waiting for model response.`;
	result.streamingText = undefined;
}

/** Apply a stop-reason-based exit code to a result. */
function applyStopReason(result: SingleResult, parentAborted: boolean): void {
	const stop = result.stopReason;
	if (stop === "error" || stop === "aborted") {
		result.exitCode = 1;
	} else {
		result.exitCode = 0;
	}
	result.streamingText = undefined;
	if (parentAborted && result.exitCode === 0) {
		result.exitCode = 1;
		if (!result.errorMessage) result.errorMessage = "Subagent was aborted";
	}
}

/** Apply a thrown error to a result, preserving any previously-recorded message. */
function applyThrownError(result: SingleResult, err: unknown): void {
	result.exitCode = 1;
	const message = err instanceof Error ? err.message : String(err);
	result.errorMessage = result.errorMessage || message;
	result.stderr = result.stderr || message;
	result.streamingText = undefined;
}

/** Tear down a session, swallowing disposal errors. */
function teardownSession(unsubscribe: () => void, session: { dispose: () => void }): void {
	try {
		unsubscribe();
	} catch {
		/* ignore */
	}
	try {
		session.dispose();
	} catch {
		/* ignore */
	}
}

export async function runSingleAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	modelRegistry: ModelRegistry,
	callerModel: Model<any> | undefined,
	modelOverride: string | undefined,
	thinkingLevel: ThinkingLevel | undefined,
	disabledProviders?: Set<string>,
): Promise<SingleResult> {
	// 1. Preflight: locate the agent config or short-circuit with an invalid result.
	const agent = agents.find((a) => a.name === agentName);
	if (!agent) return createInvalidAgentResult(agentName, task, agents, step);

	// 2. Resolve the model the session will run on.
	const sessionCwd = cwd ?? defaultCwd;
	const requestedModel = modelOverride ?? agent.model;
	const {
		resolvedModel,
		actualModelId,
		diagnostic: modelResolutionDiagnostic,
	} = resolveExecutionModel(modelRegistry, callerModel, requestedModel, disabledProviders);

	// 3. Build the result accumulator and the update emitter.
	const currentResult = createInitialResult(
		agent,
		agentName,
		task,
		step,
		actualModelId,
		modelResolutionDiagnostic,
	);
	const streamingTextRef = { value: "" };
	const emitUpdate = createUpdateEmitter(currentResult, onUpdate, makeDetails, streamingTextRef);

	// 4. Build an isolated resource loader and create the session.
	// - appendSystemPrompt threads the agent's instructions into the system prompt
	// - noExtensions prevents recursive loading of the subagent extension itself
	const resourceLoader = new DefaultResourceLoader({
		cwd: sessionCwd,
		agentDir: getAgentDir(),
		appendSystemPrompt: agent.systemPrompt.trim() ? [agent.systemPrompt] : undefined,
		noExtensions: true,
	});
	await resourceLoader.reload();

	const { session } = await createAgentSession({
		cwd: sessionCwd,
		modelRegistry,
		model: resolvedModel,
		thinkingLevel,
		tools: agent.tools,
		sessionManager: SessionManager.inMemory(sessionCwd),
		resourceLoader,
	});

	// Capture the model the session actually selected (in case our hint was overridden).
	if (session.agent?.state?.model) {
		currentResult.model = session.agent.state.model.id;
	}

	// 5. Subscribe to session events.
	const unsubscribe = subscribeToSession(session, currentResult, emitUpdate, streamingTextRef);

	// 6. Run the prompt with timeout / parent-signal handling, then shape the final result.
	try {
		const parentAlreadyAborted = signal?.aborted === true;
		if (parentAlreadyAborted) {
			// If the parent signal is already aborted, run the prompt anyway
			// (it'll abort quickly) and return an explicit abort result.
			void session.abort();
			await session.prompt(`Task: ${task}`);
			currentResult.exitCode = 1;
			if (!currentResult.errorMessage) currentResult.errorMessage = "Subagent was aborted";
			return currentResult;
		}

		const { timeoutSignal, onAbort } = buildCombinedAbortSignal(signal);
		let timedOut = false;
		const removeAbortListener = onAbort(() => {
			// If the prompt timeout has fired (even if the parent signal also fired
			// simultaneously), flag it as a timeout so callers can distinguish the cause.
			if (timeoutSignal.aborted) timedOut = true;
			void session.abort();
		});

		try {
			// Race the prompt against a timeout to prevent indefinite hangs.
			// The parent's abort signal takes priority; the timeout is a safety net
			// for cases where the provider never responds.
			await session.prompt(`Task: ${task}`);
		} finally {
			removeAbortListener();
		}

		if (timedOut) {
			applyTimeoutFailure(currentResult);
			return currentResult;
		}

		applyStopReason(currentResult, signal?.aborted === true);
		return currentResult;
	} catch (err) {
		applyThrownError(currentResult, err);
		return currentResult;
	} finally {
		teardownSession(unsubscribe, session);
	}
}
