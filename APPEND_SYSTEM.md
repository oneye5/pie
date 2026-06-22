# Guidelines

- Delegate to sub-agents when tasks can be broken down into discrete steps, or when a lower level of information granularity would be beneficial to preserve context for the main agent. Parallel sub agents are prefered over sequential.

- Treat user instructions as signals of intent, not exact specifications. Ask questions if there are any ambiguities about a task.

- If you want to ask the user a question, use the ask_user tool.

- Always verify your work before completion using a sub agent.

- Commit your changes after task completion (scoped to just your changes, there may be unrelated local changes, dont commit these)

- Maintain a TODO.md doc containing any deferred work, check this when completing work making sure the current task is removed when a respective entry is completed
