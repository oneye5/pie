import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
	Skill,
	ExtensionAPI,
	BeforeAgentStartEvent,
	ToolCallEvent,
	InputEvent,
} from "@mariozechner/pi-coding-agent";
import { DEFAULT_CONFIG, loadConfig } from "./config.js";
import { applyThreshold, scoreSkills } from "./scorer.js";
import { appendDecision, estimateTokens, recordPruningOutcome, recordSkillRead } from "./logger.js";
import type { PruningConfig, PruningDecision, SkillScoreCacheEntry } from "./types.js";

const SKILLS_BLOCK_RE = /\n\nThe following skills provide specialized instructions for specific tasks\.[\s\S]*?<\/available_skills>/;
const PROCESS_SESSION_ID = randomUUID();

let config: PruningConfig | null = null;
const skillCache = new Map<string, SkillScoreCacheEntry>();
let formatSkillsForPromptImpl: ((skills: Skill[]) => string) | null = null;

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event: BeforeAgentStartEvent, ctx) => {
		const activeConfig = getConfig();
		const sessionId = getSessionId(ctx);
		const skills = event.systemPromptOptions.skills ?? [];

		if (activeConfig.mode === "off") {
			recordPruningOutcome(sessionId, "off", [], []);
			return undefined;
		}

		if (skills.length === 0) {
			recordPruningOutcome(sessionId, activeConfig.mode, [], []);
			return undefined;
		}

		const contextFile = event.systemPromptOptions.contextFiles?.[0];
		const scored = scoreSkills(event.prompt, contextFile?.content ?? "", skills, activeConfig, skillCache);
		const thresholded = applyThreshold(scored, activeConfig.skills.pinned, activeConfig);
		const includedSkills = thresholded.included.map((scoredSkill) => scoredSkill.skill);
		const newBlock = await formatSkillsForPromptCompat(includedSkills);
		const hint = buildHint(thresholded.excluded.map((skill) => skill.name));
		const replacement = buildReplacement(newBlock, hint);
		const match = event.systemPrompt.match(SKILLS_BLOCK_RE);
		const modified = event.systemPrompt.replace(SKILLS_BLOCK_RE, replacement);

		if (modified === event.systemPrompt) {
			console.warn("[skill-pruner] skills block not found in system prompt; skipping pruning");
			recordPruningOutcome(sessionId, activeConfig.mode, [], []);
			return undefined;
		}

		const decision = buildDecision({
			sessionId,
			mode: activeConfig.mode,
			query: event.prompt,
			contextFilePath: contextFile?.path,
			scored,
			included: thresholded.included,
			excluded: thresholded.excluded,
			newBlock: replacement,
			originalBlock: match?.[0] ?? "",
			pinned: activeConfig.skills.pinned,
		});
		appendDecision(decision);

		if (activeConfig.mode === "shadow") {
			recordPruningOutcome(sessionId, "shadow", [], thresholded.excluded);
			return { systemPrompt: event.systemPrompt };
		}

		recordPruningOutcome(sessionId, "auto", thresholded.excluded, []);
		return { systemPrompt: modified };
	});

	pi.on("tool_call", async (event: ToolCallEvent, ctx) => {
		try {
			if (event.toolName !== "read") {
				return undefined;
			}

			const input = event.input as Record<string, unknown>;
			const readPath = input.path ?? input.file_path;
			if (typeof readPath === "string") {
				recordSkillRead(getSessionId(ctx), readPath);
			}
		} catch (error) {
			console.warn(`[skill-pruner] failed to record skill read: ${error instanceof Error ? error.message : String(error)}`);
		}
		return undefined;
	});

	pi.on("input", async (_event: InputEvent) => ({ action: "continue" as const }));
}

function getConfig(): PruningConfig {
	if (!config) {
		config = loadConfig(path.join(import.meta.dirname, "..", "..", "settings.json"));
	}
	return config;
}

