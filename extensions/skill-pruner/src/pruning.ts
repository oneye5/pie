import path from "node:path";
import type { Skill, ToolInfo, BeforeAgentStartEvent } from "@mariozechner/pi-coding-agent";
import { loadConfig } from "../config.js";
import type { PruningConfig } from "../types.js";
import {
	getConfigOverrideForTesting,
	getPiToolSeams as getPiToolSeamsFromState,
	CONFIG_ROOT,
	PROCESS_SESSION_ID,
} from "./state.js";

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
export {
	getRecentConversation,
	getCompleteFn,
	resolveModel,
	resolveAuth,
	prepassTimeoutMs,
	buildPrepassThinkingAttempts,
	hasUsablePrepassResponse,
	formatEmptyPrepassError,
	runPruningPrepass,
	LLM_TIMEOUT_MS_BY_THINKING_LEVEL,
} from "./prepass.js";

export const SKILLS_BLOCK_RE = /\n\nThe following skills provide specialized instructions for specific tasks\.[\s\S]*?<\/available_skills>/;
export const MIN_PROMPT_LENGTH = 8;

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
	prunedSkills: string[] | null,
	effectivePinned: string[],
	_activeConfig: PruningConfig,
): { includedSkillNames: string[]; excludedSkillNames: string[]; failOpenReason?: string } {
	// No usable prepass signal → keep everything.
	if (prunedSkills === null) {
		return {
			includedSkillNames: visibleSkills.map((s) => s.name),
			excludedSkillNames: [],
		};
	}

	const protectedNames = new Set(effectivePinned);
	const visibleNames = new Set(visibleSkills.map((s) => s.name));
	const pruneSet = new Set(
		prunedSkills.filter((name) => visibleNames.has(name) && !protectedNames.has(name)),
	);

	const excludedSkillNames = visibleSkills.filter((s) => pruneSet.has(s.name)).map((s) => s.name);
	const includedSkillNames = visibleSkills.filter((s) => !pruneSet.has(s.name)).map((s) => s.name);

	// Keep-all safeguard: when the prepass prunes every visible skill we keep all
	// rather than strip the lot. This can fire for a legitimate full prune (e.g.
	// a non-coding query where no skill is relevant to the arc of work), since the
	// prepass can't reliably distinguish that from an over-prune and the cost of a
	// wrong keep is only tokens. Pinned skills already survive, so this only fires
	// when nothing at all would remain.
	if (includedSkillNames.length === 0 && visibleSkills.length > 0) {
		return {
			includedSkillNames: visibleSkills.map((s) => s.name),
			excludedSkillNames: [],
			failOpenReason: "LLM pruned every visible skill; keeping all as a safeguard",
		};
	}

	return { includedSkillNames, excludedSkillNames };
}

export function applyToolSelection(
	allTools: ToolInfo[],
	prunedTools: string[] | null,
	activeConfig: PruningConfig,
): { includedToolNames: string[]; excludedToolNames: string[]; failOpenReason?: string } {
	// No tools config (tool pruning disabled) or no tools present → keep everything.
	if (!activeConfig.tools || allTools.length === 0) {
		return {
			includedToolNames: allTools.map((t) => t.name),
			excludedToolNames: [],
		};
	}

	// No usable prepass signal → keep everything.
	if (prunedTools === null) {
		return {
			includedToolNames: allTools.map((t) => t.name),
			excludedToolNames: [],
		};
	}

	const alwaysKeepTools = activeConfig.tools.alwaysKeep ?? [];
	const protectedBase = new Set(alwaysKeepTools);
	const allNames = new Set(allTools.map((t) => t.name));
	const pruneSet = new Set(
		prunedTools.filter((name) => allNames.has(name) && !protectedBase.has(name)),
	);

	// A tool that is a dependency (transitively) of a KEPT tool must not be pruned —
	// pruning it would strand the tool that needs it. Walk to a fixpoint.
	const dependencies = activeConfig.tools.dependencies;
	if (dependencies && pruneSet.size > 0) {
		let changed = true;
		while (changed) {
			changed = false;
			const kept = allTools.filter((t) => !pruneSet.has(t.name)).map((t) => t.name);
			for (const keptTool of kept) {
				for (const dep of dependencies[keptTool] ?? []) {
					if (pruneSet.has(dep)) {
						pruneSet.delete(dep);
						changed = true;
					}
				}
			}
		}
	}

	const excludedToolNames = allTools.filter((t) => pruneSet.has(t.name)).map((t) => t.name);
	const includedToolNames = allTools.filter((t) => !pruneSet.has(t.name)).map((t) => t.name);

	// Keep-all safeguard: a coding agent with zero tools is dead, so when the
	// prepass prunes every tool we keep all rather than strip the lot. alwaysKeep
	// already survives, so this only fires when nothing at all would remain.
	if (includedToolNames.length === 0 && allTools.length > 0) {
		return {
			includedToolNames: allTools.map((t) => t.name),
			excludedToolNames: [],
			failOpenReason: "LLM pruned every tool; keeping all as a safeguard",
		};
	}

	return { includedToolNames, excludedToolNames };
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
