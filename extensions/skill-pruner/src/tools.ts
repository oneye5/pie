import { state, getPiToolSeams } from "./state.js";

export const requestToolDefinition = {
	name: "request_tool",
	label: "Request Tool",
	description: "Request a tool that was pruned from the current session. Use when you need a tool that is not currently available. The tool will be enabled for the remainder of the session.",
	parameters: {
		type: "object",
		properties: {
			toolName: {
				type: "string",
				description: "The name of the tool to enable (e.g. 'web_search', 'fetch_content')",
			},
		},
		required: ["toolName"],
	},
	async execute(_toolCallId: string, params: Record<string, unknown>, _signal: AbortSignal, _onUpdate: () => void, _ctx: unknown) {
		const toolName = params.toolName as string;
		const allTools = state.getAllToolsOverride
			? state.getAllToolsOverride()
			: getPiToolSeams().getAllTools();
		const activeTools = state.getActiveToolsOverride
			? state.getActiveToolsOverride()
			: getPiToolSeams().getActiveTools();

		const knownNames = new Set(allTools.map((t) => t.name));
		if (!knownNames.has(toolName)) {
			return { content: [{ type: "text" as const, text: `Unknown tool '${toolName}'. Available tools: ${[...knownNames].sort().join(", ")}` }], isError: true };
		}
		if (activeTools.includes(toolName)) {
			return { content: [{ type: "text" as const, text: `Tool '${toolName}' is already active.` }] };
		}

		const newActiveTools = [...activeTools, toolName];
		if (state.setActiveToolsOverride) {
			state.setActiveToolsOverride(newActiveTools);
		} else {
			getPiToolSeams().setActiveTools(newActiveTools);
		}

		return { content: [{ type: "text" as const, text: `Tool '${toolName}' has been enabled and is now available.` }] };
	},
};
