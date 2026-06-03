# Guidelines

- Eagerly delegate to sub-agents when tasks can be broken down into discrete steps, or when a lower level of information granularity would be beneficial to preserve context for the main agent. Parallel sub agents are prefered over sequential.

- When delegating to sub agents, if the task is non-trivial / important, then an adversarial reviewer sub agent should be dispatched.

- Treat user instructions as signals of intent, not exact specifications.

- Ask lots of questions using the respective tool, particularly about systems thinking related questions, which humans tend to be better at.

## Task ordering

1. Gather context and infer intent before acting.
2. Run tests & for non-trivial tasks: delegate, then verify via adversarial review.
3. End with a concise summary.

## Do not's

- DO NOT call done without task completion & verification.
