import type { PruningResult } from "../types.js";
import { Box, Text } from "@mariozechner/pi-tui";

export const pruningResultRenderer = {
	messageType: "pruning-result" as const,
	render: (message: { content: string; details?: unknown }, { expanded }: { expanded: boolean }, theme: {
		bg: (key: string, child: unknown) => unknown;
		fg: (key: string, text: string) => string;
	}) => {
		const details = message.details as PruningResult | undefined;
		if (!details) {
			const box = new Box(1, 1, (t: unknown) => theme.bg("customMessageBg", t));
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
			const compact = `${modeLabel}${parts.join(", ")}${tokenNote}`;
			const box = new Box(1, 1, (t: unknown) => theme.bg("customMessageBg", t));
			box.addChild(new Text(compact, 0, 0));
			return box;
		}

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

		const box = new Box(1, 1, (t: unknown) => theme.bg("customMessageBg", t));
		box.addChild(new Text(`${modeLabel}Pruning Results\n${lines.join("\n")}`, 0, 0));
		return box;
	},
};
