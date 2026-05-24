# Plan: LLM-Based Skill/Tool Pruner

## Goal

Replace the current heuristic scorer (`scorer.ts`) with a single LLM call that decides which skills and tools are relevant to the user's request. Add a "discretion mode" where the LLM decides how many skills to include (including zero), rather than always filling to a ceiling.

## Configuration (settings.json)

Replace the current `pruning.skills` block:

```jsonc
{
  "pruning": {
    "mode": "auto",              // "auto" | "off" | "shadow" (unchanged)
    "model": "gpt-5.4-mini",    // model id to use for pruning LLM call
    "provider": "github-copilot", // provider for the pruning model
    "thinkingLevel": "minimal", // thinking level for the pruning call
    "skills": {
      "strategy": "discretion", // "discretion" | "topK"
      "ceiling": 8,             // max skills (hard cap even in discretion mode)
      "pinned": ["debugging-and-error-recovery"]
    },
    "tools": {
      "strategy": "discretion", // "discretion" | "topK"
      "ceiling": 10,
      "dependencies": { "edit": ["read"], "subagent": ["bash"] }
    }
  }
}
```

**Removed fields**: `floor`, `scoreThreshold`, `gapThreshold`, `tiers` (the LLM replaces all heuristic scoring).

**New fields**: `model`, `provider`, `thinkingLevel`, `strategy` (per skill/tool section).

## Architecture

```
before_agent_start event
        │
        ▼
┌─────────────────────────┐
│  Build pruning prompt   │  ← user prompt + skill/tool names+descriptions
└──────────┬──────────────┘
           │
           ▼
┌─────────────────────────┐
│  completeSimple(model,  │  ← single LLM call via @mariozechner/pi-ai
│    context, options)    │
└──────────┬──────────────┘
           │
           ▼
┌─────────────────────────┐
│  Parse JSON response    │  ← { skills: ["name1", ...], tools: ["name1", ...] }
│  + validate + fallback  │
└──────────┬──────────────┘
           │
           ▼
┌─────────────────────────┐
│  Apply pinned skills    │
│  + ceiling cap          │
│  + tool dependencies    │
└──────────┬──────────────┘
           │
           ▼
  Return pruned system prompt + setActiveTools
```

## Implementation Steps

### Step 1: Update types (`types.ts`)

- Remove: `SkillTriggers`, `SkillScoreCacheEntry`, `ScoredSkill` (trigger/keyword/name scores), `ThresholdResult`
- Keep: `PruningMode`, `PruningConfig`, `PruningResult`, `PruningDecision`, `ScoredTool`, `ToolDependencies`
- Add: `LlmPruningConfig` replacing `SkillPruningConfig`

```ts
export type PruningStrategy = "discretion" | "topK";

export interface SkillPruningConfig {
  strategy: PruningStrategy;
  ceiling: number;
  pinned: string[];
}

export interface ToolPruningConfig {
  strategy: PruningStrategy;
  ceiling: number;
  dependencies: ToolDependencies;
}

export interface PruningConfig {
  mode: PruningMode;
  model: string;
  provider: string;
  thinkingLevel: string;
  skills: SkillPruningConfig;
  tools?: ToolPruningConfig;
}
```

Update `PruningDecision` to log the LLM's raw response and latency instead of per-skill numeric scores.

### Step 2: Delete `scorer.ts`

The entire file is replaced by the LLM call. Remove all exports:
- `tokenize`, `extractTriggers`, `computeTriggerMatch`, `computeKeywordOverlap`, `computeNameMatch`, `scoreSkills`, `scoreTools`, `applyThreshold`, `applyToolThreshold`

### Step 3: Create `llm-scorer.ts` (new file)

Core responsibility: build the pruning prompt, call the model, parse the response.

