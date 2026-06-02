/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Each subagent invocation runs an isolated AgentSession in-process via the
 * pi SDK (`createAgentSession`). The session shares the parent's auth and
 * model registry but gets its own context window, system prompt, and tools.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Files:
 *   - ./types.ts        — shared interfaces and constants
 *   - ./formatting.ts   — token / tool-call / display formatters
 *   - ./validation.ts   — agent-name validation + error helpers
 *   - ./runner.ts       — in-process AgentSession runner + depth/trail context
 *   - ./schema.ts       — typebox parameter schema
 */

import { type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { type AgentConfig, type AgentScope, discoverAgents, formatAgentList } from "./agents.js";
import { getFinalOutput } from "./formatting.js";
import { mapWithConcurrencyLimit, readRuntimeContext, runSingleAgent, subagentRuntime } from "./runner.js";
import { SubagentParams } from "./schema.js";
import {
	MAX_CONCURRENCY,
	MAX_MODEL_RETRIES,
	MAX_PARALLEL_TASKS,
	PARALLEL_SUMMARY_PREVIEW,
	type OnUpdateCallback,
	type SingleResult,
	type SubagentDetails,
} from "./types.js";
import { renderSubagentCall, renderSubagentResult } from "./render.js";
import { createInvalidAgentResult, summarizeInvalidAgentResults } from "./validation.js";
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
} from "./model-selection.js";
import { loadModelPricing, resolveModelCost } from "./pricing.js";

// All helper code lives in the modules listed above.

/** Root of the pi-config repo, resolved from this extension's known position. */
const CONFIG_ROOT = path.resolve(import.meta.dirname, "..", "..");

const MAX_DEPTH = 3;
/** Cap on sub-agent sessions spawned within a single subagent tool call (one reply). */
const MAX_SESSIONS_PER_CALL = 20;
const TASK_SCORE_GUIDANCE = "TaskScores: prefer the lowest score that fits; omit routine dimensions (omitted = 2). Use 3 for normal professional work, 4 for hard/high-risk or unusually complex work, and 5 only for rare frontier difficulty. Score difficulty, not importance or uncertainty. Reasoning is special: omit/2 requests low thinking; use 0 for direct/shallow work.";

function buildDescription(disabled = false): string {
	if (disabled) {
		return "DISABLED: Sub agents are currently disabled. Calls to this tool will return an error immediately. Enable by removing the --no-subagent flag or unsetting the PI_SUBAGENT_DISABLED environment variable.";
	}

	const lines = [
		"Delegate tasks to specialized subagents with isolated context.",
		"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
		'The "agent" field must be an exact discovered agent name, not a scope keyword like "user", "project", or "both".',
		'Default agent scope is "user" (from ~/.pi/agent/agents).',
		'To enable project-local agents in .pi/agents, set agentScope: "both" (or "project").',
		TASK_SCORE_GUIDANCE,
	];

	try {
		const { agents } = discoverAgents(process.cwd(), "user");
		if (agents.length > 0) {
			const listing = agents.map((a) => `${a.name}: ${a.description}`).join("; ");
			lines.push(`Available agents: ${listing}.`);
		}
	} catch {
		// Discovery failed — omit listing; agents will still be validated at execution time
	}

	return lines.join(" ");
}

function buildPromptSnippet(disabled = false): string {
	if (disabled) {
		return "DISABLED: Sub agents are disabled. Do not call the subagent tool — it will return an error.";
	}
	try {
		const { agents } = discoverAgents(process.cwd(), "user");
		if (agents.length > 0) {
			const names = agents.map((a) => a.name).join(', ');
			return `Delegate tasks to specialized subagents with isolated context. Available agents: ${names}. ${TASK_SCORE_GUIDANCE}`;
		}
	} catch { /* ignore */ }
	return `Delegate tasks to specialized subagents with isolated context. ${TASK_SCORE_GUIDANCE}`;
}

