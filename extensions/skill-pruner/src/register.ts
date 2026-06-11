import path from "node:path";
import { writeFileSync } from "node:fs";
import type { ExtensionAPI, BeforeAgentStartEvent, ToolCallEvent, InputEvent } from "@mariozechner/pi-coding-agent";
import { appendDecision, estimateTokens, recordSkillRead, recordKnownSkills } from "../logger.js";
import {
	setPiApi,
	CONFIG_ROOT,
	getFormatSkillsForPromptImpl,
	getPiToolSeams,
	state,
} from "./state.js";
import { requestToolDefinition } from "./tools.js";
import { pruningResultRenderer } from "./render.js";
import {
	shouldSkipPruning,
	resolveVisibleSkills,
	applySkillSelection,
	applyToolSelection,
	getSessionId,
	getSessionPath,
	getCompleteFn,
	getConfig,
	SKILLS_BLOCK_RE,
	runPruningPrepass,
	SkillPruningResult,
	ToolPruningResult,
	buildHint,
	buildReplacement,
	buildDecision,
	buildFeedbackMessage,
	estimateToolTokens,
} from "./pruning.js";

export default function register(pi: ExtensionAPI) {
	// DIAGNOSTIC: prove extension loads
	try {
		writeFileSync(path.join(CONFIG_ROOT, "data", "skill-pruner-loaded.txt"), `loaded at ${new Date().toISOString()}\n`);
	} catch { /* ignore */ }

	// Capture pi API methods for tool introspection (available throughout the session).
	setPiApi({
		getAllTools: () => pi.getAllTools(),
		getActiveTools: () => pi.getActiveTools(),
		setActiveTools: (names) => pi.setActiveTools(names),
	});

	// --- Message renderer for pruning-result custom type ---
	pi.registerMessageRenderer("pruning-result", (message, { expanded }, theme) => {
		return pruningResultRenderer.render(message, { expanded }, theme);
	});

	// --- request_tool: recovery tool for pruned tools ---
	pi.registerTool(requestToolDefinition);

	// --- before_agent_start: skill + tool pruning ---
	pi.on("before_agent_start", async (event: BeforeAgentStartEvent, ctx) => {
		// DIAGNOSTIC: prove hook fires
		try {
			writeFileSync(path.join(CONFIG_ROOT, "data", "skill-pruner-hook-fired.txt"), `hook at ${new Date().toISOString()}\n`);
		} catch { /* ignore */ }

		const activeConfig = getConfig();
		const skipInfo = shouldSkipPruning(event, activeConfig);
		if (skipInfo.skip && skipInfo.reason === "disabled-by-toggle") {
			return undefined;
		}

		const sessionId = getSessionId(ctx);
		const skills = event.systemPromptOptions.skills ?? [];
		const allSkillPaths = skills.map((s) => s.filePath);

		if (skipInfo.skip) {
			recordKnownSkills(sessionId, activeConfig.mode, allSkillPaths, [], []);
			return undefined;
		}

		const sessionPath = getSessionPath(ctx);
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
		let skillFailOpenReason: string | undefined;
		let toolFailOpenReason: string | undefined;

		const allTools = state.getAllToolsOverride
			? state.getAllToolsOverride()
			: getPiToolSeams().getAllTools();
		const hasToolsConfig = activeConfig.tools && allTools.length > 0;

		if (skills.length > 0 || hasToolsConfig) {
			const { visibleSkills, effectivePinned } = resolveVisibleSkills(skills, activeConfig);
			const contextFile = event.systemPromptOptions.contextFiles?.[0];

			const llmInput = {
				userPrompt: event.prompt,
				contextFile: contextFile?.path,
				skills: visibleSkills.map((s) => ({ name: s.name, description: s.description })),
				tools: allTools.map((t) => ({ name: t.name, description: t.description ?? "" })),
				config: activeConfig,
				forcedSkills: effectivePinned,
				forcedTools: activeConfig.tools?.alwaysKeep ?? [],
			};

			let llmSelectedSkills: string[] | null = null;
			let llmSelectedTools: string[] | null = null;
			let skillsExplicitlyEmpty = false;
			let toolsExplicitlyEmpty = false;

			const completeFn = getCompleteFn(ctx);
			if (!completeFn) {
				pruningError = "No completion function available";
				recordKnownSkills(sessionId, activeConfig.mode, allSkillPaths, [], []);
			} else {
				const prepassResult = await runPruningPrepass(ctx, llmInput, activeConfig, completeFn);
				llmSelectedSkills = prepassResult.selectedSkills;
				llmSelectedTools = prepassResult.selectedTools;
				skillsExplicitlyEmpty = prepassResult.skillsExplicitlyEmpty ?? false;
				toolsExplicitlyEmpty = prepassResult.toolsExplicitlyEmpty ?? false;
				pruningError = prepassResult.error;
				rawResponse = prepassResult.rawResponse;
				rawThinking = prepassResult.rawThinking;
				rawSystemPrompt = prepassResult.rawSystemPrompt;
				rawUserMessage = prepassResult.rawUserMessage;
				prepassThinkingLevel = prepassResult.thinkingLevel;
				latencyMs = prepassResult.latencyMs;
			}

			if (!pruningError || pruningError.startsWith("Model") || pruningError.startsWith("LLM pruning failed")) {
				if (llmSelectedSkills !== null && llmSelectedSkills.length === 0 &&
					llmSelectedTools !== null && llmSelectedTools.length === 0 &&
					skillsExplicitlyEmpty && toolsExplicitlyEmpty) {
					llmSelectedSkills = null;
					llmSelectedTools = null;
					skillFailOpenReason = "LLM explicitly returned empty selections for both skills and tools; keeping all as fail-open";
					toolFailOpenReason = "LLM explicitly returned empty selections for both skills and tools; keeping all as fail-open";
				}

				const skillSelection = applySkillSelection(visibleSkills, llmSelectedSkills, effectivePinned, activeConfig, skillsExplicitlyEmpty);
				skillFailOpenReason = skillSelection.failOpenReason ?? skillFailOpenReason;

				const toolSelection = applyToolSelection(allTools, llmSelectedTools, activeConfig, toolsExplicitlyEmpty);
				toolFailOpenReason = toolSelection.failOpenReason ?? toolFailOpenReason;

				const match = event.systemPrompt.match(SKILLS_BLOCK_RE);
				if (match) {
					const includedSkills = visibleSkills.filter((s) => skillSelection.includedSkillNames.includes(s.name));
					const replacement = buildReplacement(getFormatSkillsForPromptImpl()(includedSkills), buildHint(skillSelection.excludedSkillNames));
					const decision = buildDecision({
						sessionId, sessionPath, mode: activeConfig.mode, query: event.prompt,
						contextFilePath: contextFile?.path, llmModel: activeConfig.model,
						llmThinkingLevel: prepassThinkingLevel, llmResponse: rawResponse, llmLatencyMs: latencyMs,
						included: skillSelection.includedSkillNames, excluded: skillSelection.excludedSkillNames,
						pinned: effectivePinned, newBlock: replacement, originalBlock: match[0],
					});
					appendDecision(decision);

					skillResult = {
						included: skillSelection.includedSkillNames,
						excluded: skillSelection.excludedSkillNames,
						tokensSaved: estimateTokens(match[0]) - estimateTokens(replacement),
					};

					const excludedSkillPaths = skillSelection.excludedSkillNames.map((name) => visibleSkills.find((skill) => skill.name === name)?.filePath).filter(Boolean) as string[];
					if (activeConfig.mode === "shadow") {
						recordKnownSkills(sessionId, "shadow", allSkillPaths, [], excludedSkillPaths);
					} else {
						recordKnownSkills(sessionId, "auto", allSkillPaths, excludedSkillPaths, []);
						modifiedSystemPrompt = event.systemPrompt.replace(SKILLS_BLOCK_RE, replacement);
						skillPruningRan = true;
					}
				} else if (skills.length > 0) {
					console.warn("[skill-pruner] skills block not found in system prompt; skipping pruning");
					recordKnownSkills(sessionId, activeConfig.mode, allSkillPaths, [], []);
				}

				if (activeConfig.tools && allTools.length > 0) {
					if (activeConfig.mode === "auto" && toolSelection.excludedToolNames.length > 0) {
						if (state.setActiveToolsOverride) {
							state.setActiveToolsOverride(toolSelection.includedToolNames);
						} else {
							getPiToolSeams().setActiveTools(toolSelection.includedToolNames);
						}
					}
					toolResult = {
						included: toolSelection.includedToolNames,
						excluded: toolSelection.excludedToolNames,
						tokensSaved: estimateToolTokens(allTools, toolSelection.excludedToolNames),
					};
				}
			}
		} else {
			recordKnownSkills(sessionId, activeConfig.mode, allSkillPaths, [], []);
		}

		const failOpenReason = (skillFailOpenReason && toolFailOpenReason)
			? `${skillFailOpenReason} · ${toolFailOpenReason}`
			: (skillFailOpenReason ?? toolFailOpenReason ?? undefined);

		const feedbackMessage = buildFeedbackMessage(skillResult, toolResult, activeConfig.mode, {
			model: activeConfig.model,
			thinkingLevel: prepassThinkingLevel,
			response: rawResponse,
			thinking: rawThinking,
			systemPrompt: rawSystemPrompt,
			userMessage: rawUserMessage,
			latencyMs,
			error: pruningError,
			failOpenReason,
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
