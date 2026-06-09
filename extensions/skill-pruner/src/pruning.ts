import path from "node:path";
import type { Skill, ToolInfo, BeforeAgentStartEvent } from "@mariozechner/pi-coding-agent";
import { loadConfig } from "../config.js";
import { runLlmPruning, type CompleteSimpleFn, type LlmPruningInput } from "../llm-scorer.js";
import type { PruningConfig } from "../types.js";
import {
	state,
	getConfigOverrideForTesting,
	getCompleteFnOverride,
	getPiToolSeams as getPiToolSeamsFromState,
	CONFIG_ROOT,
	PROCESS_SESSION_ID,
} from "./state.js";
import {
	ensureCopilotHeaders,
	withCopilotHeaders,
	withCopilotOptions,
	COPILOT_IDE_HEADERS,
} from "./copilot-headers.js";
import type { PrepassRunResult, SkillPruningResult, ToolPruningResult } from "./pruning-types.js";

export {
	buildPruningPayload,
	buildHint,
	buildReplacement,
	buildDecision,
	buildFeedbackMessage,
	estimateToolTokens,
	type PrepassDiagnostics,
} from "./message-builders.js";
export { COPILOT_IDE_HEADERS, ensureCopilotHeaders, withCopilotHeaders, withCopilotOptions } from "./copilot-headers.js";
export type { PrepassRunResult, SkillPruningResult, ToolPruningResult } from "./pruning-types.js";

export const SKILLS_BLOCK_RE = /\n\nThe following skills provide specialized instructions for specific tasks\.[\s\S]*?<\/available_skills>/;
export const MIN_PROMPT_LENGTH = 8;
export const LLM_TIMEOUT_MS_BY_THINKING_LEVEL: Record<string, number> = {
	minimal: 10_000,
	low: 10_000,
	medium: 15_000,
	high: 20_000,
	xhigh: 25_000,
};

/** Returns the pi API facade, falling back to no-ops when pi hasn't been initialized. */
export function getPiToolSeams(): { getAllTools: () => ToolInfo[]; getActiveTools: () => string[]; setActiveTools: (names: string[]) => void } {
	return getPiToolSeamsFromState();
}

export function shouldSkipPruning(
	event: BeforeAgentStartEvent,
	activeConfig: PruningConfig,
): { skip: boolean; reason?: "disabled-by-toggle" | "off" | "too-short" } {
	if (isExtensionDisabledByToggle("skill-pruner")) {
		return { skip: true, reason: "disabled-by-toggle" };
	}
	if (activeConfig.mode === "off") {
		return { skip: true, reason: "off" };
	}
	if (event.prompt.trim().length < MIN_PROMPT_LENGTH) {
		return { skip: true, reason: "too-short" };
	}
	return { skip: false };
}

export function resolveVisibleSkills(skills: Skill[], activeConfig: PruningConfig) {
	const visibleSkills = skills.filter((s) => !s.disableModelInvocation);
	const disabledNames = new Set(
		skills.filter((s) => s.disableModelInvocation).map((s) => s.name),
	);

	const visibleSkillNames = new Set(visibleSkills.map((s) => s.name));
	const effectivePinned = [...new Set([
		...(activeConfig.skills.pinned ?? []),
		...(activeConfig.skills.alwaysKeep ?? []),
	])].filter((name) => {
		if (disabledNames.has(name)) {
			console.warn(`[skill-pruner] forced-include skill '${name}' is disabled (disableModelInvocation); skipping`);
			return false;
		}
		if (!visibleSkillNames.has(name)) {
			console.warn(`[skill-pruner] forced-include skill '${name}' is not in the current session's visible skills; skipping`);
			return false;
		}
		return true;
	});

	return {
		visibleSkills,
		visibleSkillNames,
		effectivePinned,
	};
}