```ts
import { completeSimple } from "@mariozechner/pi-ai";
import type { Model, Api, SimpleStreamOptions } from "@mariozechner/pi-ai";
import type { ModelRegistry } from "@mariozechner/pi-coding-agent";
import type { Skill, ToolInfo } from "@mariozechner/pi-coding-agent";
import type { PruningConfig, PruningStrategy } from "./types.js";

export interface LlmPruningInput {
  userPrompt: string;
  contextFile?: string;
  skills: Array<{ name: string; description: string }>;
  tools: Array<{ name: string; description: string }>;
  config: PruningConfig;
}

export interface LlmPruningOutput {
  selectedSkills: string[];
  selectedTools: string[];
  rawResponse: string;
  latencyMs: number;
}

export async function runLlmPruning(
  input: LlmPruningInput,
  model: Model<Api>,
  options: SimpleStreamOptions,
): Promise<LlmPruningOutput> { ... }
```

**Prompt design** (system prompt for the pruning model):

```
You are a relevance filter. Given a user request and a list of available skills and tools, select ONLY those that are directly needed.

Rules:
- For skills: select only skills whose specialized knowledge is required. If the request is simple/routine, select NONE.
- For tools: select only tools the agent will likely need to call. Always include core tools (read, edit, write, bash) unless the task clearly won't need them.
- Respond with ONLY a JSON object: {"skills": ["name1", ...], "tools": ["name1", ...]}
- Do not explain. Do not add commentary.
```

User message:
```
User request: "{userPrompt}"

Available skills:
{skills.map(s => `- ${s.name}: ${s.description}`).join('\n')}

Available tools:
{tools.map(t => `- ${t.name}: ${t.description}`).join('\n')}
```

**topK mode**: Append to system prompt: `"Select up to {ceiling} skills and {toolCeiling} tools, ranked by relevance."`

**discretion mode**: Append: `"Select only what is genuinely needed. It is acceptable to select zero skills if the request is routine."`

**Fallback**: If the LLM call fails (timeout, parse error, model unavailable), fall through to "include all" (safe degradation — no pruning rather than broken pruning).

### Step 4: Update `config.ts`

- Add parsing for new fields: `model`, `provider`, `thinkingLevel`, `strategy`
- Remove parsing for old fields: `scoreThreshold`, `gapThreshold`, `floor`
- Update `DEFAULT_CONFIG`:

```ts
export const DEFAULT_CONFIG: PruningConfig = {
  mode: "auto",
  model: "gpt-5.4-mini",
  provider: "github-copilot",
  thinkingLevel: "minimal",
  skills: {
    strategy: "discretion",
    ceiling: 8,
    pinned: [],
  },
  tools: {
    strategy: "discretion",
    ceiling: 10,
    dependencies: { edit: ["read"], subagent: ["bash"] },
  },
};
```

### Step 5: Update `index.ts` (main extension)

- Remove imports of `scoreSkills`, `applyThreshold`, `scoreTools`, `applyToolThreshold` from `./scorer.js`
- Import `runLlmPruning` from `./llm-scorer.js`
- In `before_agent_start` handler:
  1. Resolve the pruning model from `modelRegistry` using `config.model` + `config.provider`
  2. Build the `LlmPruningInput` from event data
  3. Call `runLlmPruning()`
  4. Apply pinned skills (union with LLM selections)
  5. Apply ceiling cap
  6. Apply tool dependencies (if tool X is selected, include its deps)
  7. Rewrite system prompt skills block (existing logic, unchanged)
  8. Call `setActiveTools()` for tool pruning (existing logic, unchanged)
- Remove the `skillCache` map (no longer needed)
- Keep `request_tool` recovery tool (unchanged)
- Keep logging/decision infrastructure (adapt to new shape)

**Model resolution** within the hook:

```ts
const ctx = ...; // from event handler second arg
const registry: ModelRegistry = ctx.modelRegistry;
const pruningModel = registry.find(config.provider, config.model);
if (!pruningModel) {
  // Fallback: no pruning (log warning)
  return undefined;
}
const auth = await registry.getApiKeyAndHeaders(pruningModel);
if (!auth.ok) {
  // Fallback: no pruning
  return undefined;
}
const result = await runLlmPruning(input, pruningModel, {
  reasoning: config.thinkingLevel as ThinkingLevel,
  apiKey: auth.apiKey,
  headers: auth.headers,
  signal: AbortSignal.timeout(10_000), // hard 10s timeout for pruning
});
```

