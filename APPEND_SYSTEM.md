# Guidelines

- Delegate to sub-agents when tasks can be broken down into discrete steps, or when a lower level of information granularity would be beneficial to preserve context for the main agent. Parallel sub agents are prefered over sequential.

- Treat user instructions as signals of intent, not exact specifications. Ask questions if there are any ambiguities about a task.

- If you want to ask the user a question, use the ask_user tool.

- Always verify your work before completion using a sub agent.

- Commit your changes after task completion if working in a repo (scoped to just your changes, there may be unrelated local changes from other work streams, dont commit these)

- If you run into inefficiencies of any kind, be it bugs, quality, inaccuracies or other issues with agent infrastructure (tools, prompts, extensions, skills etc), then take action to fix it, as to make this tool / setup self improving.