export function applySkillSelection(
	visibleSkills: Skill[],
	llmSelectedSkills: string[] | null,
	effectivePinned: string[],
	activeConfig: PruningConfig,
	skillsExplicitlyEmpty: boolean,
): { includedSkillNames: string[]; excludedSkillNames: string[]; failOpenReason?: string } {
	let includedSkillNames: string[];
	let excludedSkillNames: string[];
	let failOpenReason: string | undefined;

	if (llmSelectedSkills !== null) {
		const forcedSet = new Set(effectivePinned);
		const orderedSelection = [
			...effectivePinned,
			...llmSelectedSkills.filter((name) => !forcedSet.has(name)),
		];
		const ceiling = Math.max(activeConfig.skills.ceiling, effectivePinned.length);
		const finalSet = new Set(orderedSelection.slice(0, ceiling));

		includedSkillNames = visibleSkills.filter((s) => finalSet.has(s.name)).map((s) => s.name);
		excludedSkillNames = visibleSkills.filter((s) => !finalSet.has(s.name)).map((s) => s.name);

		if (includedSkillNames.length === 0 && visibleSkills.length > 0 && !skillsExplicitlyEmpty) {
			includedSkillNames = visibleSkills.map((s) => s.name);
			excludedSkillNames = [];
			failOpenReason = "All model-selected skills were unknown or invalid; keeping all skills as fail-open";
		}
	} else {
		includedSkillNames = visibleSkills.map((s) => s.name);
		excludedSkillNames = [];
	}

	return { includedSkillNames, excludedSkillNames, failOpenReason };
}

export function applyToolSelection(
	allTools: ToolInfo[],
	llmSelectedTools: string[] | null,
	activeConfig: PruningConfig,
	toolsExplicitlyEmpty: boolean,
): { includedToolNames: string[]; excludedToolNames: string[]; failOpenReason?: string } {
	let includedToolNames: string[];
	let excludedToolNames: string[];
	let failOpenReason: string | undefined;

	if (activeConfig.tools && allTools.length > 0) {
		if (llmSelectedTools !== null) {
			const alwaysKeepTools = activeConfig.tools.alwaysKeep ?? [];
			const forcedToolSet = new Set(alwaysKeepTools);
			const orderedTools = [
				...alwaysKeepTools,
				...llmSelectedTools.filter((name) => !forcedToolSet.has(name)),
			];
			const seedTools = orderedTools.slice(0, Math.max(activeConfig.tools.ceiling, alwaysKeepTools.length));

			const dependencies = activeConfig.tools.dependencies;
			const queue = [...seedTools];
			const expanded = new Set(seedTools);
			while (queue.length > 0) {
				const tool = queue.shift()!;
				const deps = dependencies[tool] ?? [];
				for (const dep of deps) {
					if (!expanded.has(dep)) {
						expanded.add(dep);
						queue.push(dep);
					}
				}
			}

			includedToolNames = [...expanded];
			const includedSet = new Set(includedToolNames);
			excludedToolNames = allTools.map((t) => t.name).filter((name) => !includedSet.has(name));

			if (includedToolNames.length === 0 && allTools.length > 0 && !toolsExplicitlyEmpty) {
				includedToolNames = allTools.map((t) => t.name);
				excludedToolNames = [];
				failOpenReason = "All model-selected tools were unknown or invalid; keeping all tools as fail-open";
			}
		} else {
			includedToolNames = allTools.map((t) => t.name);
			excludedToolNames = [];
		}
	} else {
		includedToolNames = allTools.map((t) => t.name);
		excludedToolNames = [];
	}

	return { includedToolNames, excludedToolNames, failOpenReason };
}

export function isExtensionDisabledByToggle(extensionId: string): boolean {
	const raw = process.env["PIE_EXTENSION_TOGGLES_JSON"];
	if (!raw) return false;
	try {
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		if (!parsed || typeof parsed !== "object") return false;
		return parsed[extensionId] === false;
	} catch {
		return false;
	}
}

export function clonePruningConfig(input: PruningConfig): PruningConfig {
	return {
		mode: input.mode,
		model: input.model,
		provider: input.provider,
		thinkingLevel: input.thinkingLevel,
		skills: {
			strategy: input.skills.strategy,
			ceiling: input.skills.ceiling,
			pinned: [...(input.skills.pinned ?? [])],
			alwaysKeep: [...(input.skills.alwaysKeep ?? [])],
		},
		tools: input.tools ? {
			strategy: input.tools.strategy,
			ceiling: input.tools.ceiling,
			dependencies: Object.fromEntries(Object.entries(input.tools.dependencies).map(([k, v]) => [k, [...v]])),
			alwaysKeep: [...(input.tools.alwaysKeep ?? [])],
		} : undefined,
	};
}

export function getConfig(): PruningConfig {
	const override = getConfigOverrideForTesting();
	if (override) {
		return clonePruningConfig(override);
	}
	return loadConfig(path.join(CONFIG_ROOT, "settings.json"));
}

