/**
 * Mode-specific execution functions for subagent tool.
 */

import type { ToolContext } from "@mariozechner/pi-coding-agent";
import type { AgentConfig } from "../agents.js";
import { getFinalOutput } from "../formatting.js";
import {
	mapWithConcurrencyLimit,
	runSingleAgent,
	subagentRuntime,
	type SubagentRuntimeContext,
} from "../runner.js";
import { SubagentParams } from "../schema.js";
import {
	MAX_CONCURRENCY,
	MAX_MODEL_RETRIES,
	PARALLEL_SUMMARY_PREVIEW,
	type OnUpdateCallback,
	type SingleResult,
	type SubagentDetails,
} from "../types.js";
import type { SelectionContext } from "./execute.js";
import { resolveModel, attachSelectionMetadata, isModelFailure, checkTrailLoop } from "./execute.js";

/** Handles single agent execution. */
export async function executeSingleMode(
	params: SubagentParams,
	ctx: ToolContext,
	agents: AgentConfig[],
	checkSessionLimit: () => string | undefined,
	runtimeCtx: SubagentRuntimeContext,
	makeDetails: (mode: "single" | "parallel" | "chain", results: SingleResult[]) => SubagentDetails,
	onUpdate: OnUpdateCallback,
	signal: AbortSignal,
	selectionCtx: SelectionContext,
) {
	const { selectionConfig, disabledProviders, allowedModelIds } = selectionCtx;

	if (checkTrailLoop(params.agent!, runtimeCtx.trail)) {
		return {
			content: [
				{
					type: "text" as const,
					text: `Trail loop detected: agent "${params.agent}" already appeared twice in ancestor chain.`,
				},
			],
			details: makeDetails("single", []),
			isError: true,
		};
	}

	const singleAgent = agents.find((a) => a.name === params.agent)!;
	const singleExcludeModels = new Set<string>();
	let result: SingleResult | undefined;

	for (let attempt = 0; attempt <= MAX_MODEL_RETRIES; attempt++) {
		const singleResolved = resolveModel(
			singleAgent,
			selectionConfig,
			allowedModelIds,
			params.taskScores,
			singleExcludeModels,
		);
		result = await subagentRuntime.run({ depth: runtimeCtx.depth + 1, trail: [...runtimeCtx.trail, params.agent!] }, () =>
			runSingleAgent(
				ctx.cwd,
				agents,
				params.agent!,
				params.task!,
				params.cwd,
				undefined,
				signal,
				onUpdate,
				(res) => makeDetails("single", res),
				ctx.modelRegistry,
				ctx.model,
				singleResolved.modelOverride,
				singleResolved.thinkingLevel,
				disabledProviders,
			),
		);
		attachSelectionMetadata(result, singleResolved);

		if (isModelFailure(result, singleResolved.modelOverride, !!selectionConfig) && attempt < MAX_MODEL_RETRIES) {
			singleExcludeModels.add(singleResolved.modelOverride!);
			result.failedModel = singleResolved.modelOverride;
			result.retryCount = attempt + 1;
			const nextResolved = resolveModel(
				singleAgent,
				selectionConfig,
				allowedModelIds,
				params.taskScores,
				singleExcludeModels,
			);
			if (!nextResolved.modelOverride) break;
			continue;
		}
		break;
	}

	const isError = result!.exitCode !== 0 || result!.stopReason === "error" || result!.stopReason === "aborted";
	if (isError) {
		const errorMsg = result!.errorMessage || result!.stderr || getFinalOutput(result!.messages) || "(no output)";
		return {
			content: [{ type: "text" as const, text: `Agent ${result!.stopReason || "failed"}: ${errorMsg}` }],
			details: makeDetails("single", [result!]),
			isError: true,
		};
	}
	return {
		content: [{ type: "text" as const, text: getFinalOutput(result!.messages) || "(no output)" }],
		details: makeDetails("single", [result!]),
	};
}

