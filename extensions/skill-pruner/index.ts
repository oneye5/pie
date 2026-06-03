import path from "node:path";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { formatSkillsForPrompt } from "@mariozechner/pi-coding-agent";
import type {
	Skill,
	ExtensionAPI,
	BeforeAgentStartEvent,
	ToolCallEvent,
	InputEvent,
	ToolInfo,
} from "@mariozechner/pi-coding-agent";
import { Box, Text } from "@mariozechner/pi-tui";
import { loadConfig } from "./config.js";
import {
	runLlmPruning,
	__setPromptTemplate as __setPruningPromptTemplate,
	type CompleteSimpleFn,
	type LlmPruningInput,
} from "./llm-scorer.js";
import { appendDecision, estimateTokens, recordKnownSkills, recordSkillRead } from "./logger.js";
import type { PruningConfig, PruningDecision, PruningResult } from "./types.js";

/** Lazily-resolved reference to @mariozechner/pi-ai's completeSimple (available via jiti at runtime). */
let _piCompleteSimple: ((model: unknown, context: unknown, options: unknown) => Promise<unknown>) | null | undefined;

/** Root of the pi-config repo, resolved from this extension's known position. */
const CONFIG_ROOT = path.resolve(import.meta.dirname, "..", "..");

const SKILLS_BLOCK_RE = /\n\nThe following skills provide specialized instructions for specific tasks\.[\s\S]*?<\/available_skills>/;
const PROCESS_SESSION_ID = randomUUID();
const LLM_TIMEOUT_MS_BY_THINKING_LEVEL: Record<string, number> = {
	minimal: 10_000,
	low: 10_000,
	medium: 15_000,
	high: 20_000,
	xhigh: 25_000,
};
/** Minimum prompt length (in characters) to justify running the LLM prepass. Shorter prompts skip pruning. */
const MIN_PROMPT_LENGTH = 8;

let configOverrideForTesting: PruningConfig | null = null;
let formatSkillsForPromptImpl: (skills: Skill[]) => string = formatSkillsForPrompt;
/** Test seam: overrides getAllTools / getActiveTools / setActiveTools. */
let getAllToolsOverride: (() => ToolInfo[]) | null = null;
let getActiveToolsOverride: (() => string[]) | null = null;
let setActiveToolsOverride: ((names: string[]) => void) | null = null;
/** Test seam: override the LLM completion function. Use `false` to simulate unavailable. */
let completeFnOverride: CompleteSimpleFn | null | false = null;

/** Facade for pi API methods used for tool introspection. Captured from pi in the factory closure. */
let piApi: {
	getAllTools: () => ToolInfo[];
	getActiveTools: () => string[];
	setActiveTools: (names: string[]) => void;
} | null = null;

/** Returns the pi API facade, falling back to no-ops when pi hasn't been initialized. */
function getPiToolSeams(): { getAllTools: () => ToolInfo[]; getActiveTools: () => string[]; setActiveTools: (names: string[]) => void } {
	return piApi ?? {
		getAllTools: () => [],
		getActiveTools: () => [],
		setActiveTools: () => {},
	};
}