export function getSessionId(ctx: unknown): string {
	const ctxObj = ctx as Record<string, unknown>;
	const sessionManager = ctxObj?.sessionManager as { getSessionId?: () => string } | undefined;
	const sessionId = sessionManager?.getSessionId?.();
	return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : PROCESS_SESSION_ID;
}

export function getSessionPath(ctx: unknown): string {
	const ctxObj = ctx as Record<string, unknown>;
	const sessionManager = ctxObj?.sessionManager as { getSessionFile?: () => string | undefined } | undefined;
	const sessionPath = sessionManager?.getSessionFile?.();
	return typeof sessionPath === "string" && sessionPath.length > 0 ? sessionPath : getSessionId(ctx);
}

export function getCompleteFn(_ctx: unknown): CompleteSimpleFn | null {
	const override = getCompleteFnOverride();
	if (override === false) return null;
	if (override) return override;

	const adapter: CompleteSimpleFn = async (model, context, options) => {
		if (state._piCompleteSimple === undefined) {
			try {
				const piAi = await import("@mariozechner/pi-ai");
				state._piCompleteSimple = piAi.completeSimple;
			} catch {
				state._piCompleteSimple = null;
			}
		}
		if (!state._piCompleteSimple) {
			throw new Error("@mariozechner/pi-ai not available");
		}
		const systemMsg = context.find((m) => m.role === "system");
		const nonSystemMsgs = context.filter((m) => m.role !== "system");
		const piContext = {
			systemPrompt: systemMsg?.content ?? "",
			messages: nonSystemMsgs.map((m) => ({
				role: m.role,
				content: [{ type: "text" as const, text: m.content }],
				timestamp: Date.now(),
			})),
		};

		const safeModel = ensureCopilotHeaders(model as Record<string, unknown>);
		const safeOptions = withCopilotOptions(options, model as Record<string, unknown>);

		const result = await state._piCompleteSimple(safeModel, piContext, safeOptions);
		const assistantMessage = result as {
			content?: Array<{ type: string; text?: string; thinking?: string }>;
			stopReason?: string;
			errorMessage?: string;
		};
		const content = assistantMessage.content ?? [];
		const text = content
			.filter((block) => block.type === "text")
			.map((block) => block.text ?? "")
			.join("");
		const thinking = content
			.filter((block) => block.type === "thinking")
			.map((block) => block.thinking ?? "")
			.join("");
		return {
			text,
			thinking,
			stopReason: assistantMessage.stopReason,
			errorMessage: assistantMessage.errorMessage,
		};
	};
	return adapter;
}

export function resolveModel(ctx: unknown, _config: PruningConfig): unknown {
	const ctxObj = ctx as Record<string, unknown>;
	const modelRegistry = ctxObj?.modelRegistry as { find?: (provider: string, id: string) => unknown } | undefined;
	if (modelRegistry?.find) {
		const raw = modelRegistry.find(_config.provider, _config.model);
		if (raw && typeof raw === "object") {
			return ensureCopilotHeaders(raw as Record<string, unknown>);
		}
		return raw;
	}
	if (getCompleteFnOverride()) {
		return { id: _config.model, provider: _config.provider, api: "unknown" };
	}
	return undefined;
}

export async function resolveAuth(ctx: unknown, model: unknown): Promise<{ apiKey?: string; headers?: Record<string, string> }> {
	const modelObj = model as Record<string, unknown> | null;
	const isCopilot = modelObj?.provider === "github-copilot";

	const ctxObj = ctx as Record<string, unknown>;
	const modelRegistry = ctxObj?.modelRegistry as { getApiKeyAndHeaders?: (model: unknown) => Promise<{ ok: boolean; apiKey?: string; headers?: Record<string, string> }> } | undefined;
	if (modelRegistry?.getApiKeyAndHeaders) {
		const result = await modelRegistry.getApiKeyAndHeaders(model);
		if (result.ok) {
			return { apiKey: result.apiKey, headers: withCopilotHeaders(result.headers, isCopilot) };
		}
	}

	return isCopilot ? { headers: { ...COPILOT_IDE_HEADERS } } : {};
}

export function prepassTimeoutMs(thinkingLevel: string): number {
	return LLM_TIMEOUT_MS_BY_THINKING_LEVEL[thinkingLevel] ?? LLM_TIMEOUT_MS_BY_THINKING_LEVEL.minimal;
}