### Step 6: Update `logger.ts`

Adapt `PruningDecision` logged to JSONL:
- Remove per-skill numeric scores (`triggerScore`, `keywordScore`, `nameScore`, `compositeScore`)
- Add: `llmResponse` (raw string), `llmLatencyMs`, `llmModel`, `llmThinkingLevel`
- Keep: `timestamp`, `sessionId`, `mode`, `query`, `included`, `excluded`, `skillBlockTokens`, `originalBlockTokens`

### Step 7: Update tests

- **Delete `scorer.test.ts`** — the heuristic scorer no longer exists
- **Update `config.test.ts`** — test new field parsing (`model`, `provider`, `thinkingLevel`, `strategy`)
- **Update `integration.test.ts`** — mock the LLM call (inject a test seam for `completeSimple`) and verify:
  - Discretion mode: LLM returns subset → only those skills included
  - Discretion mode: LLM returns empty → zero skills included (except pinned)
  - topK mode: ceiling enforced even if LLM returns more
  - Pinned skills always included regardless of LLM output
  - Tool dependencies honored
  - LLM failure → graceful fallback (all skills included)
  - Parse error → graceful fallback
  - Timeout → graceful fallback
- **Create `llm-scorer.test.ts`** — unit tests for prompt construction and response parsing

### Step 8: Update `settings.json` (repo root)

```jsonc
{
  "pruning": {
    "mode": "auto",
    "model": "gpt-5.4-mini",
    "provider": "github-copilot",
    "thinkingLevel": "minimal",
    "skills": {
      "strategy": "discretion",
      "ceiling": 8,
      "pinned": ["debugging-and-error-recovery"]
    },
    "tools": {
      "strategy": "discretion",
      "ceiling": 10,
      "dependencies": { "edit": ["read"], "subagent": ["bash"] }
    }
  }
}
```

## Dependency Summary

| File | Action |
|------|--------|
| `extensions/skill-pruner/types.ts` | Rewrite interfaces |
| `extensions/skill-pruner/scorer.ts` | **Delete** |
| `extensions/skill-pruner/llm-scorer.ts` | **Create** |
| `extensions/skill-pruner/config.ts` | Update defaults + parsing |
| `extensions/skill-pruner/index.ts` | Replace scoring logic with LLM call |
| `extensions/skill-pruner/logger.ts` | Adapt decision shape |
| `extensions/skill-pruner/test/scorer.test.ts` | **Delete** |
| `extensions/skill-pruner/test/config.test.ts` | Update |
| `extensions/skill-pruner/test/integration.test.ts` | Rewrite with LLM mocks |
| `extensions/skill-pruner/test/llm-scorer.test.ts` | **Create** |
| `settings.json` (repo root) | Update pruning block |

## Edge Cases & Failure Modes

1. **Model not available** (not in registry, auth missing): Skip pruning entirely, log warning. Zero skills removed is always safe.
2. **LLM returns invalid JSON**: Attempt regex extraction of skill/tool names from raw text. If that fails, fallback to all-included.
3. **LLM returns unknown skill/tool names**: Silently filter to known names only.
4. **Latency budget exceeded** (>10s): Abort via `AbortSignal.timeout`, fall back to all-included.
5. **Shadow mode**: Still makes the LLM call and logs the decision, but doesn't modify the system prompt.
6. **Empty skills list**: Skip the LLM call entirely (nothing to prune).

## Open Questions for User

1. Should the `request_tool` recovery mechanism remain unchanged? (Agent can request a pruned tool mid-session.)
2. Should there be a token budget for the pruning prompt itself? (With 10 skills at ~50 words each, plus tools, the pruning prompt is ~1000 tokens — negligible for any model.)
3. Should pruning decisions feed into analytics (DuckDB)? Currently they log to JSONL — the analytics pipeline could ingest them for model-quality tracking.
