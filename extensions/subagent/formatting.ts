/**
 * Pure formatting helpers. Extracted from `index.ts` — behaviour-preserving.
 */

import * as os from "node:os";
import type { Message } from "@mariozechner/pi-ai";
import type { DisplayItem } from "./types.js";

export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

export function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

export function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

export function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

export function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

function shortenModelId(id: string): string {
	return id.replace(/:cloud$/, "").replace(/:local$/, "");
}

export function formatSelectionInfo(
	result: {
		taskScores?: Record<string, number>;
		selectedModel?: string;
		selectionPool?: string[];
		selectionFitScores?: number[];
		thinkingLevel?: string;
		failedModel?: string;
		retryCount?: number;
		modelResolutionDiagnostic?: string;
	},
	themeFg: (color: any, text: string) => string,
): string | undefined {
	if (!result.taskScores && !result.selectedModel) return undefined;

	const parts: string[] = [];

	// Task scores: p3 c1 r5 t4
	if (result.taskScores) {
		const s = result.taskScores;
		const dims = [
			s.precision != null ? `p${s.precision}` : null,
			s.creativity != null ? `c${s.creativity}` : null,
			s.reasoning != null ? `r${s.reasoning}` : null,
			s.thoroughness != null ? `t${s.thoroughness}` : null,
		].filter(Boolean);
		if (dims.length > 0) parts.push(themeFg("dim", dims.join(" ")));
	}

	// Thinking level
	if (result.thinkingLevel) {
		parts.push(themeFg("accent", result.thinkingLevel));
	}

	// Selected model with its score
	if (result.selectedModel && result.selectionFitScores && result.selectionPool) {
		const idx = result.selectionPool.indexOf(result.selectedModel);
		const score = idx >= 0 ? result.selectionFitScores[idx] : undefined;
		const shortName = shortenModelId(result.selectedModel);
		const modelStr = score != null ? `${shortName}(${score.toFixed(1)})` : shortName;
		parts.push(themeFg("accent", "→ ") + themeFg("toolTitle", modelStr));

		// Pool (other candidates)
		const others = result.selectionPool
			.filter((m) => m !== result.selectedModel)
			.map((m) => {
				const otherIdx = result.selectionPool!.indexOf(m);
				const otherScore = otherIdx >= 0 ? result.selectionFitScores![otherIdx] : undefined;
				const short = shortenModelId(m);
				return otherScore != null ? `${short}(${otherScore.toFixed(1)})` : short;
			});
		if (others.length > 0) parts.push(themeFg("muted", `| ${others.join(", ")}`));
	}

	// Fallback info: show which model failed and retry count
	if (result.failedModel && result.retryCount) {
		parts.push(themeFg("warning", `fallback #${result.retryCount}`) + themeFg("dim", ` (skipped ${shortenModelId(result.failedModel)})`));
	}

	// Model resolution diagnostic: model-profiles.json override not found in registry
	if (result.modelResolutionDiagnostic) {
		parts.push(themeFg("warning", "⚠ ") + themeFg("dim", result.modelResolutionDiagnostic));
	}

	return parts.length > 0 ? `🎯 ${parts.join(" ")}` : undefined;
}
