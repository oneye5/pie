import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { PruningConfig, PruningMode } from "./types.js";

export const DEFAULT_CONFIG: PruningConfig = {
	mode: "auto",
	skills: {
		ceiling: 5,
		floor: 2,
		scoreThreshold: 0.4,
		gapThreshold: 0.3,
		pinned: [],
	},
};

const VALID_MODES = new Set<PruningMode>(["auto", "off", "shadow"]);

function cloneDefault(): PruningConfig {
	return {
		mode: DEFAULT_CONFIG.mode,
		skills: {
			ceiling: DEFAULT_CONFIG.skills.ceiling,
			floor: DEFAULT_CONFIG.skills.floor,
			scoreThreshold: DEFAULT_CONFIG.skills.scoreThreshold,
			gapThreshold: DEFAULT_CONFIG.skills.gapThreshold,
			pinned: [...DEFAULT_CONFIG.skills.pinned],
		},
	};
}

function warn(message: string): void {
	console.warn(`[skill-pruner] ${message}`);
}

export function loadConfig(
	settingsPath = path.join(import.meta.dirname, "..", "..", "settings.json"),
): PruningConfig {
	if (!existsSync(settingsPath)) {
		warn(`settings.json not found at ${settingsPath}; using pruning defaults`);
		return cloneDefault();
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
	} catch (error) {
		warn(`failed to parse settings.json at ${settingsPath}; using pruning defaults: ${error instanceof Error ? error.message : String(error)}`);
		return cloneDefault();
	}

	if (!parsed || typeof parsed !== "object" || !("pruning" in parsed)) {
		return cloneDefault();
	}

	const pruning = (parsed as { pruning?: unknown }).pruning;
	if (!pruning || typeof pruning !== "object") {
		warn("settings.pruning must be an object; using pruning defaults");
		return cloneDefault();
	}

	const raw = pruning as Record<string, unknown>;
	const rawSkills = raw.skills && typeof raw.skills === "object" ? raw.skills as Record<string, unknown> : {};
	const config = cloneDefault();

	if (raw.mode !== undefined) {
		if (typeof raw.mode === "string" && VALID_MODES.has(raw.mode as PruningMode)) {
			config.mode = raw.mode as PruningMode;
		} else {
			warn(`invalid pruning.mode '${String(raw.mode)}'; using default '${DEFAULT_CONFIG.mode}'`);
		}
	}

	const ceiling = rawSkills.ceiling ?? config.skills.ceiling;
	const floor = rawSkills.floor ?? config.skills.floor;
	if (rawSkills.ceiling !== undefined || rawSkills.floor !== undefined) {
		if (
			typeof ceiling === "number" &&
			Number.isFinite(ceiling) &&
			Number.isInteger(ceiling) &&
			typeof floor === "number" &&
			Number.isFinite(floor) &&
			Number.isInteger(floor) &&
			ceiling >= floor &&
			floor >= 1
		) {
			config.skills.ceiling = ceiling;
			config.skills.floor = floor;
		} else {
			warn("invalid pruning.skills ceiling/floor; using default ceiling and floor");
		}
	}

	if (rawSkills.scoreThreshold !== undefined) {
		if (typeof rawSkills.scoreThreshold === "number" && rawSkills.scoreThreshold >= 0 && rawSkills.scoreThreshold <= 1) {
			config.skills.scoreThreshold = rawSkills.scoreThreshold;
		} else {
			warn("invalid pruning.skills.scoreThreshold; using default");
		}
	}

	if (rawSkills.gapThreshold !== undefined) {
		if (typeof rawSkills.gapThreshold === "number" && rawSkills.gapThreshold >= 0 && rawSkills.gapThreshold <= 1) {
			config.skills.gapThreshold = rawSkills.gapThreshold;
		} else {
			warn("invalid pruning.skills.gapThreshold; using default");
		}
	}

	if (rawSkills.pinned !== undefined) {
		if (Array.isArray(rawSkills.pinned) && rawSkills.pinned.every((value) => typeof value === "string")) {
			config.skills.pinned = [...rawSkills.pinned];
		} else {
			warn("invalid pruning.skills.pinned; using default []");
		}
	}

	return config;
}
