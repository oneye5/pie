/**
 * Pure builders for the strings and records that the skill-pruner emits
 * back into the agent (PruningResult, PruningDecision, feedback message,
 * prompt-block replacement, etc.).
 *
 * These helpers take already-resolved data and produce immutable values
 * with no side effects. Keeping them separate from `pruning.ts` makes
 * the orchestrator easier to read and lets tests target the
 * "shape of output" without standing up the full prepass flow.
 */

import type { ToolInfo } from "@mariozechner/pi-coding-agent";

import { estimateTokens } from "../logger.js";
import { countTokens } from "../tokenize.js";
import type { PruningConfig, PruningDecision, PruningResult } from "../types.js";

import type { SkillPruningResult, ToolPruningResult } from "./pruning-types.js";

export interface PrepassDiagnostics {
	model: string;
	thinkingLevel: string;
	response: string;
	thinking: string;
	systemPrompt: string;
	userMessage: string;
	latencyMs: number;
	error?: string | null;
	failOpenReason?: string | null;
}

/** Display shape returned from `buildFeedbackMessage`. */
export interface PruningFeedbackMessage {
	customType: "pruning-result";
	content: string;
	display: boolean;
	details: PruningResult;
}

/**
 * Compose the final PruningResult envelope plus optional audit decision.
 */
export function buildPruningPayload(
	skillResult: SkillPruningResult | null,
	toolResult: ToolPruningResult | null,
	activeConfig: PruningConfig,
	pruningError: string | null,
	latencyMs: number,
	prepassThinkingLevel: string,
	rawResponse: string,
	rawThinking: string,
	rawSystemPrompt: string,
	rawUserMessage: string,
	skillFailOpenReason?: string | null,
	toolFailOpenReason?: string | null,
	_excludedSkillPaths?: string[],
	_includedSkillPaths?: string[],
): { result: PruningResult; decision?: PruningDecision } {
	const failOpenReason = (skillFailOpenReason && toolFailOpenReason)
		? `${skillFailOpenReason} · ${toolFailOpenReason}`
		: (skillFailOpenReason ?? toolFailOpenReason ?? undefined);

	const result: PruningResult = {
		includedSkills: skillResult?.included ?? [],
		excludedSkills: skillResult?.excluded ?? [],
		includedTools: toolResult?.included ?? [],
		excludedTools: toolResult?.excluded ?? [],
		mode: activeConfig.mode,
		skillTokensSaved: skillResult?.tokensSaved ?? 0,
		toolTokensSaved: toolResult?.tokensSaved ?? 0,
		prepassModel: activeConfig.model,
		prepassThinkingLevel: prepassThinkingLevel,
		prepassResponse: rawResponse || undefined,
		prepassThinking: rawThinking || undefined,
		prepassSystemPrompt: rawSystemPrompt || undefined,
		prepassUserMessage: rawUserMessage || undefined,
		prepassLatencyMs: latencyMs,
		prepassError: pruningError || undefined,
		prepassFailOpenReason: failOpenReason,
	};

	return { result };
}

/** HTML-comment hint that names which skills the pruner removed. */
export function buildHint(excludedNames: string[]): string {
	if (excludedNames.length === 0) {
		return "";
	}
	return `<!-- Pruned skills (not shown to save attention): ${excludedNames.join(", ")}. Use /skill:name to load one. -->`;
}

/**
 * Strip a single leading blank line, then re-prefix with two newlines so
 * the new skill block slots cleanly into the surrounding system prompt.
 * The hint is appended when present.
 */
export function buildReplacement(newBlock: string, hint: string): string {
	const stripped = newBlock.replace(/^\n\n/, "");
	if (hint === "") {
		return `\n\n${stripped}`;
	}
	return `\n\n${stripped}\n${hint}`;
}

/**
 * Capture a PruningDecision for the audit log. Token counts come from the
 * real cl100k_base BPE tokenizer shared with the logger (chars/4 fallback
 * only when the tokenizer cannot be resolved in the current runtime).
 */
export function buildDecision(input: {
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

/** Per-tool JSON framing overhead (name + description wrapper): ~50 chars ≈ 13 tokens. */
const TOOL_FRAMING_TOKENS = 13;

/**
 * Token count for tool descriptions that the pruner suppressed, used for
 * "tokens saved" reporting. Counts name + description via the real BPE
 * tokenizer plus a small per-tool framing constant for the JSON wrapper.
 */
export function estimateToolTokens(allTools: ToolInfo[], excludedToolNames: string[]): number {
	const excludedSet = new Set(excludedToolNames);
	let tokens = 0;
	for (const tool of allTools) {
		if (excludedSet.has(tool.name)) {
			tokens += countTokens(tool.name) + countTokens(tool.description ?? "") + TOOL_FRAMING_TOKENS;
		}
	}
	return tokens;
}

/**
 * Compose the chat-message payload that surfaces pruning activity to
 * the user. Returns `null` when there's nothing to show. When the
 * prepass errored, the message surfaces the error verbatim.
 */
export function buildFeedbackMessage(
	skillResult: SkillPruningResult | null,
	toolResult: ToolPruningResult | null,
	mode: PruningConfig["mode"],
	prepass?: PrepassDiagnostics,
): PruningFeedbackMessage | null {
	if (prepass?.error) {
		const details: PruningResult = {
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

	const details: PruningResult = {
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
		if (prepass.failOpenReason) details.prepassFailOpenReason = prepass.failOpenReason;
	}

	const hasSkillPruning = !!skillResult && skillResult.excluded.length > 0;
	const hasToolPruning = !!toolResult && toolResult.excluded.length > 0;

	const parts: string[] = [];
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
		? `${parts.join(", ")}${tokenNote}`
		: `Pruning: ${parts.join(", ")} (nothing removed)`;

	return {
		customType: "pruning-result",
		content,
		display: true,
		details,
	};
}