export default function (pi: ExtensionAPI) {
	// DIAGNOSTIC: prove extension loads
	try {
		writeFileSync(path.join(CONFIG_ROOT, "data", "skill-pruner-loaded.txt"), `loaded at ${new Date().toISOString()}\n`);
	} catch { /* ignore */ }

	// Capture pi API methods for tool introspection (available throughout the session).
	piApi = {
		getAllTools: () => pi.getAllTools(),
		getActiveTools: () => pi.getActiveTools(),
		setActiveTools: (names) => pi.setActiveTools(names),
	};

	// --- Message renderer for pruning-result custom type ---
	pi.registerMessageRenderer("pruning-result", (message, { expanded }, theme) => {
		const details = message.details as PruningResult | undefined;
		if (!details) {
			const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
			box.addChild(new Text(String(message.content), 0, 0));
			return box;
		}

		const mode = details.mode === "shadow" ? "shadow" : details.mode;
		const modeLabel = theme.fg("dim", mode === "shadow" ? "[shadow] " : "");
		const skillSummary = details.excludedSkills.length > 0
			? `Kept ${details.includedSkills.length}/${details.includedSkills.length + details.excludedSkills.length} skills`
			: "All skills included";
		const toolSummary = details.excludedTools.length > 0
			? `Kept ${details.includedTools.length}/${details.includedTools.length + details.excludedTools.length} tools`
			: "";
		const parts = [skillSummary, toolSummary].filter(Boolean);
		const tokenNote = details.skillTokensSaved + details.toolTokensSaved > 0
			? ` · Saved ~${details.skillTokensSaved + details.toolTokensSaved} tokens`
			: "";

		if (!expanded) {
			const compact = `${modeLabel}Pruned: ${parts.join(", ")}${tokenNote}`;
			const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
			box.addChild(new Text(compact, 0, 0));
			return box;
		}

		// Expanded view
		const lines: string[] = [];
		if (details.excludedSkills.length > 0) {
			lines.push(theme.fg("success", `  Skills kept: ${details.includedSkills.join(", ")}`));
			lines.push(theme.fg("dim", `  Skills pruned: ${details.excludedSkills.join(", ")}`));
		}
		if (details.excludedTools.length > 0) {
			lines.push(theme.fg("success", `  Tools kept: ${details.includedTools.join(", ")}`));
			lines.push(theme.fg("dim", `  Tools pruned: ${details.excludedTools.join(", ")}`));
		}
		if (tokenNote) {
			lines.push(theme.fg("accent", `  ${tokenNote.trim()}`));
		}

		const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
		box.addChild(new Text(`${modeLabel}Pruning Results\n${lines.join("\n")}`, 0, 0));
		return box;
	});

	// --- request_tool: recovery tool for pruned tools ---
	pi.registerTool({
		name: "request_tool",
		label: "Request Tool",
		description: "Request a tool that was pruned from the current session. Use when you need a tool that is not currently available. The tool will be enabled for the remainder of the session.",
		parameters: {
			type: "object",
			properties: {
				toolName: {
					type: "string",
					description: "The name of the tool to enable (e.g. 'web_search', 'fetch_content')",
				},
			},
			required: ["toolName"],
		},
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const toolName = params.toolName as string;
			const allTools = getAllToolsOverride
				? getAllToolsOverride()
				: getPiToolSeams().getAllTools();
			const activeTools = getActiveToolsOverride
				? getActiveToolsOverride()
				: getPiToolSeams().getActiveTools();

			const knownNames = new Set(allTools.map((t) => t.name));
			if (!knownNames.has(toolName)) {
				return { content: [{ type: "text" as const, text: `Unknown tool '${toolName}'. Available tools: ${[...knownNames].sort().join(", ")}` }], isError: true };
			}
			if (activeTools.includes(toolName)) {
				return { content: [{ type: "text" as const, text: `Tool '${toolName}' is already active.` }] };
			}

			const newActiveTools = [...activeTools, toolName];
			if (setActiveToolsOverride) {
				setActiveToolsOverride(newActiveTools);
			} else {
				getPiToolSeams().setActiveTools(newActiveTools);
			}

			return { content: [{ type: "text" as const, text: `Tool '${toolName}' has been enabled and is now available.` }] };
		},
	});

	// --- before_agent_start: skill + tool pruning ---
	pi.on("before_agent_start", async (event: BeforeAgentStartEvent, ctx) => {
		// DIAGNOSTIC: prove hook fires
		try {
			writeFileSync(path.join(CONFIG_ROOT, "data", "skill-pruner-hook-fired.txt"), `hook at ${new Date().toISOString()}\n`);
		} catch { /* ignore */ }

		// Honor the per-extension toggle set in the pie GUI. When the user disables
		// skill-pruner via the settings menu, the host writes PIE_EXTENSION_TOGGLES_JSON
		// (see protocol.EXTENSION_TOGGLES_ENV / runtimePrefs.set RPC). A `false` value
		// short-circuits the hook so no pruning runs and no pruning-result message is
		// emitted to the transcript.
		if (isExtensionDisabledByToggle("skill-pruner")) {
			return undefined;
		}

		const activeConfig = getConfig();
		const sessionId = getSessionId(ctx);
		const sessionPath = getSessionPath(ctx);
		const skills = event.systemPromptOptions.skills ?? [];
		const allSkillPaths = skills.map((s) => s.filePath);

		// --- Off mode: no pruning, but still log skill reads ---
		if (activeConfig.mode === "off") {
			recordKnownSkills(sessionId, "off", allSkillPaths, [], []);
			return undefined;
		}

		// --- Skip pruning for trivial/short prompts (greetings, "continue", etc.) ---
		if (event.prompt.trim().length < MIN_PROMPT_LENGTH) {
			recordKnownSkills(sessionId, activeConfig.mode, allSkillPaths, [], []);
			return undefined;
		}

		// --- Skill + Tool pruning via LLM ---
		let modifiedSystemPrompt = event.systemPrompt;
		let skillPruningRan = false;
		let skillResult: SkillPruningResult | null = null;
		let toolResult: ToolPruningResult | null = null;
		let pruningError: string | null = null;
		let rawResponse = "";
		let rawThinking = "";
		let rawSystemPrompt = "";
		let rawUserMessage = "";
		let prepassThinkingLevel = activeConfig.thinkingLevel;
		let latencyMs = 0;

		if (skills.length > 0) {
			// Exclude disabled skills from LLM consideration
			const visibleSkills = skills.filter((s) => !s.disableModelInvocation);
			const disabledNames = new Set(
				skills.filter((s) => s.disableModelInvocation).map((s) => s.name),
			);

			// Forced-include names that resolve to a disabled skill → warn + skip.
			const effectivePinned = [...new Set([
				...(activeConfig.skills.pinned ?? []),
				...(activeConfig.skills.alwaysKeep ?? []),
			])].filter((name) => {
				if (disabledNames.has(name)) {
					console.warn(`[skill-pruner] forced-include skill '${name}' is disabled (disableModelInvocation); skipping`);
					return false;
				}
				return true;
			});

			const contextFile = event.systemPromptOptions.contextFiles?.[0];

			// Build tool candidates
			const allTools = getAllToolsOverride
				? getAllToolsOverride()
				: getPiToolSeams().getAllTools();

			const llmInput: LlmPruningInput = {
				userPrompt: event.prompt,
				contextFile: contextFile?.path,
				skills: visibleSkills.map((s) => ({ name: s.name, description: s.description })),
				tools: allTools.map((t) => ({ name: t.name, description: t.description ?? "" })),
				config: activeConfig,
			};

			// Resolve model and call LLM
			let llmSelectedSkills: string[] | null = null;
			let llmSelectedTools: string[] | null = null;

			const completeFn = getCompleteFn(ctx);
			if (!completeFn) {
				pruningError = "No completion function available";
				recordKnownSkills(sessionId, activeConfig.mode, allSkillPaths, [], []);
				// Fall through to emit status message
			} else {
				const prepassResult = await runPruningPrepass(ctx, llmInput, activeConfig, completeFn);
				llmSelectedSkills = prepassResult.selectedSkills;
				llmSelectedTools = prepassResult.selectedTools;
				pruningError = prepassResult.error;
				rawResponse = prepassResult.rawResponse;
				rawThinking = prepassResult.rawThinking;
				rawSystemPrompt = prepassResult.rawSystemPrompt;
				rawUserMessage = prepassResult.rawUserMessage;
				prepassThinkingLevel = prepassResult.thinkingLevel;
				latencyMs = prepassResult.latencyMs;
			}

			if (!pruningError || pruningError.startsWith("Model") || pruningError.startsWith("LLM pruning failed")) {
				// Fail-open guard: if LLM returned empty selections for both skills
				// and tools, treat it as a failed prepass (keep everything).
				// This is not an error — it's expected for ambiguous prompts. We
				// silently keep everything and do NOT surface it in the transcript
				// (emitting a message here would confuse the main model).
				if (
					llmSelectedSkills !== null && llmSelectedSkills.length === 0 &&
					llmSelectedTools !== null && llmSelectedTools.length === 0
				) {
					console.warn("[skill-pruner] LLM returned empty selections for both skills and tools; failing open");
					llmSelectedSkills = null;
					llmSelectedTools = null;
				}

				// Apply skill selection (even on error — treat as all-included fallback)
				let includedSkillNames: string[];
				let excludedSkillNames: string[];

				if (llmSelectedSkills !== null) {
					// Union LLM selections with pinned/always-keep skills while ensuring
					// the forced-include skills survive the ceiling.
					const forcedSet = new Set(effectivePinned);
					const orderedSelection = [
						...effectivePinned,
						...llmSelectedSkills.filter((name) => !forcedSet.has(name)),
					];
					const ceiling = Math.max(activeConfig.skills.ceiling, effectivePinned.length);
					const finalSet = new Set(orderedSelection.slice(0, ceiling));

					includedSkillNames = visibleSkills.filter((s) => finalSet.has(s.name)).map((s) => s.name);
					excludedSkillNames = visibleSkills.filter((s) => !finalSet.has(s.name)).map((s) => s.name);

					// Per-category fail-open: if no skills survived intersection, keep all
					if (includedSkillNames.length === 0 && visibleSkills.length > 0) {
						includedSkillNames = visibleSkills.map((s) => s.name);
						excludedSkillNames = [];
					}
				} else {
					// Fallback: all included
					includedSkillNames = visibleSkills.map((s) => s.name);
					excludedSkillNames = [];
				}

				// Build new system prompt skills block
				const includedSkills = visibleSkills.filter((s) => includedSkillNames.includes(s.name));
				const newBlock = formatSkillsForPromptImpl(includedSkills);
				const hint = buildHint(excludedSkillNames);
				const replacement = buildReplacement(newBlock, hint);
				const match = event.systemPrompt.match(SKILLS_BLOCK_RE);

				if (!match) {
					console.warn("[skill-pruner] skills block not found in system prompt; skipping pruning");
					recordKnownSkills(sessionId, activeConfig.mode, allSkillPaths, [], []);
					skillResult = null;
				} else {
					const skillModified = event.systemPrompt.replace(SKILLS_BLOCK_RE, replacement);
					const decision = buildDecision({
						sessionId,
						sessionPath,
						mode: activeConfig.mode,
						query: event.prompt,
						contextFilePath: contextFile?.path,
						llmModel: activeConfig.model,
						llmThinkingLevel: prepassThinkingLevel,
						llmResponse: rawResponse,
						llmLatencyMs: latencyMs,
						included: includedSkillNames,
						excluded: excludedSkillNames,
						pinned: effectivePinned,
						newBlock: replacement,
						originalBlock: match[0],
					});
					appendDecision(decision);

					skillResult = {
						included: includedSkillNames,
						excluded: excludedSkillNames,
						tokensSaved: estimateTokens(match[0]) - estimateTokens(replacement),
					};

					if (activeConfig.mode === "shadow") {
						recordKnownSkills(sessionId, "shadow", allSkillPaths, [], excludedSkillNames.map((name) => {
							const s = visibleSkills.find((skill) => skill.name === name);
							return s?.filePath ?? "";
						}).filter(Boolean));
						modifiedSystemPrompt = event.systemPrompt; // shadow: don't modify
					} else {
						recordKnownSkills(sessionId, "auto", allSkillPaths, excludedSkillNames.map((name) => {
							const s = visibleSkills.find((skill) => skill.name === name);
							return s?.filePath ?? "";
						}).filter(Boolean), []);
						modifiedSystemPrompt = skillModified;
						skillPruningRan = true;
					}
				}

				// Apply tool selection
				if (activeConfig.tools && allTools.length > 0) {
					let includedToolNames: string[];
					let excludedToolNames: string[];

					if (llmSelectedTools !== null) {
						const alwaysKeepTools = activeConfig.tools.alwaysKeep ?? [];
						const forcedToolSet = new Set(alwaysKeepTools);
						const orderedTools = [
							...alwaysKeepTools,
							...llmSelectedTools.filter((name) => !forcedToolSet.has(name)),
						];
						const seedTools = orderedTools.slice(0, Math.max(activeConfig.tools.ceiling, alwaysKeepTools.length));

						// Expand dependencies
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

						// Apply ceiling to the seed set, then retain expanded dependencies.
						includedToolNames = [...expanded];
						const includedSet = new Set(includedToolNames);
						excludedToolNames = allTools.map((t) => t.name).filter((name) => !includedSet.has(name));

						// Per-category fail-open: if no tools survived, keep all
						if (includedToolNames.length === 0 && allTools.length > 0) {
							includedToolNames = allTools.map((t) => t.name);
							excludedToolNames = [];
						}
					} else {
						// Fallback: all included
						includedToolNames = allTools.map((t) => t.name);
						excludedToolNames = [];
					}

					if (activeConfig.mode === "auto" && excludedToolNames.length > 0) {
						if (setActiveToolsOverride) {
							setActiveToolsOverride(includedToolNames);
						} else {
							getPiToolSeams().setActiveTools(includedToolNames);
						}
					}

					toolResult = {
						included: includedToolNames,
						excluded: excludedToolNames,
						tokensSaved: estimateToolTokens(allTools, excludedToolNames),
					};
				}
			}
		} else {
			recordKnownSkills(sessionId, activeConfig.mode, allSkillPaths, [], []);
		}

		// --- Build pruning status (integrated into system prompts section) ---
		const feedbackMessage = buildFeedbackMessage(skillResult, toolResult, activeConfig.mode, {
			model: activeConfig.model,
			thinkingLevel: prepassThinkingLevel,
			response: rawResponse,
			thinking: rawThinking,
			systemPrompt: rawSystemPrompt,
			userMessage: rawUserMessage,
			latencyMs,
			error: pruningError,
		});

		if (activeConfig.mode === "shadow") {
			return { systemPrompt: event.systemPrompt, message: feedbackMessage ?? undefined };
		}

		if (skillPruningRan) {
			return { systemPrompt: modifiedSystemPrompt, message: feedbackMessage ?? undefined };
		}
		return feedbackMessage ? { message: feedbackMessage } : undefined;
	});

	pi.on("tool_call", async (event: ToolCallEvent, ctx) => {
		try {
			if (event.toolName !== "read") {
				return undefined;
			}

			const readPath = typeof event.input?.path === "string" ? event.input.path : undefined;
			if (readPath !== undefined) {
				recordSkillRead(getSessionId(ctx), readPath);
			}
		} catch (error) {
			console.warn(`[skill-pruner] failed to record skill read: ${error instanceof Error ? error.message : String(error)}`);
		}
		return undefined;
	});

	pi.on("input", async (_event: InputEvent) => ({ action: "continue" as const }));
}

