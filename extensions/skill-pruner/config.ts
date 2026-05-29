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
	alwaysKeep: [],
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
		alwaysKeep: [],
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
			alwaysKeep: [...DEFAULT_CONFIG.skills.alwaysKeep],
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
		alwaysKeep: [...DEFAULT_TOOL_CONFIG.alwaysKeep],
	};
}

function warn(message: string): void {
	console.warn(`[skill-pruner] ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object";
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function assignEnumValue<T extends string>(
	value: unknown,
	allowed: Set<T>,
	assign: (next: T) => void,
	invalidMessage: string,
): void {
	if (value === undefined) {
		return;
	}
	if (typeof value === "string" && allowed.has(value as T)) {
		assign(value as T);
		return;
	}
	warn(invalidMessage);
}

function assignNonEmptyString(
	value: unknown,
	assign: (next: string) => void,
	invalidMessage: string,
): void {
	if (value === undefined) {
		return;
	}
	if (isNonEmptyString(value)) {
		assign(value);
		return;
	}
	warn(invalidMessage);
}

function assignPositiveInteger(
	value: unknown,
	assign: (next: number) => void,
	invalidMessage: string,
): void {
	if (value === undefined) {
		return;
	}
	if (isPositiveInteger(value)) {
		assign(value);
		return;
	}
	warn(invalidMessage);
}

function assignStringArray(
	value: unknown,
	assign: (next: string[]) => void,
	invalidMessage: string,
): void {
	if (value === undefined) {
		return;
	}
	if (isStringArray(value)) {
		assign([...value]);
		return;
	}
	warn(invalidMessage);
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

	if (!isRecord(parsed) || !("pruning" in parsed)) {
		return cloneDefault();
	}

	const pruning = parsed.pruning;
	if (!isRecord(pruning)) {
		warn("settings.pruning must be an object; using pruning defaults");
		return cloneDefault();
	}

	const raw = pruning;
	const config = cloneDefault();

	// Parse top-level fields
	assignEnumValue(
		raw.mode,
		VALID_MODES,
		(value) => {
			config.mode = value;
		},
		`invalid pruning.mode '${String(raw.mode)}'; using default '${DEFAULT_CONFIG.mode}'`,
	);

	assignNonEmptyString(
		raw.model,
		(value) => {
			config.model = value;
		},
		"invalid pruning.model; using default",
	);

	assignNonEmptyString(
		raw.provider,
		(value) => {
			config.provider = value;
		},
		"invalid pruning.provider; using default",
	);

	assignNonEmptyString(
		raw.thinkingLevel,
		(value) => {
			config.thinkingLevel = value;
		},
		"invalid pruning.thinkingLevel; using default",
	);

	// Parse skills config
	const rawSkills = isRecord(raw.skills) ? raw.skills : {};

	assignEnumValue(
		rawSkills.strategy,
		VALID_STRATEGIES,
		(value) => {
			config.skills.strategy = value;
		},
		"invalid pruning.skills.strategy; using default",
	);

	assignPositiveInteger(
		rawSkills.ceiling,
		(value) => {
			config.skills.ceiling = value;
		},
		"invalid pruning.skills.ceiling; must be a positive integer; using default",
	);

	assignStringArray(
		rawSkills.pinned,
		(value) => {
			config.skills.pinned = value;
		},
		"invalid pruning.skills.pinned; using default []",
	);

	assignStringArray(
		rawSkills.alwaysKeep,
		(value) => {
			config.skills.alwaysKeep = value;
		},
		"invalid pruning.skills.alwaysKeep; using default []",
	);

	// Parse tools config
	if (isRecord(raw.tools)) {
		const rawTools = raw.tools;

		assignEnumValue(
			rawTools.strategy,
			VALID_STRATEGIES,
			(value) => {
				config.tools!.strategy = value;
			},
			"invalid pruning.tools.strategy; using default",
		);

		assignPositiveInteger(
			rawTools.ceiling,
			(value) => {
				config.tools!.ceiling = value;
			},
			"invalid pruning.tools.ceiling; must be a positive integer; using default",
		);

		if (isRecord(rawTools.dependencies)) {
			const newDependencies: Record<string, string[]> = { ...DEFAULT_TOOL_CONFIG.dependencies };
			for (const [tool, deps] of Object.entries(rawTools.dependencies)) {
				if (isStringArray(deps)) {
					newDependencies[tool] = deps;
				} else {
					warn(`Invalid dependencies for tool '${tool}'; skipping`);
				}
			}
			config.tools!.dependencies = newDependencies;
		}

		assignStringArray(
			rawTools.alwaysKeep,
			(value) => {
				config.tools!.alwaysKeep = value;
			},
			"invalid pruning.tools.alwaysKeep; using default []",
		);
	}

	return config;
}