/** Handles parallel tasks array execution. */
export async function executeParallelMode(
	params: SubagentParams,
	ctx: ToolContext,
	agents: AgentConfig[],
	checkSessionLimit: () => string | undefined,
	runtimeCtx: SubagentRuntimeContext,
	makeDetails: (mode: "single" | "parallel" | "chain", results: SingleResult[]) => SubagentDetails,
	onUpdate: OnUpdateCallback,
	signal: AbortSignal,
	selectionCtx: SelectionContext,
) {
	const { selectionConfig, disabledProviders, allowedModelIds } = selectionCtx;

	if (params.tasks!.length > MAX_PARALLEL_TASKS)
		return {
			content: [
				{
					type: "text" as const,
					text: `Too many parallel tasks (${params.tasks!.length}). Max is ${MAX_PARALLEL_TASKS}.`,
				},
			],
			details: makeDetails("parallel", []),
			isError: true,
		};

	const allResults: SingleResult[] = new Array(params.tasks!.length);
	for (let i = 0; i < params.tasks!.length; i++) {
		allResults[i] = {
			agent: params.tasks![i].agent,
			agentSource: "unknown",
			task: params.tasks![i].task,
			exitCode: -1,
			messages: [],
			stderr: "",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		};
	}

	const emitParallelUpdate = () => {
		if (onUpdate) {
			const running = allResults.filter((r) => r.exitCode === -1).length;
			const done = allResults.filter((r) => r.exitCode !== -1).length;
			onUpdate({
				content: [
					{
						type: "text" as const,
						text: `Parallel: ${done}/${allResults.length} done, ${running} running...`,
					},
				],
				details: makeDetails("parallel", [...allResults]),
			});
		}
	};

	const results = await mapWithConcurrencyLimit(params.tasks!, MAX_CONCURRENCY, async (t, index) => {
		const sessionLimitError = checkSessionLimit();
		if (sessionLimitError) {
			const limitResult: SingleResult = {
				agent: t.agent,
				agentSource: "unknown",
				task: t.task,
				exitCode: 1,
				messages: [],
				stderr: "",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
				errorMessage: sessionLimitError,
			};
			allResults[index] = limitResult;
			emitParallelUpdate();
			return limitResult;
		}

		if (checkTrailLoop(t.agent, runtimeCtx.trail)) {
			const loopResult: SingleResult = {
				agent: t.agent,
				agentSource: "unknown",
				task: t.task,
				exitCode: 1,
				messages: [],
				stderr: "",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
				errorMessage: `Trail loop detected: agent "${t.agent}" already appeared twice in ancestor chain.`,
			};
			allResults[index] = loopResult;
			emitParallelUpdate();
			return loopResult;
		}

		const parallelAgent = agents.find((a) => a.name === t.agent)!;
		const taskExcludeModels = new Set<string>();
		let result: SingleResult | undefined;

		for (let attempt = 0; attempt <= MAX_MODEL_RETRIES; attempt++) {
			const parallelResolved = resolveModel(
				parallelAgent,
				selectionConfig,
				allowedModelIds,
				t.taskScores,
				taskExcludeModels,
			);
			result = await subagentRuntime.run(
				{ depth: runtimeCtx.depth + 1, trail: [...runtimeCtx.trail, t.agent] },
				() =>
					runSingleAgent(
						ctx.cwd,
						agents,
						t.agent,
						t.task,
						t.cwd,
						undefined,
						signal,
						(partial) => {
							if (partial.details?.results[0]) {
								allResults[index] = partial.details.results[0];
								emitParallelUpdate();
							}
						},
						(res) => makeDetails("parallel", res),
						ctx.modelRegistry,
						ctx.model,
						parallelResolved.modelOverride,
						parallelResolved.thinkingLevel,
						disabledProviders,
					),
			);
			attachSelectionMetadata(result, parallelResolved);

			if (isModelFailure(result, parallelResolved.modelOverride, !!selectionConfig) && attempt < MAX_MODEL_RETRIES) {
				taskExcludeModels.add(parallelResolved.modelOverride!);
				result.failedModel = parallelResolved.modelOverride;
				result.retryCount = attempt + 1;
				const nextResolved = resolveModel(
					parallelAgent,
					selectionConfig,
					allowedModelIds,
					t.taskScores,
					taskExcludeModels,
				);
				if (!nextResolved.modelOverride) break;
				continue;
			}
			break;
		}
		allResults[index] = result!;
		emitParallelUpdate();
		return result!;
	});

	const successCount = results.filter((r) => r.exitCode === 0).length;
	const hasFailures = successCount !== results.length;
	const summaries = results.map((r) => {
		const summaryText =
			r.exitCode === 0 ? getFinalOutput(r.messages) : r.errorMessage || r.stderr || getFinalOutput(r.messages);
		const preview =
			summaryText.slice(0, PARALLEL_SUMMARY_PREVIEW) +
			(summaryText.length > PARALLEL_SUMMARY_PREVIEW ? "..." : "");
		return `[${r.agent}] ${r.exitCode === 0 ? "completed" : "failed"}: ${preview || "(no output)"}`;
	});
	return {
		content: [
			{
				type: "text" as const,
				text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n")}`,
			},
		],
		details: makeDetails("parallel", results),
		isError: hasFailures,
	};
}

