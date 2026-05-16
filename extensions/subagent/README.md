# subagent

Delegate tasks to specialized agents running as isolated in-process `AgentSession`s.

Each subagent invocation creates a fresh `AgentSession` via the pi SDK (`createAgentSession`).
The session shares the parent's auth, model registry, and OAuth tokens but gets its own
context window, system prompt, and tool allowlist. This is what unlocks newer GitHub Copilot
models that were broken under the previous CLI-subprocess approach.

## Modes

### Single
```json
{ "agent": "worker", "task": "Implement the login form" }
```

### Parallel
```json
{
  "tasks": [
    { "agent": "worker", "task": "Add unit tests" },
    { "agent": "worker", "task": "Update docs" }
  ]
}
```

### Chain
Sequential execution with `{previous}` placeholder for prior output:
```json
{
  "chain": [
    { "agent": "scout", "task": "Find all API endpoints" },
    { "agent": "worker", "task": "Add validation to: {previous}" }
  ]
}
```

## Agent Discovery

- **User agents** (`~/.pi/agent/agents/`) — default scope
- **Project agents** (`.pi/agents/`) — opt-in via `agentScope: "both"` or `"project"`

Project agents require confirmation before running (security measure for untrusted repos).

## Task Scores

Optional hints for model selection:
```json
{
  "agent": "worker",
  "task": "Complex refactor",
  "taskScores": { "reasoning": 4, "precision": 5 }
}
```

Scores: `reasoning`, `precision`, `creativity`, `thoroughness` (0–5 each).

Model selection reads `<pi-config>/model-profiles.json` (the shared registry — also consumed by pie's model picker). If that file is absent the subagent inherits the calling agent's model and thinking level.

When running under pie, provider toggles are mirrored into the pi backend. Models that are only available from providers toggled off in pie are removed from the subagent selection pool.

## Disabling Sub Agents

When sub agents are disabled, the tool still registers in the tool list (preventing
LLM tool-call hangs) but immediately returns an error when called.

**Two ways to disable:**

1. **CLI flag:** `pi --no-subagent`
2. **Environment variable:** `PI_SUBAGENT_DISABLED=1` (or `true` / `yes`)

When disabled, the tool's `description` and `promptSnippet` change to inform the LLM
that sub agents are unavailable. Any call returns:

> Sub agents are disabled. Enable them by removing the --no-subagent flag or unsetting the PI_SUBAGENT_DISABLED environment variable.

## Limits

- Max depth: 3 (nested subagent calls)
- Max calls per process: 10
- Max parallel tasks: 8
- Concurrency: 4
