/**
 * Agent-name validation and "unknown agent" error helpers. Extracted from
 * `index.ts` — behaviour-preserving.
 */

import type { AgentConfig, AgentScope } from "./agents.js";
import { AGENT_SCOPE_VALUES, type SingleResult } from "./types.js";

export function formatAvailableAgents(agents: AgentConfig[]): string {
	return agents.map((a) => `"${a.name}"`).join(", ") || "none";
}

export function findSuggestedAgentName(agentName: string, agents: AgentConfig[]): string | undefined {
	const normalized = agentName.trim().toLowerCase();
	return agents.find((a) => a.name.toLowerCase() === normalized)?.name;
}

export function buildUnknownAgentError(agentName: string, agents: AgentConfig[]): string {
	const available = formatAvailableAgents(agents);
	const suggestion = findSuggestedAgentName(agentName, agents);
	const workerHint = agents.some((a) => a.name === "worker")
		? ' If you need a general-purpose delegate, try "worker".'
		: "";

	if (AGENT_SCOPE_VALUES.has(agentName as AgentScope)) {
		return `Invalid agent name: "${agentName}". "${agentName}" is an agentScope value, not an agent name. Set agentScope separately and choose an exact agent name.${workerHint} Available agents: ${available}.`;
	}

	if (suggestion && suggestion !== agentName) {
		return `Unknown agent: "${agentName}". Did you mean "${suggestion}"? Available agents: ${available}.`;
	}

	return `Unknown agent: "${agentName}". Available agents: ${available}.${workerHint}`;
}

export function createInvalidAgentResult(
	agentName: string,
	task: string,
	agents: AgentConfig[],
	step?: number,
): SingleResult {
	return {
		agent: agentName,
		agentSource: "unknown",
		task,
		exitCode: 1,
		messages: [],
		stderr: buildUnknownAgentError(agentName, agents),
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		step,
	};
}

export function summarizeInvalidAgentResults(results: SingleResult[]): string {
	if (results.length === 1) {
		return results[0].stderr;
	}

	const lines = results.map((result) => `[${result.agent}] ${result.stderr}`);
	return `Invalid agent names in ${results.length} subagent tasks.\n\n${lines.join("\n")}`;
}
