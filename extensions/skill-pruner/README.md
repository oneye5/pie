# skill-pruner

Uses an LLM to score and prune skills/tools based on relevance to the current task. Reduces prompt noise and token usage by excluding irrelevant items.

## How it works

Before each agent turn, `skill-pruner` sends the user prompt + available skill/tool descriptions to an LLM (via `@mariozechner/pi-ai`). The LLM returns relevance scores; `skill-pruner` then:

1. Includes the top-N skills (respecting `ceiling` + `pinned`)
2. Includes the top-N tools, expanding dependency chains
3. Modifies the system prompt to remove the pruned items
4. Disables pruned tools via `pi.setActiveTools()`
5. Logs the decision to `data/pruning.jsonl`

A `request_tool` recovery tool lets the agent re-enable a pruned tool mid-session.

## Configuration

Add a `pruning` block to `settings.json`:

```json
{
  "pruning": {
    "mode": "auto",
    "model": "gpt-4o-mini",
    "provider": "github-copilot",
    "thinkingLevel": "minimal",
    "skills": {
      "strategy": "discretion",
      "ceiling": 8,
      "pinned": []
    },
    "tools": {
      "strategy": "discretion",
      "ceiling": 10,
      "dependencies": {
        "edit": ["read"],
        "subagent": ["bash"]
      }
    }
  }
}
```

### Top-level options

| Option | Default | Description |
|---|---|---|
| `mode` | `"auto"` | `auto` = prune + apply; `shadow` = log only; `off` = disabled |
| `model` | `"gpt-4o-mini"` | LLM model for relevance scoring |
| `provider` | `"github-copilot"` | Provider for the scoring model |
| `thinkingLevel` | `"minimal"` | Reasoning effort for the scorer (e.g., `"minimal"`, `"medium"`, `"high"`) |

### Skills options

| Option | Default | Description |
|---|---|---|
| `strategy` | `"discretion"` | Scoring strategy (`discretion` = LLM discretion; `topK` = pick top N directly) |
| `ceiling` | `8` | Maximum number of skills to keep |
| `pinned` | `[]` | Always-include these skills regardless of score |

### Tools options

| Option | Default | Description |
|---|---|---|
| `strategy` | `"discretion"` | Scoring strategy |
| `ceiling` | `10` | Maximum number of tools to keep |
| `dependencies` | `{ edit: [read], subagent: [bash] }` | Tool → dependency mapping; if tool is active, its deps are also included |

## Modes

| Mode | Prune? | Apply to prompt? | Log decisions? |
|---|---|---|---|
| `auto` | Yes | Yes | Yes |
| `shadow` | Yes | No | Yes |
| `off` | No | No | No (baseline reads only) |

## Integration

`skill-pruner` is a pi extension (loaded via `settings.json` packages). It hooks into:

- `before_agent_start` — main pruning logic
- `tool_call(read)` — tracks skill file reads for analytics
- `input` — auto-continues after pruning feedback

A `pruning-result` custom message is rendered in the transcript showing what was kept/pruned and estimated tokens saved.

## Recovery

- **Skills**: Use `/skill:name` on the next turn to explicitly include a skill
- **Tools**: Call `request_tool({ toolName: "web_search" })` to re-enable a pruned tool for the remainder of the session