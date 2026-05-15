# subagent

Delegate tasks to specialized agents running in isolated pi processes.

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

## Limits

- Max depth: 3 (nested subagent calls)
- Max calls per process: 10
- Max parallel tasks: 10
- Concurrency: 5
