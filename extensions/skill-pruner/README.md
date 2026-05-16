# skill-pruner

Reduces prompt noise by showing only the skills most relevant to the current user prompt. Purely programmatic—no LLM calls.

## Behavior

- Scores each available skill using trigger phrases, keyword overlap, and skill-name matching
- Keeps a configurable floor/ceiling of visible skills
- Always includes pinned skills
- Adds a hidden recovery hint listing pruned skill names
- Logs pruning decisions and skill reads to `data/pruning.jsonl`

## Configuration

Add an optional `pruning` block to the root `settings.json`:

```json
{
  "pruning": {
    "mode": "auto",
    "skills": {
      "ceiling": 5,
      "floor": 2,
      "scoreThreshold": 0.4,
      "gapThreshold": 0.3,
      "pinned": ["debugging-and-error-recovery"]
    }
  }
}
```

If the block is missing, these defaults are used.

## Modes

- **auto** — actively replaces the `<available_skills>` block with the pruned set
- **shadow** — computes and logs pruning decisions but leaves the prompt unchanged
- **off** — disables pruning; skill reads are still logged as baseline data

## Recovery

- Use `/skill:name` to explicitly request a pruned skill on the next turn
- Pin must-have skills in `settings.json`
- Switch `pruning.mode` to `shadow` to audit decisions without changing prompts
- Switch `pruning.mode` to `off` to disable the extension