export default function (pi: ExtensionAPI) {
	// Register a CLI flag so users can disable subagent execution.
	// When set, the tool still registers (preventing LLM tool-call hangs)
	// but execute() returns an immediate error.
	pi.registerFlag("no-subagent", {
		description: "Disable subagent execution. The subagent tool will still appear in the tool list but will return an error immediately when called.",
		type: "boolean",
		default: false,
	});

	/** Check whether subagent execution is disabled via flag or env var. */
	const isDisabled = (): boolean =>
		pi.getFlag("no-subagent") === true ||
		["1", "true", "yes"].includes((process.env.PI_SUBAGENT_DISABLED ?? "").toLowerCase());

	const DISABLED_MESSAGE = "Sub agents are disabled. Enable them by removing the --no-subagent flag or unsetting the PI_SUBAGENT_DISABLED environment variable.";

	const disabled = isDisabled();

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: buildDescription(disabled),
		promptSnippet: buildPromptSnippet(disabled),
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			// --- Fast-fail when subagents are disabled ---
			if (isDisabled()) {
				return {
					content: [{ type: "text", text: DISABLED_MESSAGE }],
					details: { mode: "single" as const, agentScope: "user" as AgentScope, projectAgentsDir: null, results: [] },
					isError: true,
				};
			}

			// --- Resolve agentScope first (used in early-return details) ---
			const agentScope: AgentScope = params.agentScope ?? "user";

			// --- Depth + trail from async-local context (env-var fallback for outermost call) ---
			const runtimeCtx = readRuntimeContext();
			const currentDepth = runtimeCtx.depth;
			const trail = runtimeCtx.trail;
			if (currentDepth >= MAX_DEPTH) {
				return {
					content: [{ type: "text", text: `Subagent depth limit reached (max ${MAX_DEPTH}). Cannot spawn further subagents.` }],
					details: { mode: "single", agentScope, projectAgentsDir: null, results: [] },
					isError: true,
				};
			}

			// --- Per-call session counter (scoped to this reply, not the whole session) ---
			let sessionsSpawned = 0;
			const checkSessionLimit = (): string | undefined => {
				sessionsSpawned++;
				if (sessionsSpawned > MAX_SESSIONS_PER_CALL) {
					return `Sub-agent session limit reached (max ${MAX_SESSIONS_PER_CALL} sessions per reply).`;
				}
				return undefined;
			};
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? true;

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
				});
			const selectedMode = hasChain ? "chain" : hasTasks ? "parallel" : "single";

			if (modeCount !== 1) {
				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
						},
					],
					details: makeDetails("single")([]),
					isError: true,
				};
			}

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

			if (invalidResults.length > 0) {
				return {
					content: [{ type: "text", text: summarizeInvalidAgentResults(invalidResults) }],
					details: makeDetails(selectedMode)(invalidResults),
					isError: true,
				};
			}

			if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI) {
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
							details: makeDetails(selectedMode)([]),
							isError: true,
						};
				}
			}

			// --- Model selection setup ---
			// Shared registry lives at the pi config root so the VS Code extension's
			// model picker and this subagent dispatcher read the exact same file.
			// When absent, no score-based override is emitted below and normal
			// agent/caller model resolution takes over.
			const selectionConfigPath = path.join(CONFIG_ROOT, "model-profiles.json");
			let selectionConfig: ReturnType<typeof loadSelectionConfig> | undefined;
			try {
				selectionConfig = loadSelectionConfig(selectionConfigPath);
			} catch {
				// Missing or invalid config — fall through to normal agent/caller model resolution
			}

			// Load pricing from models.json and populate normalizedCost on profiles.
			// Missing or invalid pricing is non-fatal: profiles fall back to legacy cost.
			if (selectionConfig) {
				const modelsJsonPath = path.join(CONFIG_ROOT, "models.json");
				const pricingRecords = loadModelPricing(modelsJsonPath);
				for (const profile of selectionConfig.profiles) {
					const dimAggregate = profile.precision + profile.creativity + profile.thoroughness + profile.reasoning;
					const resolved = resolveModelCost(profile.id, pricingRecords, profile.cost, dimAggregate);
					// Only set normalizedCost when it comes from real pricing — let legacy cost
					// handle itself via the existing profile.cost field in ModelProfile.
					if (resolved.usedSource === "pricing") {
						profile.normalizedCost = resolved.normalizedCost;
					}
				}
			}

			const disabledProviders = getDisabledProviders(parseProviderToggles(process.env[PROVIDER_TOGGLES_ENV]));
			let allowedModelIds: Set<string> | undefined;
			if (disabledProviders.size > 0) {
				allowedModelIds = getAllowedModelIdsForProviders(ctx.modelRegistry.getAvailable(), disabledProviders);
			}

			const checkTrailLoop = (agentName: string): boolean => {
				const occurrences = trail.filter((t) => t === agentName).length;
				return occurrences >= 2;
			};

			const resolveModel = (agent: AgentConfig, perCallScores?: TaskScores, excludeModels?: Set<string>): { modelOverride: string | undefined; thinkingLevel: ThinkingLevel | undefined; selection: SelectionResult | undefined; callerScores: TaskScores | undefined; agentDefaultScores: TaskScores | undefined; mergedScores: TaskScores } => {
				const callerScores = perCallScores && Object.keys(perCallScores).length > 0 ? perCallScores : undefined;
				const agentDefaultScores = agent.defaultScores && Object.keys(agent.defaultScores).length > 0 ? agent.defaultScores : undefined;
				const mergedScores: TaskScores = { ...agent.defaultScores, ...perCallScores };
				if (!selectionConfig) return { modelOverride: undefined, thinkingLevel: undefined, selection: undefined, callerScores, agentDefaultScores, mergedScores };
				const selection = selectModel(mergedScores, selectionConfig, excludeModels, allowedModelIds);
				return { modelOverride: selection?.modelId, thinkingLevel: selection?.thinkingLevel, selection, callerScores, agentDefaultScores, mergedScores };
			};

			const attachSelectionMetadata = (result: SingleResult, resolved: ReturnType<typeof resolveModel>): void => {
				if (resolved.selection) {
					result.selectedModel = resolved.selection.modelId;
					result.selectionPool = resolved.selection.pool;
					result.selectionFitScores = resolved.selection.fitScores;
					result.thinkingLevel = resolved.selection.thinkingLevel;
				}
				result.taskScores = resolved.mergedScores;
				result.callerScores = resolved.callerScores;
				result.agentDefaultScores = resolved.agentDefaultScores;
			};

			/**
			 * Check if a subagent result represents a model-level failure that
			 * qualifies for automatic retry with a different model.
			 *
			 * We retry when:
			 * - The result errored (exitCode !== 0 or stopReason is "error")
			 * - The model was selected via the scoring algorithm (modelOverride was set)
			 * - The abort signal is not triggered (that's a user cancellation, not a model issue)
			 */
			const isModelFailure = (result: SingleResult, modelOverride: string | undefined): boolean =>
				result.exitCode !== 0
				&& result.stopReason !== "aborted"
				&& modelOverride !== undefined
				&& !!selectionConfig;

			if (params.chain && params.chain.length > 0) {
				const results: SingleResult[] = [];
				let previousOutput = "";
				// Shared exclusion set: if a model fails in one step, don't retry it in later steps
				const chainExcludeModels = new Set<string>();

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

					// Create update callback that includes all previous results
					const chainUpdate: OnUpdateCallback | undefined = onUpdate
						? (partial) => {
								// Combine completed results with current streaming result
								const currentResult = partial.details?.results[0];
								if (currentResult) {
									const allResults = [...results, currentResult];
									onUpdate({
										content: partial.content,
										details: makeDetails("chain")(allResults),
									});
								}
							}
						: undefined;

					if (checkTrailLoop(step.agent)) {
						results.push({ agent: step.agent, agentSource: "unknown", task: taskWithContext, exitCode: 1, messages: [], stderr: "", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 }, errorMessage: `Trail loop detected: agent "${step.agent}" already appeared twice in ancestor chain.`, step: i + 1 });
						return {
							content: [{ type: "text", text: `Chain stopped at step ${i + 1}: trail loop for agent "${step.agent}".` }],
							details: makeDetails("chain")(results),
							isError: true,
						};
					}

					const chainAgent = agents.find((a) => a.name === step.agent)!;

					const sessionLimitError = checkSessionLimit();
					if (sessionLimitError) {
						results.push({ agent: step.agent, agentSource: "unknown", task: taskWithContext, exitCode: 1, messages: [], stderr: "", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 }, errorMessage: sessionLimitError, step: i + 1 });
						return {
							content: [{ type: "text", text: `Chain stopped at step ${i + 1}: ${sessionLimitError}` }],
							details: makeDetails("chain")(results),
							isError: true,
						};
					}

					// Retry loop: if model fails, exclude it and try the next-best model
					let result: SingleResult;
					let chainResolved: ReturnType<typeof resolveModel>;

					for (let attempt = 0; attempt <= MAX_MODEL_RETRIES; attempt++) {
						chainResolved = resolveModel(chainAgent, step.taskScores, chainExcludeModels);
						result = await subagentRuntime.run(
							{ depth: currentDepth + 1, trail: [...trail, step.agent] },
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
									makeDetails("chain"),
									ctx.modelRegistry,
									ctx.model,
									chainResolved.modelOverride,
									chainResolved.thinkingLevel,
									disabledProviders,
								),
						);
						attachSelectionMetadata(result, chainResolved);

						// Check if this was a model-level failure that qualifies for retry
						if (isModelFailure(result, chainResolved.modelOverride) && attempt < MAX_MODEL_RETRIES) {
							chainExcludeModels.add(chainResolved.modelOverride!);
							result.failedModel = chainResolved.modelOverride;
							result.retryCount = attempt + 1;
							// Check if we have another model to try
							const nextResolved = resolveModel(chainAgent, step.taskScores, chainExcludeModels);
							if (!nextResolved.modelOverride) break; // no more models available
							continue; // retry with next model
						}
						break; // success or non-model failure
					}

					results.push(result!);

					const isError =
						result!.exitCode !== 0 || result!.stopReason === "error" || result!.stopReason === "aborted";
					if (isError) {
						const errorMsg =
							result!.errorMessage || result!.stderr || getFinalOutput(result!.messages) || "(no output)";
						return {
							content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}` }],
							details: makeDetails("chain")(results),
							isError: true,
						};
					}
					previousOutput = getFinalOutput(result!.messages);
				}
				return {
					content: [{ type: "text", text: getFinalOutput(results[results.length - 1].messages) || "(no output)" }],
					details: makeDetails("chain")(results),
				};
			}

			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS)
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
							},
						],
						details: makeDetails("parallel")([]),
						isError: true,
					};

				// Track all results for streaming updates
				const allResults: SingleResult[] = new Array(params.tasks.length);

				// Initialize placeholder results
				for (let i = 0; i < params.tasks.length; i++) {
					allResults[i] = {
						agent: params.tasks[i].agent,
						agentSource: "unknown",
						task: params.tasks[i].task,
						exitCode: -1, // -1 = still running
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
								{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` },
							],
							details: makeDetails("parallel")([...allResults]),
						});
					}
				};

				const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
					const sessionLimitError = checkSessionLimit();
					if (sessionLimitError) {
						const limitResult: SingleResult = { agent: t.agent, agentSource: "unknown", task: t.task, exitCode: 1, messages: [], stderr: "", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 }, errorMessage: sessionLimitError };
						allResults[index] = limitResult;
						emitParallelUpdate();
						return limitResult;
					}

					if (checkTrailLoop(t.agent)) {
						const loopResult: SingleResult = { agent: t.agent, agentSource: "unknown", task: t.task, exitCode: 1, messages: [], stderr: "", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 }, errorMessage: `Trail loop detected: agent "${t.agent}" already appeared twice in ancestor chain.` };
						allResults[index] = loopResult;
						emitParallelUpdate();
						return loopResult;
					}

					const parallelAgent = agents.find((a) => a.name === t.agent)!;
					// Retry loop: if model fails, exclude it and try the next-best model
					const taskExcludeModels = new Set<string>();
					let result: SingleResult | undefined;
					let parallelResolved: ReturnType<typeof resolveModel>;

					for (let attempt = 0; attempt <= MAX_MODEL_RETRIES; attempt++) {
						parallelResolved = resolveModel(parallelAgent, t.taskScores, taskExcludeModels);
						result = await subagentRuntime.run(
							{ depth: currentDepth + 1, trail: [...trail, t.agent] },
							() =>
								runSingleAgent(
									ctx.cwd,
									agents,
									t.agent,
									t.task,
									t.cwd,
									undefined,
									signal,
									// Per-task update callback
									(partial) => {
										if (partial.details?.results[0]) {
											allResults[index] = partial.details.results[0];
											emitParallelUpdate();
										}
									},
									makeDetails("parallel"),
									ctx.modelRegistry,
									ctx.model,
									parallelResolved.modelOverride,
									parallelResolved.thinkingLevel,
									disabledProviders,
								),
						);
						attachSelectionMetadata(result, parallelResolved);

						if (isModelFailure(result, parallelResolved.modelOverride) && attempt < MAX_MODEL_RETRIES) {
							taskExcludeModels.add(parallelResolved.modelOverride!);
							result.failedModel = parallelResolved.modelOverride;
							result.retryCount = attempt + 1;
							const nextResolved = resolveModel(parallelAgent, t.taskScores, taskExcludeModels);
							if (!nextResolved.modelOverride) break; // no more models available
							continue; // retry with next model
						}
						break; // success or non-model failure
					}

					allResults[index] = result!;
					emitParallelUpdate();
					return result!;
				});

				const successCount = results.filter((r) => r.exitCode === 0).length;
				const hasFailures = successCount !== results.length;
				const summaries = results.map((r) => {
					const summaryText =
						r.exitCode === 0
							? getFinalOutput(r.messages)
							: r.errorMessage || r.stderr || getFinalOutput(r.messages);
					const preview = summaryText.slice(0, PARALLEL_SUMMARY_PREVIEW) + (summaryText.length > PARALLEL_SUMMARY_PREVIEW ? "..." : "");
					return `[${r.agent}] ${r.exitCode === 0 ? "completed" : "failed"}: ${preview || "(no output)"}`;
				});
				return {
					content: [
						{
							type: "text",
							text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n")}`,
						},
					],
					details: makeDetails("parallel")(results),
					isError: hasFailures,
				};
			}

			if (params.agent && params.task) {
				if (checkTrailLoop(params.agent)) {
					return {
						content: [{ type: "text", text: `Trail loop detected: agent "${params.agent}" already appeared twice in ancestor chain.` }],
						details: makeDetails("single")([]),
						isError: true,
					};
				}

				const singleAgent = agents.find((a) => a.name === params.agent)!;

				// Retry loop: if model fails, exclude it and try the next-best model
				const singleExcludeModels = new Set<string>();
				let result: SingleResult | undefined;
				let singleResolved: ReturnType<typeof resolveModel>;

				for (let attempt = 0; attempt <= MAX_MODEL_RETRIES; attempt++) {
					singleResolved = resolveModel(singleAgent, params.taskScores, singleExcludeModels);
					result = await subagentRuntime.run(
						{ depth: currentDepth + 1, trail: [...trail, params.agent] },
						() =>
							runSingleAgent(
								ctx.cwd,
								agents,
								params.agent!,
								params.task!,
								params.cwd,
								undefined,
								signal,
								onUpdate,
								makeDetails("single"),
								ctx.modelRegistry,
								ctx.model,
								singleResolved.modelOverride,
								singleResolved.thinkingLevel,
								disabledProviders,
							),
					);
					attachSelectionMetadata(result, singleResolved);

					if (isModelFailure(result, singleResolved.modelOverride) && attempt < MAX_MODEL_RETRIES) {
						singleExcludeModels.add(singleResolved.modelOverride!);
						result.failedModel = singleResolved.modelOverride;
						result.retryCount = attempt + 1;
						const nextResolved = resolveModel(singleAgent, params.taskScores, singleExcludeModels);
						if (!nextResolved.modelOverride) break; // no more models available
						continue; // retry with next model
					}
					break; // success or non-model failure
				}

				const isError = result!.exitCode !== 0 || result!.stopReason === "error" || result!.stopReason === "aborted";
				if (isError) {
					const errorMsg =
						result!.errorMessage || result!.stderr || getFinalOutput(result!.messages) || "(no output)";
					return {
						content: [{ type: "text", text: `Agent ${result!.stopReason || "failed"}: ${errorMsg}` }],
						details: makeDetails("single")([result!]),
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: getFinalOutput(result!.messages) || "(no output)" }],
					details: makeDetails("single")([result!]),
				};
			}

			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
				details: makeDetails("single")([]),
			};
		},

		renderCall(args, theme, context) {
			return renderSubagentCall(args, theme, context);
		},

		renderResult(result, options, theme, context) {
			return renderSubagentResult(result, options, theme, context);
		},
	});
}
