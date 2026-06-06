/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Each subagent invocation runs an isolated AgentSession in-process via the
 * pi SDK (`createAgentSession`). The session shares the parent's auth and
 * model registry but gets its own context window, system prompt, and tools.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Files:
 *   - ./types.ts        — shared interfaces and constants
 *   - ./formatting.ts   — token / tool-call / display formatters
 *   - ./validation.ts   — agent-name validation + error helpers
 *   - ./runner.ts       — in-process AgentSession runner + depth/trail context
 *   - ./schema.ts       — typebox parameter schema
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { type AgentConfig, type AgentScope, discoverAgents, formatAgentList } from "../agents.js";
import { SubagentParams } from "../schema.js";
import { renderSubagentCall, renderSubagentResult } from "../render.js";
import { execute } from "./execute.js";

const TASK_SCORE_GUIDANCE = "TaskScores: prefer the lowest score that fits; omit routine dimensions (omitted = 2). Use 3 for normal professional work, 4 for hard/high-risk or unusually complex work, and 5 only for rare frontier difficulty. Score difficulty, not importance or uncertainty. Reasoning is special: omit/2 requests low thinking; use 0 for direct/shallow work.";

function buildDescription(disabled = false): string {
	if (disabled) {
		return "DISABLED: Sub agents are currently disabled. Calls to this tool will return an error immediately. Enable by removing the --no-subagent flag or unsetting the PI_SUBAGENT_DISABLED environment variable.";
	}

	const lines = [
		"Delegate tasks to specialized subagents with isolated context.",
		"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
		'The "agent" field must be an exact discovered agent name, not a scope keyword like "user", "project", or "both".',
		'Default agent scope is "user" (from ~/.pi/agent/agents).',
		'To enable project-local agents in .pi/agents, set agentScope: "both" (or "project").',
		TASK_SCORE_GUIDANCE,
	];

	try {
		const { agents } = discoverAgents(process.cwd(), "user");
		if (agents.length > 0) {
			const listing = agents.map((a) => `${a.name}: ${a.description}`).join("; ");
			lines.push(`Available agents: ${listing}.`);
		}
	} catch {
		// Discovery failed — omit listing; agents will still be validated at execution time
	}

	return lines.join(" ");
}

function buildPromptSnippet(disabled = false): string {
	if (disabled) {
		return "DISABLED: Sub agents are disabled. Do not call the subagent tool — it will return an error.";
	}
	try {
		const { agents } = discoverAgents(process.cwd(), "user");
		if (agents.length > 0) {
			const names = agents.map((a) => a.name).join(", ");
			return `Delegate tasks to specialized subagents with isolated context. Available agents: ${names}. ${TASK_SCORE_GUIDANCE}`;
		}
	} catch {
		/* ignore */
	}
	return `Delegate tasks to specialized subagents with isolated context. ${TASK_SCORE_GUIDANCE}`;
}

/** Check whether subagent execution is disabled via flag or env var. */
function isDisabled(pi: ExtensionAPI): () => boolean {
	return () =>
		pi.getFlag("no-subagent") === true ||
		["1", "true", "yes"].includes((process.env.PI_SUBAGENT_DISABLED ?? "").toLowerCase());
}

export default function (pi: ExtensionAPI) {
	// Register a CLI flag so users can disable subagent execution.
	// When set, the tool still registers (preventing LLM tool-call hangs)
	// but execute() returns an immediate error.
	pi.registerFlag("no-subagent", {
		description: "Disable subagent execution. The subagent tool will still appear in the tool list but will return an error immediately when called.",
		type: "boolean",
		default: false,
	});

	const isDisabledFn = isDisabled(pi);
	const disabled = isDisabledFn();

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: buildDescription(disabled),
		promptSnippet: buildPromptSnippet(disabled),
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			return execute(_toolCallId, params, signal, onUpdate, ctx, pi, isDisabledFn);
		},

		renderCall(args, theme, context) {
			return renderSubagentCall(args, theme, context);
		},

		renderResult(result, options, theme, context) {
			return renderSubagentResult(result, options, theme, context);
		},
	});
}
