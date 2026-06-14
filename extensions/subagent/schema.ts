/**
 * Typebox parameter schema for the subagent tool. Extracted from `index.ts` —
 * behaviour-preserving.
 */

import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "typebox";

const BUCKET_GUIDANCE = "Bucket hint for model selection: 'small' (Haiku-class, busywork), 'medium' (Sonnet-class, main development), or 'frontier' (Opus-class, hardest problems). Defaults to 'medium' when omitted.";

const THINKING_LEVEL_GUIDANCE = "Optional thinking effort hint: 'minimal', 'low', 'medium', 'high', or 'xhigh'. When omitted, the model uses its default thinking behavior.";

const BucketSchema = Type.Optional(StringEnum(["small", "medium", "frontier"] as const, {
	description: BUCKET_GUIDANCE,
	default: "medium",
}));

const ThinkingLevelSchema = Type.Optional(StringEnum(["minimal", "low", "medium", "high", "xhigh"] as const, {
	description: THINKING_LEVEL_GUIDANCE,
}));

const TaskItem = Type.Object({
	agent: Type.String({
		description:
			'Exact agent name to invoke. This is not agentScope; do not pass "user", "project", or "both" unless those are real agent names.',
	}),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	bucket: BucketSchema,
	thinkingLevel: ThinkingLevelSchema,
});

const ChainItem = Type.Object({
	agent: Type.String({
		description:
			'Exact agent name to invoke. This is not agentScope; do not pass "user", "project", or "both" unless those are real agent names.',
	}),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	bucket: BucketSchema,
	thinkingLevel: ThinkingLevelSchema,
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
	bucket: BucketSchema,
	thinkingLevel: ThinkingLevelSchema,
});