export function buildPrepassThinkingAttempts(thinkingLevel: string): string[] {
	if (thinkingLevel === "minimal") {
		return [thinkingLevel];
	}
	return [...new Set([thinkingLevel, "minimal"])];
}

export function hasUsablePrepassResponse(result: Awaited<ReturnType<typeof runLlmPruning>>): boolean {
	return result.rawResponse.trim().length > 0;
}

export function formatEmptyPrepassError(result: Awaited<ReturnType<typeof runLlmPruning>>): string {
	const diagnostics: string[] = [];
	if (result.stopReason) {
		diagnostics.push(`stopReason=${result.stopReason}`);
	}
	if (result.errorMessage) {
		diagnostics.push(result.errorMessage);
	}
	if (diagnostics.length === 0) {
		return "LLM pruning failed: returned no text response";
	}
	return `LLM pruning failed: returned no text response (${diagnostics.join("; ")})`;
}

export async function runPruningPrepass(
	ctx: unknown,
	llmInput: LlmPruningInput,
	activeConfig: PruningConfig,
	completeFn: CompleteSimpleFn,
): Promise<PrepassRunResult> {
	const emptyResult = (thinkingLevel: string, error: string | null): PrepassRunResult => ({
		selectedSkills: null,
		selectedTools: null,
		skillsExplicitlyEmpty: false,
		toolsExplicitlyEmpty: false,
		error,
		rawResponse: "",
		rawThinking: "",
		rawSystemPrompt: "",
		rawUserMessage: "",
		latencyMs: 0,
		thinkingLevel,
	});

	const model = resolveModel(ctx, activeConfig);
	if (!model) {
		return emptyResult(activeConfig.thinkingLevel, `Model '${activeConfig.model}' (provider: ${activeConfig.provider}) not found in registry`);
	}

	const auth = await resolveAuth(ctx, model);
	const attempts = buildPrepassThinkingAttempts(activeConfig.thinkingLevel);
	let latestResult = emptyResult(activeConfig.thinkingLevel, null);

	for (let index = 0; index < attempts.length; index++) {
		const thinkingLevel = attempts[index];
		try {
			const result = await runLlmPruning(llmInput, model, {
				reasoning: thinkingLevel,
				signal: AbortSignal.timeout(prepassTimeoutMs(thinkingLevel)),
				...auth,
			}, completeFn);

			latestResult = {
				selectedSkills: result.selectedSkills,
				selectedTools: result.selectedTools,
				skillsExplicitlyEmpty: result.skillsExplicitlyEmpty ?? false,
				toolsExplicitlyEmpty: result.toolsExplicitlyEmpty ?? false,
				error: null,
				rawResponse: result.rawResponse,
				rawThinking: result.rawThinking,
				rawSystemPrompt: result.systemPrompt,
				rawUserMessage: result.userMessage,
				latencyMs: result.latencyMs,
				thinkingLevel,
			};

			if (hasUsablePrepassResponse(result)) {
				return latestResult;
			}

			latestResult.error = formatEmptyPrepassError(result);
			if (index < attempts.length - 1) {
				console.warn(`[skill-pruner] ${latestResult.error}; retrying with minimal reasoning`);
			}
		} catch (error) {
			const errorMessage = `LLM pruning failed: ${error instanceof Error ? error.message : String(error)}`;
			if (index < attempts.length - 1) {
				latestResult = {
					...latestResult,
					selectedSkills: null,
					selectedTools: null,
					skillsExplicitlyEmpty: false,
					toolsExplicitlyEmpty: false,
					error: errorMessage,
					thinkingLevel,
				};
				console.warn(`[skill-pruner] ${errorMessage}; retrying with minimal reasoning`);
				continue;
			}
			console.warn(`[skill-pruner] ${errorMessage}`);
			return {
				...latestResult,
				selectedSkills: null,
				selectedTools: null,
				skillsExplicitlyEmpty: false,
				toolsExplicitlyEmpty: false,
				error: errorMessage,
				thinkingLevel,
			};
		}
	}

	if (latestResult.error) {
		console.warn(`[skill-pruner] ${latestResult.error}`);
		return latestResult;
	}

	return {
		...latestResult,
		error: "LLM pruning failed: returned no text response",
	};
}