function getSessionId(ctx: unknown): string {
	const sessionId = (ctx as { sessionId?: unknown })?.sessionId;
	return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : PROCESS_SESSION_ID;
}

async function formatSkillsForPromptCompat(skills: Skill[]): Promise<string> {
	if (!formatSkillsForPromptImpl) {
		try {
			const sdk = await import("@mariozechner/pi-coding-agent") as { formatSkillsForPrompt?: (skills: Skill[]) => string };
			formatSkillsForPromptImpl = sdk.formatSkillsForPrompt ?? localFormatSkillsForPrompt;
		} catch {
			formatSkillsForPromptImpl = localFormatSkillsForPrompt;
		}
	}
	return formatSkillsForPromptImpl(skills);
}

function localFormatSkillsForPrompt(skills: Skill[]): string {
	const visibleSkills = skills.filter((skill) => !skill.disableModelInvocation);
	if (visibleSkills.length === 0) {
		return "";
	}

	const lines = [
		"\n\nThe following skills provide specialized instructions for specific tasks.",
		"Use the read tool to load a skill's file when the task matches its description.",
		"When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
		"",
		"<available_skills>",
	];

	for (const skill of visibleSkills) {
		lines.push("  <skill>");
		lines.push(`    <name>${escapeXml(skill.name)}</name>`);
		lines.push(`    <description>${escapeXml(skill.description)}</description>`);
		lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
		lines.push("  </skill>");
	}

	lines.push("</available_skills>");
	return lines.join("\n");
}

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/\"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

function buildHint(excludedNames: string[]): string {
	if (excludedNames.length === 0) {
		return "";
	}
	return `<!-- Pruned skills (not shown to save attention): ${excludedNames.join(", ")}. Use /skill:name to load one. -->`;
}

function buildReplacement(newBlock: string, hint: string): string {
	const stripped = newBlock.replace(/^\n\n/, "");
	return `\n\n${stripped}\n${hint}`;
}

function buildDecision(input: {
	sessionId: string;
	mode: PruningConfig["mode"];
	query: string;
	contextFilePath?: string;
	scored: ReturnType<typeof scoreSkills>;
	included: ReturnType<typeof applyThreshold>["included"];
	excluded: ReturnType<typeof applyThreshold>["excluded"];
	newBlock: string;
	originalBlock: string;
	pinned: string[];
}): PruningDecision {
	const includedNames = new Set(input.included.map((skill) => skill.name));
	const pinnedNames = new Set(input.included.filter((skill) => skill.pinned).map((skill) => skill.name));
	return {
		timestamp: new Date().toISOString(),
		sessionId: input.sessionId,
		mode: input.mode,
		query: input.query,
		contextFile: input.contextFilePath,
		candidates: input.scored.map((skill) => ({
			name: skill.name,
			triggerScore: skill.triggerScore,
			keywordScore: skill.keywordScore,
			nameScore: skill.nameScore,
			compositeScore: skill.compositeScore,
			included: includedNames.has(skill.name),
			pinned: pinnedNames.has(skill.name) || undefined,
		})),
		pinned: input.pinned,
		included: input.included.map((skill) => skill.name),
		excluded: input.excluded.map((skill) => skill.name),
		skillBlockTokens: estimateTokens(input.newBlock),
		originalBlockTokens: estimateTokens(input.originalBlock),
	};
}

export function setConfigForTesting(nextConfig: PruningConfig | null): void {
	config = nextConfig ? {
		mode: nextConfig.mode,
		skills: { ...nextConfig.skills, pinned: [...nextConfig.skills.pinned] },
	} : null;
}

export function resetForTesting(): void {
	config = { mode: DEFAULT_CONFIG.mode, skills: { ...DEFAULT_CONFIG.skills, pinned: [] } };
	skillCache.clear();
	formatSkillsForPromptImpl = null;
}

export { SKILLS_BLOCK_RE };