// --- Internal types for result accumulation ---

interface SkillPruningResult {
	included: string[];
	excluded: string[];
	tokensSaved: number;
}

interface ToolPruningResult {
	included: string[];
	excluded: string[];
	tokensSaved: number;
}

// --- Helper functions ---

/**
 * Returns true when the pie host has disabled the named extension via its
 * settings GUI. Pie publishes the toggle map as JSON in PIE_EXTENSION_TOGGLES_JSON
 * on the in-process backend (see extension/src/shared/protocol.ts).
 *
 * A missing env var or missing entry is treated as enabled (default-on).
 */
function isExtensionDisabledByToggle(extensionId: string): boolean {
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

function clonePruningConfig(input: PruningConfig): PruningConfig {
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

function getConfig(): PruningConfig {
	if (configOverrideForTesting) {
		return clonePruningConfig(configOverrideForTesting);
	}
	return loadConfig(path.join(CONFIG_ROOT, "settings.json"));
}

function getSessionId(ctx: unknown): string {
	const ctxObj = ctx as Record<string, unknown>;
	const sessionManager = ctxObj?.sessionManager as { getSessionId?: () => string } | undefined;
	const sessionId = sessionManager?.getSessionId?.();
	return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : PROCESS_SESSION_ID;
}

function getSessionPath(ctx: unknown): string {
	const ctxObj = ctx as Record<string, unknown>;
	const sessionManager = ctxObj?.sessionManager as { getSessionFile?: () => string | undefined } | undefined;
	const sessionPath = sessionManager?.getSessionFile?.();
	return typeof sessionPath === "string" && sessionPath.length > 0 ? sessionPath : getSessionId(ctx);
}

/** Resolve the completion function — uses test seam or falls back to pi-ai's completeSimple. */
function getCompleteFn(_ctx: unknown): CompleteSimpleFn | null {
	if (completeFnOverride === false) return null;
	if (completeFnOverride) return completeFnOverride;
	// Adapter: converts the flat-message format used by runLlmPruning into the
	// { systemPrompt, messages } format expected by @mariozechner/pi-ai's completeSimple.
	const adapter: CompleteSimpleFn = async (model, context, options) => {
		// Lazy-load @mariozechner/pi-ai (only available at runtime via jiti virtualModules)
		if (_piCompleteSimple === undefined) {
			try {
				const piAi = await import("@mariozechner/pi-ai");
				_piCompleteSimple = piAi.completeSimple;
			} catch {
				_piCompleteSimple = null;
			}
		}
		if (!_piCompleteSimple) {
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

		// Final safety net: ensure Copilot IDE headers are present on the model
		// and in the options before making the API call.  resolveModel and
		// resolveAuth both add these headers, but there are edge cases (e.g.
		// the model object being referenced before patching, or headers being
		// dropped by intermediate transforms) that can cause them to go missing.
		// This last-minute check guarantees the headers are always sent.
		const safeModel = ensureCopilotHeaders(model as Record<string, unknown>);
		const safeOptions = withCopilotOptions(options, model as Record<string, unknown>);

		const result = await _piCompleteSimple(safeModel, piContext, safeOptions);
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

/**
 * Required GitHub Copilot IDE-auth headers.
 * Built-in models include these in model.headers, but custom models from
 * models.json are created with headers=undefined (see model-registry.parseModels).
 * When a custom model replaces a built-in one, the copilot headers are lost,
 * causing the API to reject requests with "missing Editor-Version header for
 * IDE auth".  This constant provides a fallback so the skill-pruner always
 * sends the headers the Copilot API requires.
 */
const COPILOT_IDE_HEADERS: Record<string, string> = {
	"User-Agent": "GitHubCopilotChat/0.35.0",
	"Editor-Version": "vscode/1.107.0",
	"Editor-Plugin-Version": "copilot-chat/0.35.0",
	"Copilot-Integration-Id": "vscode-chat",
};

/**
 * Ensure a model object for the github-copilot provider has the required IDE
 * auth headers.  Custom models from models.json lack these because
 * model-registry.parseModels() sets headers=undefined, so we patch them in.
 * The built-in headers from models.generated.js already include them, so we
 * only add keys that are missing — we never override existing values.
 */
function ensureCopilotHeaders(model: Record<string, unknown>): Record<string, unknown> {
	if (model.provider !== "github-copilot") return model;
	const existing = (model.headers ?? {}) as Record<string, string>;
	let patched = false;
	const merged = { ...existing };
	for (const [key, value] of Object.entries(COPILOT_IDE_HEADERS)) {
		if (!merged[key]) {
			merged[key] = value;
			patched = true;
		}
	}
	if (!patched) return model;
	return { ...model, headers: merged };
}

/** Resolve model from context using config's model/provider. */
function resolveModel(ctx: unknown, _config: PruningConfig): unknown {
	const ctxObj = ctx as Record<string, unknown>;
	const modelRegistry = ctxObj?.modelRegistry as { find?: (provider: string, id: string) => unknown } | undefined;
	if (modelRegistry?.find) {
		const raw = modelRegistry.find(_config.provider, _config.model);
		if (raw && typeof raw === "object") {
			return ensureCopilotHeaders(raw as Record<string, unknown>);
		}
		return raw;
	}
	// When no model registry available (e.g. test context or minimal SDK mode),
	// construct a minimal model object that providers can use.
	if (completeFnOverride) {
		return { id: _config.model, provider: _config.provider, api: "unknown" };
	}
	return undefined;
}

/** Resolve API key and headers from the model registry for a given model. */
async function resolveAuth(ctx: unknown, model: unknown): Promise<{ apiKey?: string; headers?: Record<string, string> }> {
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

	// Auth resolution failed (e.g. no OAuth token). Still provide copilot headers
	// so the request at least reaches the API — it will fail with an auth error
	// rather than the misleading "missing Editor-Version header" error.
	return isCopilot ? { headers: { ...COPILOT_IDE_HEADERS } } : {};
}

/**
 * Ensure github-copilot IDE-auth headers are present in the auth headers.
 * Adds any missing copilot keys without overriding existing values.
 */
function withCopilotHeaders(headers: Record<string, string> | undefined, isCopilot: boolean): Record<string, string> | undefined {
	if (!isCopilot) return headers;
	const merged: Record<string, string> = { ...headers };
	for (const [key, value] of Object.entries(COPILOT_IDE_HEADERS)) {
		if (!merged[key]) merged[key] = value;
	}
	return merged;
}

/**
 * Final safety net: ensure Copilot IDE headers are present in the options
 * object passed to completeSimple.  Unlike withCopilotHeaders (which only
 * operates on a bare headers record), this patches the full options bag so
 * that `options.headers` always carries the IDE-auth headers when the
 * provider is github-copilot.
 */
function withCopilotOptions(
	options: Record<string, unknown>,
	model: Record<string, unknown>,
): Record<string, unknown> {
	if (model.provider !== "github-copilot") return options;
	const existing = { ...(options.headers ?? {}) } as Record<string, string>;
	let changed = false;
	for (const [key, value] of Object.entries(COPILOT_IDE_HEADERS)) {
		if (!existing[key]) {
			existing[key] = value;
			changed = true;
		}
	}
	if (!changed) return options;
	return { ...options, headers: existing };
}

interface PrepassRunResult {
	selectedSkills: string[] | null;
	selectedTools: string[] | null;
	error: string | null;
	rawResponse: string;
	rawThinking: string;
	rawSystemPrompt: string;
	rawUserMessage: string;
	latencyMs: number;
	thinkingLevel: string;
}

function prepassTimeoutMs(thinkingLevel: string): number {
	return LLM_TIMEOUT_MS_BY_THINKING_LEVEL[thinkingLevel] ?? LLM_TIMEOUT_MS_BY_THINKING_LEVEL.minimal;
}

function buildPrepassThinkingAttempts(thinkingLevel: string): string[] {
	if (thinkingLevel === "minimal") {
		return [thinkingLevel];
	}
	return [...new Set([thinkingLevel, "minimal"])];
}

function hasUsablePrepassResponse(result: Awaited<ReturnType<typeof runLlmPruning>>): boolean {
	return result.rawResponse.trim().length > 0;
}

function formatEmptyPrepassError(result: Awaited<ReturnType<typeof runLlmPruning>>): string {
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

async function runPruningPrepass(
	ctx: unknown,
	llmInput: LlmPruningInput,
	activeConfig: PruningConfig,
	completeFn: CompleteSimpleFn,
): Promise<PrepassRunResult> {
	const emptyResult = (thinkingLevel: string, error: string | null): PrepassRunResult => ({
		selectedSkills: null,
		selectedTools: null,
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

/** internal: test seam — overrides the SKILLS block formatter. */
export function __setFormatter(fn: ((skills: Skill[]) => string) | null): void {
	formatSkillsForPromptImpl = fn ?? formatSkillsForPrompt;
}

/** internal: test seam — overrides the LLM completion function. */
export function __setCompleteFn(fn: CompleteSimpleFn | null): void {
	completeFnOverride = fn === null ? false : fn;
}

function buildHint(excludedNames: string[]): string {
	if (excludedNames.length === 0) {
		return "";
	}
	return `<!-- Pruned skills (not shown to save attention): ${excludedNames.join(", ")}. Use /skill:name to load one. -->`;
}

function buildReplacement(newBlock: string, hint: string): string {
	const stripped = newBlock.replace(/^\n\n/, "");
	if (hint === "") {
		return `\n\n${stripped}`;
	}
	return `\n\n${stripped}\n${hint}`;
}

function buildDecision(input: {
	sessionId: string;
	sessionPath: string;
	mode: PruningConfig["mode"];
	query: string;
	contextFilePath?: string;
	llmModel: string;
	llmThinkingLevel: string;
	llmResponse: string;
	llmLatencyMs: number;
	included: string[];
	excluded: string[];
	pinned: string[];
	newBlock: string;
	originalBlock: string;
}): PruningDecision {
	return {
		timestamp: new Date().toISOString(),
		sessionId: input.sessionId,
		sessionPath: input.sessionPath,
		mode: input.mode,
		query: input.query,
		contextFile: input.contextFilePath,
		llmModel: input.llmModel,
		llmThinkingLevel: input.llmThinkingLevel,
		llmResponse: input.llmResponse,
		llmLatencyMs: input.llmLatencyMs,
		pinned: input.pinned,
		included: input.included,
		excluded: input.excluded,
		skillBlockTokens: estimateTokens(input.newBlock),
		originalBlockTokens: estimateTokens(input.originalBlock),
	};
}

/** Estimate tokens saved by excluding tools from the system prompt. */
function estimateToolTokens(allTools: ToolInfo[], excludedToolNames: string[]): number {
	const excludedSet = new Set(excludedToolNames);
	let chars = 0;
	for (const tool of allTools) {
		if (excludedSet.has(tool.name)) {
			chars += tool.name.length + (tool.description?.length ?? 0) + 50;
		}
	}
	return Math.ceil(chars / 4);
}

interface PrepassDiagnostics {
	model: string;
	thinkingLevel: string;
	response: string;
	thinking: string;
	systemPrompt: string;
	userMessage: string;
	latencyMs: number;
	error?: string | null;
}

function buildFeedbackMessage(
	skillResult: SkillPruningResult | null,
	toolResult: ToolPruningResult | null,
	mode: PruningConfig["mode"],
	prepass?: PrepassDiagnostics,
): Pick<PruningResult, "customType" | "content" | "display" | "details"> | null {
	const hasSkillPruning = skillResult && skillResult.excluded.length > 0;
	const hasToolPruning = toolResult && toolResult.excluded.length > 0;

	// Handle error case — always show error to user
	if (prepass?.error) {
		const details: PruningResult & {
			prepassModel?: string;
			prepassThinkingLevel?: string;
			prepassError?: string;
			prepassResponse?: string;
			prepassThinking?: string;
			prepassSystemPrompt?: string;
			prepassUserMessage?: string;
			prepassLatencyMs?: number;
		} = {
			includedSkills: skillResult?.included ?? [],
			excludedSkills: skillResult?.excluded ?? [],
			includedTools: toolResult?.included ?? [],
			excludedTools: toolResult?.excluded ?? [],
			mode,
			skillTokensSaved: 0,
			toolTokensSaved: 0,
			prepassModel: prepass.model,
			prepassThinkingLevel: prepass.thinkingLevel,
			prepassError: prepass.error,
		};
		if (prepass.response) details.prepassResponse = prepass.response;
		if (prepass.thinking) details.prepassThinking = prepass.thinking;
		if (prepass.systemPrompt) details.prepassSystemPrompt = prepass.systemPrompt;
		if (prepass.userMessage) details.prepassUserMessage = prepass.userMessage;
		details.prepassLatencyMs = prepass.latencyMs;
		return {
			customType: "pruning-result",
			content: `Pruning error: ${prepass.error}`,
			display: true,
			details,
		};
	}

	if (!skillResult && !toolResult) {
		return null;
	}

	const parts: string[] = [];
	const details: PruningResult & {
		prepassModel?: string;
		prepassThinkingLevel?: string;
		prepassResponse?: string;
		prepassThinking?: string;
		prepassSystemPrompt?: string;
		prepassUserMessage?: string;
		prepassLatencyMs?: number;
	} = {
		includedSkills: skillResult?.included ?? [],
		excludedSkills: skillResult?.excluded ?? [],
		includedTools: toolResult?.included ?? [],
		excludedTools: toolResult?.excluded ?? [],
		mode,
		skillTokensSaved: skillResult?.tokensSaved ?? 0,
		toolTokensSaved: toolResult?.tokensSaved ?? 0,
	};

	if (prepass) {
		details.prepassModel = prepass.model;
		details.prepassThinkingLevel = prepass.thinkingLevel;
		if (prepass.response) details.prepassResponse = prepass.response;
		if (prepass.thinking) details.prepassThinking = prepass.thinking;
		if (prepass.systemPrompt) details.prepassSystemPrompt = prepass.systemPrompt;
		if (prepass.userMessage) details.prepassUserMessage = prepass.userMessage;
		details.prepassLatencyMs = prepass.latencyMs;
	}

	if (hasSkillPruning) {
		parts.push(`Kept ${skillResult!.included.length}/${skillResult!.included.length + skillResult!.excluded.length} skills`);
	} else if (skillResult) {
		parts.push(`All ${skillResult.included.length} skills kept`);
	}
	if (hasToolPruning) {
		parts.push(`Kept ${toolResult!.included.length}/${toolResult!.included.length + toolResult!.excluded.length} tools`);
	} else if (toolResult) {
		parts.push(`All ${toolResult.included.length} tools kept`);
	}

	const tokensSaved = details.skillTokensSaved + details.toolTokensSaved;
	const tokenNote = tokensSaved > 0 ? ` · Saved ~${tokensSaved} tokens` : "";

	const content = hasSkillPruning || hasToolPruning
		? `Pruned: ${parts.join(", ")}${tokenNote}`
		: `Pruning: ${parts.join(", ")} (nothing removed)`;

	return {
		customType: "pruning-result",
		content,
		display: true,
		details,
	};
}

export function setConfigForTesting(nextConfig: PruningConfig | null): void {
	configOverrideForTesting = nextConfig ? clonePruningConfig(nextConfig) : null;
}

export function resetForTesting(): void {
	configOverrideForTesting = null;
	__setPruningPromptTemplate(null);
	formatSkillsForPromptImpl = formatSkillsForPrompt;
	getAllToolsOverride = null;
	getActiveToolsOverride = null;
	setActiveToolsOverride = null;
	piApi = null;
}

/** Test seam: override tool introspection methods. */
export function __setToolSeams(opts: {
	getAllTools?: (() => ToolInfo[]) | null;
	getActiveTools?: (() => string[]) | null;
	setActiveTools?: ((names: string[]) => void) | null;
}): void {
	getAllToolsOverride = opts.getAllTools ?? null;
	getActiveToolsOverride = opts.getActiveTools ?? null;
	setActiveToolsOverride = opts.setActiveTools ?? null;
}

/** internal: test seam — exposes ensureCopilotHeaders for unit tests. */
export function __ensureCopilotHeaders(model: Record<string, unknown>): Record<string, unknown> {
	return ensureCopilotHeaders(model);
}

/** internal: test seam — exposes COPILOT_IDE_HEADERS for unit tests. */
export const __COPILOT_IDE_HEADERS = COPILOT_IDE_HEADERS;

export { SKILLS_BLOCK_RE, MIN_PROMPT_LENGTH };