/** Handles chain execution with {previous} placeholder substitution. */
export async function executeChainMode(
	params: SubagentParams,
	ctx: ToolContext,
	agents: AgentConfig[],
	checkSessionLimit: () => string | undefined,
	runtimeCtx: SubagentRuntimeContext,
	makeDetails: (mode: "single" | "parallel" | "chain", results: SingleResult[]) => SubagentDetails,
	onUpdate: OnUpdateCallback,
	signal: AbortSignal,
	selectionCtx: SelectionContext,
) {
	const { selectionConfig, disabledProviders, allowedModelIds } = selectionCtx;

	const results: SingleResult[] = [];
	let previousOutput = "";
	const chainExcludeModels = new Set<string>();

	for (let i = 0; i < params.chain!.length; i++) {
		const step = params.chain![i];
		const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

		const chainUpdate: OnUpdateCallback | undefined = onUpdate
			? (partial) => {
					const currentResult = partial.details?.results[0];
					if (currentResult) {
						const allResults = [...results, currentResult];
						onUpdate({
							content: partial.content,
							details: makeDetails("chain", allResults),
						});
					}
			  }
			: undefined;

		if (checkTrailLoop(step.agent, runtimeCtx.trail)) {
			const loopErrorResult: SingleResult = {
				agent: step.agent,
				agentSource: "unknown",
				task: taskWithContext,
				exitCode: 1,
				messages: [],
				stderr: "",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
				errorMessage: `Trail loop detected: agent "${step.agent}" already appeared twice in ancestor chain.`,
				step: i + 1,
			};
			results.push(loopErrorResult);
			return {
				content: [
					{
						type: "text" as const,
						text: `Chain stopped at step ${i + 1}: trail loop for agent "${step.agent}".`,
					},
				],
				details: makeDetails("chain", results),
				isError: true,
			};
		}

		const chainAgent = agents.find((a) => a.name === step.agent)!;
		const sessionLimitError = checkSessionLimit();
		if (sessionLimitError) {
			const limitErrorResult: SingleResult = {
				agent: step.agent,
				agentSource: "unknown",
				task: taskWithContext,
				exitCode: 1,
				messages: [],
				stderr: "",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
				errorMessage: sessionLimitError,
				step: i + 1,
			};
			results.push(limitErrorResult);
			return {
				content: [{ type: "text" as const, text: `Chain stopped at step ${i + 1}: ${sessionLimitError}` }],
				details: makeDetails("chain", results),
				isError: true,
			};
		}

		let result: SingleResult | undefined;
		for (let attempt = 0; attempt <= MAX_MODEL_RETRIES; attempt++) {
			const chainResolved = resolveModel(
				chainAgent,
				selectionConfig,
				allowedModelIds,
				step.taskScores,
				chainExcludeModels,
			);
			result = await subagentRuntime.run(
				{ depth: runtimeCtx.depth + 1, trail: [...runtimeCtx.trail, step.agent] },
				() =>
					runSingleAgent(
						ctx.cwd,
						agents,
						step.agent,
						taskWithContext,
						step.cwd,
						i + 1,
						signal,
						chainUpdate,
						(res) => makeDetails("chain", res),
						ctx.modelRegistry,
						ctx.model,
						chainResolved.modelOverride,
						chainResolved.thinkingLevel,
						disabledProviders,
					),
			);
			attachSelectionMetadata(result, chainResolved);

			if (isModelFailure(result, chainResolved.modelOverride, !!selectionConfig) && attempt < MAX_MODEL_RETRIES) {
				chainExcludeModels.add(chainResolved.modelOverride!);
				result.failedModel = chainResolved.modelOverride;
				result.retryCount = attempt + 1;
				const nextResolved = resolveModel(
					chainAgent,
					selectionConfig,
					allowedModelIds,
					step.taskScores,
					chainExcludeModels,
				);
				if (!nextResolved.modelOverride) break;
				continue;
			}
			break;
		}

		results.push(result!);
		const isError = result!.exitCode !== 0 || result!.stopReason === "error" || result!.stopReason === "aborted";
		if (isError) {
			const errorMsg = result!.errorMessage || result!.stderr || getFinalOutput(result!.messages) || "(no output)";
			return {
				content: [
					{
						type: "text" as const,
						text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}`,
					},
				],
				details: makeDetails("chain", results),
				isError: true,
			};
		}
		previousOutput = getFinalOutput(result!.messages);
	}

	return {
		content: [
			{
				type: "text" as const,
				text: getFinalOutput(results[results.length - 1].messages) || "(no output)",
			},
		],
		details: makeDetails("chain", results),
	};
}
