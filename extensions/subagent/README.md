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
- **Project agents** (`agents/`, project root) — opt-in via `agentScope: "both"` or `"project"`

Project agents require confirmation before running (security measure for untrusted repos).

## Task Scores

Optional hints for model selection:
```json
{
  "agent": "worker",
  "task": "Add validation to the signup form and update its tests",
  "taskScores": { "precision": 3, "thoroughness": 3, "reasoning": 0 }
}
```

Scores: `reasoning`, `precision`, `creativity`, `thoroughness` (0–5 each).

Use the lowest score that fits:
- Omit routine dimensions; omitted fields default to `2`.
- `3` = normal professional work that genuinely depends on that dimension.
- `4` = hard/high-risk or unusually complex work.
- `5` = rare frontier difficulty on that dimension.
- `reasoning` is special: omit/`2` requests low thinking; use `0` for direct/shallow work.
- Score task difficulty, not importance or your uncertainty.

Model selection reads `<pi-config>/model-profiles.yaml` when present, with `.json` fallback for backward compatibility (the shared registry — also consumed by pie's model picker). If no profile registry is available, no score-based model/thinking override is applied and normal agent/caller model resolution takes over.

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
- Max subagent sessions per reply: 20
- Max parallel tasks: 8
- Concurrency: 4
