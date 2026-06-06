/**
 * Subagent execution orchestrator and supporting functions.
 */

import type { ExtensionAPI, ToolContext } from "@mariozechner/pi-coding-agent";
import * as path from "node:path";
import { type AgentConfig, type AgentScope, discoverAgents } from "../agents.js";
import { getFinalOutput } from "../formatting.js";
import {
	mapWithConcurrencyLimit,
	readRuntimeContext,
	runSingleAgent,
	subagentRuntime,
	type SubagentRuntimeContext,
} from "../runner.js";
import { SubagentParams } from "../schema.js";
import {
	MAX_CONCURRENCY,
	MAX_MODEL_RETRIES,
	MAX_PARALLEL_TASKS,
	PARALLEL_SUMMARY_PREVIEW,
	type OnUpdateCallback,
	type SingleResult,
	type SubagentDetails,
} from "../types.js";
import { renderSubagentCall, renderSubagentResult } from "../render.js";
import { createInvalidAgentResult, summarizeInvalidAgentResults } from "../validation.js";
import {
	type TaskScores,
	type SelectionResult,
	PROVIDER_TOGGLES_ENV,
	getAllowedModelIdsForProviders,
	getDisabledProviders,
	loadSelectionConfig,
	parseProviderToggles,
	selectModel,
} from "../model-selection.js";
import { loadModelPricing, resolveModelCost } from "../pricing.js";
import { MAX_DEPTH, MAX_SESSIONS_PER_CALL, makeDetails } from "./helpers.js";

/** Root of the pi-config repo, resolved from this extension's known position. */
const CONFIG_ROOT = path.resolve(import.meta.dirname, "..", "..");

/** Context for model selection settings and restrictions. */
export interface SelectionContext {
	selectionConfig: ReturnType<typeof loadSelectionConfig> | undefined;
	disabledProviders: Set<string>;
	allowedModelIds: Set<string> | undefined;
}

/**
 * Validates exactly-one-mode and agent name existence.
 * Returns the selected mode and any invalid agent results.
 */
export function validateSubagentParams(
	params: SubagentParams,
	agents: AgentConfig[],
): { mode: "single" | "parallel" | "chain"; invalidResults: SingleResult[] } {
	const hasChain = (params.chain?.length ?? 0) > 0;
	const hasTasks = (params.tasks?.length ?? 0) > 0;
	const mode = hasChain ? "chain" : hasTasks ? "parallel" : "single";

	const invalidResults: SingleResult[] = [];
	if (params.chain) {
		for (let i = 0; i < params.chain.length; i++) {
			const step = params.chain[i];
			if (!agents.some((a) => a.name === step.agent)) {
				invalidResults.push(createInvalidAgentResult(step.agent, step.task, agents, i + 1));
			}
		}
	}
	if (params.tasks) {
		for (const task of params.tasks) {
			if (!agents.some((a) => a.name === task.agent)) {
				invalidResults.push(createInvalidAgentResult(task.agent, task.task, agents));
			}
		}
	}
	if (params.agent && params.task && !agents.some((a) => a.name === params.agent)) {
		invalidResults.push(createInvalidAgentResult(params.agent, params.task, agents));
	}

	return { mode, invalidResults };
}

/** Resolves which model to use for an agent based on task scores and configuration. */
export function resolveModel(
	agent: AgentConfig,
	selectionConfig: ReturnType<typeof loadSelectionConfig> | undefined,
	allowedModelIds: Set<string> | undefined,
	perCallScores?: TaskScores,
	excludeModels?: Set<string>,
) {
	const callerScores = perCallScores && Object.keys(perCallScores).length > 0 ? perCallScores : undefined;
	const agentDefaultScores =
		agent.defaultScores && Object.keys(agent.defaultScores).length > 0 ? agent.defaultScores : undefined;
	const mergedScores: TaskScores = { ...agent.defaultScores, ...perCallScores };
	if (!selectionConfig)
		return {
			modelOverride: undefined,
			thinkingLevel: undefined,
			selection: undefined,
			callerScores,
			agentDefaultScores,
			mergedScores,
		};
	const selection = selectModel(mergedScores, selectionConfig, excludeModels, allowedModelIds);
	return {
		modelOverride: selection?.modelId,
		thinkingLevel: selection?.thinkingLevel,
		selection,
		callerScores,
		agentDefaultScores,
		mergedScores,
	};
}

/** Attaches model selection metadata to a subagent result. */
export function attachSelectionMetadata(result: SingleResult, resolved: ReturnType<typeof resolveModel>): void {
	if (resolved.selection) {
		result.selectedModel = resolved.selection.modelId;
		result.selectionPool = resolved.selection.pool;
		result.selectionFitScores = resolved.selection.fitScores;
		result.thinkingLevel = resolved.selection.thinkingLevel;
	}
	result.taskScores = resolved.mergedScores;
	result.callerScores = resolved.callerScores;
	result.agentDefaultScores = resolved.agentDefaultScores;
}

/** Check if a subagent result represents a model-level failure that qualifies for retry. */
export function isModelFailure(
	result: SingleResult,
	modelOverride: string | undefined,
	hasSelectionConfig: boolean,
): boolean {
	return (
		result.exitCode !== 0 && result.stopReason !== "aborted" && modelOverride !== undefined && hasSelectionConfig
	);
}

export const checkTrailLoop = (agentName: string, trail: string[]): boolean => {
	const occurrences = trail.filter((t) => t === agentName).length;
	return occurrences >= 2;
};

