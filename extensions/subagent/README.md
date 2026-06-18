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

## Timeouts

Subagents **do not time out by default** — a subagent runs until it finishes or
the parent aborts it (Ctrl+C / parent cancellation). The parent's abort signal
is always the real escape hatch. Previously a hardcoded 10-minute timeout
wrapped the *entire* multi-turn run and prematurely killed long exploratory
work; that default has been removed.

A timeout safety net can be (re-)enabled via the `PI_SUBAGENT_TIMEOUT_MS`
environment variable (milliseconds). It wraps the *entire* multi-turn run (all
turns + tool calls), not a single model response. `0` or unset disables it.

```bash
# 30-minute safety net
export PI_SUBAGENT_TIMEOUT_MS=1800000
```

## Parallel output preview

In parallel mode, each task's output is returned to the parent model, truncated
to a preview limit to bound context growth (default **8000 chars** per task;
with up to 8 tasks that's ~64 KB). When truncated, the elided char count is
noted so the parent LLM knows output was cut. Override via
`PI_SUBAGENT_PARALLEL_PREVIEW` (characters). `0` disables truncation entirely
(full output per task — use with care for large outputs).

```bash
# Return full output for every parallel task
export PI_SUBAGENT_PARALLEL_PREVIEW=0
```

Chain mode is unaffected: the `{previous}` placeholder substitutes the prior
step's full output, and the chain returns the final step's full output to the
parent. Single mode returns the agent's full final output.
