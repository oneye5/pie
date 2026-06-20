import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { PruningDecision, PruningMode } from "./types.js";
import { countTokens } from "./tokenize.js";

/** Root of the pi-config repo, resolved from this extension's known position. */
const CONFIG_ROOT = path.resolve(import.meta.dirname, "..", "..");

interface SessionTracking {
	mode: PruningMode;
	knownSkillPathsLowercase: Set<string>;
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
	return logPathOverride ?? path.join(CONFIG_ROOT, "data", "pruning.jsonl");
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

export function recordKnownSkills(
	sessionId: string,
	mode: PruningMode,
	allSkillPaths: string[],
	prunedPaths: string[],
	shadowPrunedPaths: string[],
): void {
	const tracking: SessionTracking = {
		mode,
		knownSkillPathsLowercase: new Set(),
		prunedSkillPathsLowercase: new Set(),
		shadowPrunedPathsLowercase: new Set(),
		skillNamesByPath: new Map(),
	};

	for (const skillPath of allSkillPaths) {
		const normalizedPath = normalizeSkillPath(skillPath);
		tracking.knownSkillPathsLowercase.add(normalizedPath);
		tracking.skillNamesByPath.set(normalizedPath, deriveSkillName(skillPath));
	}

	for (const skillPath of prunedPaths) {
		tracking.prunedSkillPathsLowercase.add(normalizeSkillPath(skillPath));
	}

	for (const skillPath of shadowPrunedPaths) {
		tracking.shadowPrunedPathsLowercase.add(normalizeSkillPath(skillPath));
	}

	sessionTracking.set(sessionId, tracking);
}

export function recordSkillRead(sessionId: string, readPath: string): void {
	const normalizedPath = normalizeSkillPath(readPath);
	const tracking = sessionTracking.get(sessionId);

	// Only fire events when the path is a known skill path.
	if (!tracking?.knownSkillPathsLowercase.has(normalizedPath)) {
		return;
	}

	const skillName = tracking.skillNamesByPath.get(normalizedPath) ?? deriveSkillName(readPath);
	const timestamp = new Date().toISOString();

	if (tracking.mode === "auto" && tracking.prunedSkillPathsLowercase.has(normalizedPath)) {
		appendJsonLine({ event: "skill_miss", skillName, sessionId, timestamp });
	} else if (tracking.mode === "shadow" && tracking.shadowPrunedPathsLowercase.has(normalizedPath)) {
		appendJsonLine({ event: "shadow_miss_candidate", skillName, sessionId, timestamp });
	} else {
		appendJsonLine({ event: "skill_read", skillName, sessionId, timestamp });
	}
}

export function estimateTokens(text: string): number {
	return countTokens(text);
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
