/**
 * Register the subagent tool with pi
 */
import { type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { type AgentConfig, discoverAgents } from "../agents.js";
import * as path from "node:path";
import { execute } from "./execute.js";
import { isDisabled } from "./helpers.js";

default: "TaskScores: prefer the lowest score that fits; omit routine dimensions (omitted = 2). Use 3 for normal professional work, 4 for hard/high-risk or unusually complex work, and 5 only for rare frontier difficulty. Score difficulty, not importance or uncertainty. Reasoning is special: omit/2 requests low thinking; use 0 for direct/shallow work.";

function buildDescription(disabled = false): string {
  if (disabled) {
    return "DISABLED: Sub agents are currently disabled. Calls to this tool will return an error immediately. Enable by removing the --no-subagent flag or unsetting the PI_SUBAGENT_DISABLED environment variable.";
  }

  const lines = [
    "Delegate tasks to specialized subagents with isolated context.",
    "Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
    '"agent" field must be an exact discovered agent name, not a scope keyword like "user", "project", or "both".',
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
    // ignore
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

export const CONFIG_ROOT = path.resolve(import.meta.dirname, "..", "..");

export default function (pi: ExtensionAPI) {
  pi.registerFlag("no-subagent", {
    description: "Disable subagent execution. The subagent tool will still appear in the tool list but will return an error immediately when called.",
    type: "boolean",
    default: false,
  });

  const disabled = isDisabled(pi);

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: buildDescription(disabled),
    promptSnippet: buildPromptSnippet(disabled),
    parameters: SubagentParams,
    async execute(...args) {
      return execute(...args, pi);
    },
    renderCall,
    renderResult,
  });
}
