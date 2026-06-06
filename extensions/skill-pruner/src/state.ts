import { formatSkillsForPrompt } from "@mariozechner/pi-coding-agent";
import type { Skill, ToolInfo } from "@mariozechner/pi-coding-agent";
import type { CompleteSimpleFn } from "../llm-scorer.js";
import type { PruningConfig } from "../types.js";
import path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Shared mutable state for the skill-pruner extension.
 *
 * Uses a single exported object instead of individual `export let` bindings
 * so that esbuild's CJS compilation (used by test runner `require()`) passes
 * the object by reference rather than copying static values. All modules
 * read and write through the same `state` object.
 */
export const state = {
	/** Lazily-resolved reference to @mariozechner/pi-ai's completeSimple. */
	_piCompleteSimple: undefined as ((model: unknown, context: unknown, options: unknown) => Promise<unknown>) | null | undefined,

	/** Facade for pi API methods used for tool introspection. */
	piApi: null as {
		getAllTools: () => ToolInfo[];
		getActiveTools: () => string[];
		setActiveTools: (names: string[]) => void;
	} | null,

	configOverrideForTesting: null as PruningConfig | null,
	formatSkillsForPromptImpl: formatSkillsForPrompt as (skills: Skill[]) => string,

	/** Test seam: overrides getAllTools / getActiveTools / setActiveTools. */
	getAllToolsOverride: null as (() => ToolInfo[]) | null,
	getActiveToolsOverride: null as (() => string[]) | null,
	setActiveToolsOverride: null as ((names: string[]) => void) | null,

	/** Test seam: override the LLM completion function. Use `false` to simulate unavailable. */
	completeFnOverride: null as CompleteSimpleFn | null | false,
};

/** Root of the pi-config repo, resolved from this extension's known position. */
export const CONFIG_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");

export const PROCESS_SESSION_ID = randomUUID();

/** Returns the pi API facade, falling back to no-ops when pi hasn't been initialized. */
export function getPiToolSeams(): {
	getAllTools: () => ToolInfo[];
	getActiveTools: () => string[];
	setActiveTools: (names: string[]) => void;
} {
	return state.piApi ?? {
		getAllTools: () => [],
		getActiveTools: () => [],
		setActiveTools: () => {},
	};
}

// Read-only accessors (use getter functions to work through esbuild CJS)
export function getConfigOverrideForTesting(): PruningConfig | null { return state.configOverrideForTesting; }
export function getFormatSkillsForPromptImpl(): (skills: Skill[]) => string { return state.formatSkillsForPromptImpl; }
export function getCompleteFnOverride(): CompleteSimpleFn | null | false { return state.completeFnOverride; }

// Setters for test seams
export function setConfigOverrideForTesting(value: PruningConfig | null): void { state.configOverrideForTesting = value; }
export function setFormatSkillsForPromptImpl(value: ((skills: Skill[]) => string) | null): void {
	state.formatSkillsForPromptImpl = value ?? formatSkillsForPrompt;
}
export function setAllToolsOverride(value: (() => ToolInfo[]) | null): void { state.getAllToolsOverride = value; }
export function setGetActiveToolsOverride(value: (() => string[]) | null): void { state.getActiveToolsOverride = value; }
export function setSetActiveToolsOverride(value: ((names: string[]) => void) | null): void { state.setActiveToolsOverride = value; }
export function setCompleteFnOverride(value: CompleteSimpleFn | null | false): void { state.completeFnOverride = value; }
export function setPiApi(value: typeof state.piApi): void { state.piApi = value; }
export function set_piCompleteSimple(value: typeof state._piCompleteSimple): void { state._piCompleteSimple = value; }