/** Main execute function for the subagent tool. */
export async function execute(
	_toolCallId: string,
	params: SubagentParams,
	signal: AbortSignal,
	onUpdate: OnUpdateCallback,
	ctx: ToolContext,
	pi: ExtensionAPI,
	isDisabled: () => boolean,
) {
	if (isDisabled()) {
		return {
			content: [{ type: "text", text: "Sub agents are disabled. Enable them by removing the --no-subagent flag or unsetting the PI_SUBAGENT_DISABLED environment variable." }],
			details: {
				mode: "single" as const,
				agentScope: params.agentScope ?? "user",
				projectAgentsDir: null,
				results: [],
			},
			isError: true,
		};
	}

	const agentScope: AgentScope = params.agentScope ?? "user";
	const runtimeCtx = readRuntimeContext();
	if (runtimeCtx.depth >= MAX_DEPTH) {
		return {
			content: [
				{
					type: "text",
					text: `Subagent depth limit reached (max ${MAX_DEPTH}). Cannot spawn further subagents.`,
				},
			],
			details: { mode: "single", agentScope, projectAgentsDir: null, results: [] },
			isError: true,
		};
	}

	let sessionsSpawned = 0;
	const checkSessionLimit = (): string | undefined => {
		if (++sessionsSpawned > MAX_SESSIONS_PER_CALL) {
			return `Sub-agent session limit reached (max ${MAX_SESSIONS_PER_CALL} sessions per reply).`;
		}
		return undefined;
	};

	const discovery = discoverAgents(ctx.cwd, agentScope);
	const agents = discovery.agents;

	const { mode, invalidResults } = validateSubagentParams(params, agents);

	// High-level parameter validation
	const hasChain = (params.chain?.length ?? 0) > 0;
	const hasTasks = (params.tasks?.length ?? 0) > 0;
	const hasSingle = Boolean(params.agent && params.task);
	const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

	if (modeCount !== 1) {
		const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
		return {
			content: [
				{
					type: "text",
					text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
				},
			],
			details: makeDetails("single", [], agentScope, discovery.projectAgentsDir),
			isError: true,
		};
	}

	if (invalidResults.length > 0) {
		return {
			content: [{ type: "text", text: summarizeInvalidAgentResults(invalidResults) }],
			details: makeDetails(mode, invalidResults, agentScope, discovery.projectAgentsDir),
			isError: true,
		};
	}

	// Project agent approval
	if (
		(agentScope === "project" || agentScope === "both") &&
		(params.confirmProjectAgents ?? true) &&
		ctx.hasUI
	) {
		const requestedAgentNames = new Set<string>();
		if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
		if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
		if (params.agent) requestedAgentNames.add(params.agent);

		const projectAgentsRequested = Array.from(requestedAgentNames)
			.map((name) => agents.find((a) => a.name === name))
			.filter((a): a is AgentConfig => a?.source === "project");

		if (projectAgentsRequested.length > 0) {
			const names = projectAgentsRequested.map((a) => a.name).join(", ");
			const dir = discovery.projectAgentsDir ?? "(unknown)";
			const ok = await ctx.ui.confirm(
				"Run project-local agents?",
				`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
			);
			if (!ok)
				return {
					content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
					details: makeDetails(mode, [], agentScope, discovery.projectAgentsDir),
					isError: true,
				};
		}
	}

	// Model selection setup
	const selectionConfigPath = path.join(CONFIG_ROOT, "model-profiles.json");
	let selectionConfig: ReturnType<typeof loadSelectionConfig> | undefined;
	try {
		selectionConfig = loadSelectionConfig(selectionConfigPath);
	} catch {
		/* ignore */
	}
	if (selectionConfig) {
		const pricingRecords = loadModelPricing(path.join(CONFIG_ROOT, "models.json"));
		for (const profile of selectionConfig.profiles) {
			const dimAggregate =
				profile.precision + profile.creativity + profile.thoroughness + profile.reasoning;
			const resolved = resolveModelCost(profile.id, pricingRecords, profile.cost, dimAggregate);
			if (resolved.usedSource === "pricing") profile.normalizedCost = resolved.normalizedCost;
		}
	}

	const disabledProviders = getDisabledProviders(parseProviderToggles(process.env[PROVIDER_TOGGLES_ENV]));
	const allowedModelIds =
		disabledProviders.size > 0
			? getAllowedModelIdsForProviders(ctx.modelRegistry.getAvailable(), disabledProviders)
			: undefined;
	const selectionCtx: SelectionContext = { selectionConfig, disabledProviders, allowedModelIds };

	// Mode-specific imports to avoid circular dependencies
	const { executeChainMode, executeParallelMode, executeSingleMode } = await import("./modes.js");

	// Delegate to mode-specific execution
	const makeDetailsBound = (m: "single" | "parallel" | "chain", res: SingleResult[]) =>
		makeDetails(m, res, agentScope, discovery.projectAgentsDir);

	if (mode === "chain") {
		return executeChainMode(
			params,
			ctx,
			agents,
			checkSessionLimit,
			runtimeCtx,
			makeDetailsBound,
			onUpdate,
			signal,
			selectionCtx,
		);
	} else if (mode === "parallel") {
		return executeParallelMode(
			params,
			ctx,
			agents,
			checkSessionLimit,
			runtimeCtx,
			makeDetailsBound,
			onUpdate,
			signal,
			selectionCtx,
		);
	} else {
		return executeSingleMode(
			params,
			ctx,
			agents,
			checkSessionLimit,
			runtimeCtx,
			makeDetailsBound,
			onUpdate,
			signal,
			selectionCtx,
		);
	}
}
