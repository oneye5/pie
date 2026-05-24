import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { PruningConfig, PruningMode, PruningStrategy, ToolPruningConfig } from "./types.js";

/** Root of the pi-config repo, resolved from this extension's known position. */
const CONFIG_ROOT = path.resolve(import.meta.dirname, "..", "..");

export const DEFAULT_TOOL_CONFIG: ToolPruningConfig = {
	strategy: "discretion",
	ceiling: 10,
	dependencies: {
		edit: ["read"],
		subagent: ["bash"],
	},
};

export const DEFAULT_CONFIG: PruningConfig = {
	mode: "auto",
	model: "gpt-5.4-mini",
	provider: "github-copilot",
	thinkingLevel: "minimal",
	skills: {
		strategy: "discretion",
		ceiling: 8,
		pinned: [],
	},
	tools: cloneDefaultToolConfig(),
};

const VALID_MODES = new Set<PruningMode>(["auto", "off", "shadow"]);
const VALID_STRATEGIES = new Set<PruningStrategy>(["discretion", "topK"]);

function cloneDefault(): PruningConfig {
	return {
		mode: DEFAULT_CONFIG.mode,
		model: DEFAULT_CONFIG.model,
		provider: DEFAULT_CONFIG.provider,
		thinkingLevel: DEFAULT_CONFIG.thinkingLevel,
		skills: {
			strategy: DEFAULT_CONFIG.skills.strategy,
			ceiling: DEFAULT_CONFIG.skills.ceiling,
			pinned: [...DEFAULT_CONFIG.skills.pinned],
		},
		tools: cloneDefaultToolConfig(),
	};
}

function cloneDefaultToolConfig(): ToolPruningConfig {
	return {
		strategy: DEFAULT_TOOL_CONFIG.strategy,
		ceiling: DEFAULT_TOOL_CONFIG.ceiling,
		dependencies: Object.fromEntries(
			Object.entries(DEFAULT_TOOL_CONFIG.dependencies).map(([k, v]) => [k, [...v]]),
		),
	};
}

function warn(message: string): void {
	console.warn(`[skill-pruner] ${message}`);
}

export function loadConfig(
	settingsPath = path.join(CONFIG_ROOT, "settings.json"),
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
	const config = cloneDefault();

	// Parse top-level fields
	if (raw.mode !== undefined) {
		if (typeof raw.mode === "string" && VALID_MODES.has(raw.mode as PruningMode)) {
			config.mode = raw.mode as PruningMode;
		} else {
			warn(`invalid pruning.mode '${String(raw.mode)}'; using default '${DEFAULT_CONFIG.mode}'`);
		}
	}

	if (raw.model !== undefined) {
		if (typeof raw.model === "string" && raw.model.length > 0) {
			config.model = raw.model;
		} else {
			warn("invalid pruning.model; using default");
		}
	}

	if (raw.provider !== undefined) {
		if (typeof raw.provider === "string" && raw.provider.length > 0) {
			config.provider = raw.provider;
		} else {
			warn("invalid pruning.provider; using default");
		}
	}

	if (raw.thinkingLevel !== undefined) {
		if (typeof raw.thinkingLevel === "string" && raw.thinkingLevel.length > 0) {
			config.thinkingLevel = raw.thinkingLevel;
		} else {
			warn("invalid pruning.thinkingLevel; using default");
		}
	}

	// Parse skills config
	const rawSkills = raw.skills && typeof raw.skills === "object" ? raw.skills as Record<string, unknown> : {};

	if (rawSkills.strategy !== undefined) {
		if (typeof rawSkills.strategy === "string" && VALID_STRATEGIES.has(rawSkills.strategy as PruningStrategy)) {
			config.skills.strategy = rawSkills.strategy as PruningStrategy;
		} else {
			warn("invalid pruning.skills.strategy; using default");
		}
	}

	if (rawSkills.ceiling !== undefined) {
		if (typeof rawSkills.ceiling === "number" && Number.isInteger(rawSkills.ceiling) && rawSkills.ceiling > 0) {
			config.skills.ceiling = rawSkills.ceiling;
		} else {
			warn("invalid pruning.skills.ceiling; must be a positive integer; using default");
		}
	}

	if (rawSkills.pinned !== undefined) {
		if (Array.isArray(rawSkills.pinned) && rawSkills.pinned.every((value) => typeof value === "string")) {
			config.skills.pinned = [...rawSkills.pinned];
		} else {
			warn("invalid pruning.skills.pinned; using default []");
		}
	}

	// Parse tools config
	if (raw.tools != null && typeof raw.tools === "object") {
		const rawTools = raw.tools as Record<string, unknown>;

		if (rawTools.strategy !== undefined) {
			if (typeof rawTools.strategy === "string" && VALID_STRATEGIES.has(rawTools.strategy as PruningStrategy)) {
				config.tools!.strategy = rawTools.strategy as PruningStrategy;
			} else {
				warn("invalid pruning.tools.strategy; using default");
			}
		}

		if (rawTools.ceiling !== undefined) {
			if (typeof rawTools.ceiling === "number" && Number.isInteger(rawTools.ceiling) && rawTools.ceiling > 0) {
				config.tools!.ceiling = rawTools.ceiling;
			} else {
				warn("invalid pruning.tools.ceiling; must be a positive integer; using default");
			}
		}

		if (rawTools.dependencies && typeof rawTools.dependencies === "object") {
			const userDeps = rawTools.dependencies as Record<string, unknown>;
			const newDependencies: Record<string, string[]> = { ...DEFAULT_TOOL_CONFIG.dependencies };
			for (const [tool, deps] of Object.entries(userDeps)) {
				if (Array.isArray(deps) && deps.every((d) => typeof d === "string")) {
					newDependencies[tool] = deps;
				} else {
					warn(`Invalid dependencies for tool '${tool}'; skipping`);
				}
			}
			config.tools!.dependencies = newDependencies;
		}
	}

	return config;
}
