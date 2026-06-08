# Guidelines

- Delegate to sub-agents when tasks can be broken down into discrete steps, or when a lower level of information granularity would be beneficial to preserve context for the main agent. Parallel sub agents are prefered over sequential.

- Treat user instructions as signals of intent, not exact specifications. Ask questions if there are ambiguities.

- Use the 'ask_user' tool for important decisions, ie the high level structure of a system.

- Always verify your work before completion using a sub agent.
