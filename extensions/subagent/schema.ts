/**
 * Typebox parameter schema for the subagent tool. Extracted from `index.ts` —
 * behaviour-preserving.
 */

import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "typebox";

const TaskScoresSchema = Type.Object({
	precision: Type.Optional(Type.Integer({ minimum: 0, maximum: 5, description: "How exact/correct must output be (0=rough draft, 5=must compile perfectly)" })),
	creativity: Type.Optional(Type.Integer({ minimum: 0, maximum: 5, description: "Novel solutions vs following patterns (0=copy existing, 5=invent new)" })),
	thoroughness: Type.Optional(Type.Integer({ minimum: 0, maximum: 5, description: "Exhaustiveness needed (0=quick scan, 5=leave no stone unturned)" })),
	reasoning: Type.Optional(Type.Integer({ minimum: 0, maximum: 5, description: "Chain-of-thought depth (0=direct/shallow, 5=multi-step deduction)" })),
});

const TaskItem = Type.Object({
	agent: Type.String({
		description:
			'Exact agent name to invoke. This is not agentScope; do not pass "user", "project", or "both" unless those are real agent names.',
	}),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	taskScores: Type.Optional(TaskScoresSchema),
});

const ChainItem = Type.Object({
	agent: Type.String({
		description:
			'Exact agent name to invoke. This is not agentScope; do not pass "user", "project", or "both" unless those are real agent names.',
	}),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	taskScores: Type.Optional(TaskScoresSchema),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description:
		'Which agent directories to search. This is separate from the agent field. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

export const SubagentParams = Type.Object({
	agent: Type.Optional(
		Type.String({
			description:
				'Exact agent name to invoke for single mode. This is not agentScope; do not pass "user", "project", or "both" unless those are real agent names.',
		}),
	),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
	taskScores: Type.Optional(TaskScoresSchema),
});
