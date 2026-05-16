import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { PruningDecision, PruningMode, ScoredSkill } from "./types.js";

interface SessionTracking {
	mode: PruningMode;
	prunedSkillPathsLowercase: Set<string>;
	shadowPrunedPathsLowercase: Set<string>;
	skillNamesByPath: Map<string, string>;
}

type JsonLineEvent = PruningDecision | {
	event: "skill_read" | "skill_miss" | "shadow_miss_candidate";
	skillName: string;
	sessionId: string;
	timestamp: string;
};

const sessionTracking = new Map<string, SessionTracking>();
let logPathOverride: string | null = null;

function getLogPath(): string {
	return logPathOverride ?? path.join(import.meta.dirname, "..", "..", "data", "pruning.jsonl");
}

function normalizeSkillPath(readPath: string): string {
	return readPath.replace(/\\/g, "/").toLowerCase();
}

function appendJsonLine(event: JsonLineEvent): void {
	try {
		const logPath = getLogPath();
		mkdirSync(path.dirname(logPath), { recursive: true });
		appendFileSync(logPath, `${JSON.stringify(event)}\n`, "utf-8");
	} catch (error) {
		console.warn(`[skill-pruner] failed to append pruning log: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export function appendDecision(decision: PruningDecision): PruningDecision {
	appendJsonLine(decision);
	return decision;
}

export function recordPruningOutcome(
	sessionId: string,
	mode: PruningMode,
	prunedSkills: ScoredSkill[],
	shadowPrunedSkills: ScoredSkill[],
): void {
	const tracking: SessionTracking = {
		mode,
		prunedSkillPathsLowercase: new Set(),
		shadowPrunedPathsLowercase: new Set(),
		skillNamesByPath: new Map(),
	};

	for (const skill of prunedSkills) {
		const normalizedPath = normalizeSkillPath(skill.skill.filePath);
		tracking.prunedSkillPathsLowercase.add(normalizedPath);
		tracking.skillNamesByPath.set(normalizedPath, skill.name);
	}

	for (const skill of shadowPrunedSkills) {
		const normalizedPath = normalizeSkillPath(skill.skill.filePath);
		tracking.shadowPrunedPathsLowercase.add(normalizedPath);
		tracking.skillNamesByPath.set(normalizedPath, skill.name);
	}

	sessionTracking.set(sessionId, tracking);
}

export function recordSkillRead(sessionId: string, readPath: string): void {
	const normalizedPath = normalizeSkillPath(readPath);
	const tracking = sessionTracking.get(sessionId);
	const skillName = tracking?.skillNamesByPath.get(normalizedPath) ?? deriveSkillName(readPath);
	const timestamp = new Date().toISOString();

	appendJsonLine({ event: "skill_read", skillName, sessionId, timestamp });

	if (tracking?.mode === "auto" && tracking.prunedSkillPathsLowercase.has(normalizedPath)) {
		appendJsonLine({ event: "skill_miss", skillName, sessionId, timestamp: new Date().toISOString() });
	}

	if (tracking?.mode === "shadow" && tracking.shadowPrunedPathsLowercase.has(normalizedPath)) {
		appendJsonLine({ event: "shadow_miss_candidate", skillName, sessionId, timestamp: new Date().toISOString() });
	}
}

export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

function deriveSkillName(readPath: string): string {
	const normalized = readPath.replace(/\\/g, "/");
	const parts = normalized.split("/").filter(Boolean);
	const last = parts.at(-1) ?? "unknown";
	if (last.toLowerCase() === "skill.md" && parts.length >= 2) {
		return parts[parts.length - 2];
	}
	return last.replace(/\.md$/i, "") || "unknown";
}

export function setLogPathForTesting(logPath: string | null): void {
	logPathOverride = logPath;
}

export function clearPruningTrackingForTesting(): void {
	sessionTracking.clear();
}
