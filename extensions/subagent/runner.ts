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
import type { OnUpdateCallback, SingleResult, SubagentDetails } from "./types.js";
import { createInvalidAgentResult } from "./validation.js";

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
 * Resolve an override model id against the registry.
 * Profiles use bare model ids (e.g. "gpt-5.5") that may live under multiple providers
 * (azure-openai-responses, github-copilot). Prefer the caller's provider so subagents
 * route through the same OAuth token (Copilot) when the caller does.
 */
function resolveOverrideModel(
	modelRegistry: ModelRegistry,
	callerModel: Model<any> | undefined,
	modelOverride: string,
): Model<any> | undefined {
	if (callerModel) {
		const sameProvider = modelRegistry.find(callerModel.provider, modelOverride);
		if (sameProvider) return sameProvider;
	}
	// Fall back to first model with matching id across all providers.
	return modelRegistry.getAll().find((m) => m.id === modelOverride);
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
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);
	if (!agent) return createInvalidAgentResult(agentName, task, agents, step);

	const sessionCwd = cwd ?? defaultCwd;
	const effectiveModelString = modelOverride ?? agent.model;

	// Resolve the actual Model<any> to pass to the SDK.
	let resolvedModel: Model<any> | undefined = callerModel;
	if (modelOverride) {
		resolvedModel = resolveOverrideModel(modelRegistry, callerModel, modelOverride) ?? callerModel;
	}

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: effectiveModelString,
		step,
	};

	const emitUpdate = () => {
		if (!onUpdate) return;
		onUpdate({
			content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
			details: makeDetails([currentResult]),
		});
	};

	// Build an isolated resource loader for the subagent.
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
	if (!currentResult.model && session.agent?.state?.model) {
		const m = session.agent.state.model;
		currentResult.model = `${m.provider}/${m.id}`;
	}

	const unsubscribe = session.subscribe((event) => {
		if (event.type === "tool_execution_start" && event.toolName) {
			currentResult.runningTools = [...(currentResult.runningTools ?? []), event.toolName];
			emitUpdate();
			return;
		}
		if (event.type === "tool_execution_end" && event.toolName) {
			currentResult.runningTools = (currentResult.runningTools ?? []).filter((t) => t !== event.toolName);
			emitUpdate();
			return;
		}
		if (event.type === "message_end" && event.message) {
			const msg = event.message as Message;
			if (msg.role === "assistant" || msg.role === "toolResult") {
				currentResult.messages.push(msg);
			}
			if (msg.role === "assistant") {
				currentResult.usage.turns++;
				const usage = (msg as any).usage;
				if (usage) {
					currentResult.usage.input += usage.input || 0;
					currentResult.usage.output += usage.output || 0;
					currentResult.usage.cacheRead += usage.cacheRead || 0;
					currentResult.usage.cacheWrite += usage.cacheWrite || 0;
					currentResult.usage.cost += usage.cost?.total || 0;
					currentResult.usage.contextTokens = usage.totalTokens || 0;
				}
				if (!currentResult.model && (msg as any).model) currentResult.model = (msg as any).model;
				if ((msg as any).stopReason) currentResult.stopReason = (msg as any).stopReason;
				if ((msg as any).errorMessage) currentResult.errorMessage = (msg as any).errorMessage;
			}
			emitUpdate();
		}
	});

	let abortListener: (() => void) | undefined;
	if (signal) {
		if (signal.aborted) {
			void session.abort();
		} else {
			abortListener = () => {
				void session.abort();
			};
			signal.addEventListener("abort", abortListener, { once: true });
		}
	}

	try {
		await session.prompt(`Task: ${task}`);

		const stop = currentResult.stopReason;
		if (stop === "error" || stop === "aborted") {
			currentResult.exitCode = 1;
		} else {
			currentResult.exitCode = 0;
		}
		if (signal?.aborted && currentResult.exitCode === 0) {
			currentResult.exitCode = 1;
			if (!currentResult.errorMessage) currentResult.errorMessage = "Subagent was aborted";
		}
		return currentResult;
	} catch (err) {
		currentResult.exitCode = 1;
		const message = err instanceof Error ? err.message : String(err);
		currentResult.errorMessage = currentResult.errorMessage || message;
		currentResult.stderr = currentResult.stderr || message;
		return currentResult;
	} finally {
		if (abortListener && signal) signal.removeEventListener("abort", abortListener);
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
}
