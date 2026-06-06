import { type ExtensionAPI, type ToolContext } from "@mariozechner/pi-coding-agent";
import { type AgentConfig, type AgentScope, discoverAgents, formatAgentList } from "../agents.js";
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
import * as path from "node:path";
import {
	type TaskScores,
	type ThinkingLevel,
	type SelectionResult,
	PROVIDER_TOGGLES_ENV,
	getAllowedModelIdsForProviders,
	getDisabledProviders,
	loadSelectionConfig,
	parseProviderToggles,
	selectModel,
} from "../model-selection.js";
import { loadModelPricing, resolveModelCost } from "../pricing.js";
import { MAX_DEPTH, MAX_SESSIONS_PER_CALL } from "./helpers.js";
import { type SelectionContext } from "./helpers.js";
import { executeSingleMode } from "./modes.js";
import { executeParallelMode } from "./modes.js";
import { executeChainMode } from "./modes.js";

interface ExecuteContext {
	mode: "single" | "parallel" | "chain";
	invalidResults: SingleResult[];
}

export async function execute(
	_toolCallId: string,
	params: SubagentParams,
	signal: AbortSignal,
	onUpdate: OnUpdateCallback,
	ctx: ToolContext,
	pi: ExtensionAPI,
) {
	const isDisabled = () =>
		pi.getFlag("no-subagent") === true ||
		["1", "true", "yes"].includes((process.env.PI_SUBAGENT_DISABLED ?? "").toLowerCase());

	const DISABLED_MESSAGE =
		"Sub agents are disabled. Enable them by removing the --no-subagent flag or unsetting the PI_SUBAGENT_DISABLED environment variable.";

	if (isDisabled()) {
		return {
			content: [{ type: "text", text: DISABLED_MESSAGE }],
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
	const makeDetails = (mode: "single" | "parallel" | "chain", results: SingleResult[]): SubagentDetails => ({
		mode,
		agentScope,
		projectAgentsDir: discovery.projectAgentsDir,
		results,
	});

	const { mode, invalidResults }: ExecuteContext = validateSubagentParams(params, agents);

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
			details: makeDetails("single", []),
			isError: true,
		};
	}

	if (invalidResults.length > 0) {
		return {
			content: [{ type: "text", text: summarizeInvalidAgentResults(invalidResults) }],
			details: makeDetails(mode, invalidResults),
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
		if (params.chain)
			for (const step of params.chain) requestedAgentNames.add(step.agent);
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
					details: makeDetails(mode, []),
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

	// Delegate to mode-specific execution
	if (mode === "chain") {
		return executeChainMode(
			params,
			ctx,
			agents,
			checkSessionLimit,
			runtimeCtx,
			makeDetails,
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
			makeDetails,
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
			makeDetails,
			onUpdate,
			signal,
			selectionCtx,
		);
	}
}