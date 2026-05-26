# Plan: NLP-Based Skill & Tool Pruning

## Problem Statement

Pi injects all discovered skill descriptions into every system prompt as an `<available_skills>` XML block. With 11 skills, each contributing ~50-100 tokens of name + description + path, this creates two problems:

1. **Distractor degradation**: Research shows accuracy drops from 0.92→0.68 as context grows from 250→3K tokens, and even 1 distractor degrades performance (Same Task, More Tokens, ACL 2024). Irrelevant skill descriptions compete for model attention with relevant ones.

2. **Context waste**: While individual skill descriptions are small (~50 tokens each), the cumulative effect + the attention cost matters more than the raw token count.

Tools have the same problem but with higher stakes: removing an essential tool (read, edit, bash) breaks the agent entirely, while pruning rarely-needed tools (subagent, web_search) is highly valuable for attention efficiency.

## Design Decisions

### D1: Interception Point — `before_agent_start` Extension Hook

**Decision**: Implement pruning as a pi extension using the `before_agent_start` event hook.

**Rationale**: 
- Already exists as a first-class hook with access to `event.systemPromptOptions.skills` (the `Skill[]` array) and the full assembled system prompt string
- Can return a modified `systemPrompt` to replace the prompt for this turn
- `formatSkillsForPrompt()` is exported from the pi SDK — we can call it with a filtered `Skill[]` to produce a clean pruned XML block
- Ships independently of pi core — no upstream changes needed
- Fires per user prompt — natural re-evaluation point

**Rejected alternatives**:
- `before_turn` hook: Requires upstream pi change; overkill for v1
- Core pi modification: Blocks iterative development; couples to pi release cycle
- Sidecar service: Unnecessary operational complexity for 11 skills

### D2: Scoring Approach — Trigger-Phrase Extraction + Keyword Overlap (v1)

**Decision**: Phase 1 uses a composite of three signals: trigger-phrase extraction from skill descriptions, keyword overlap (Jaccard), and name-token matching. Phase 2 optionally adds neural embeddings via `@xenova/transformers` with RRF fusion.

**Why not standard BM25 as the dominant signal**:
With only 11 documents (skills), BM25's IDF component is nearly flat — there aren't enough documents for statistical differentiation. The word "use" appears in nearly every skill description (because of the "Use when..." convention), so BM25's IDF correctly gives it near-zero weight, but the remaining signal is almost entirely term frequency on a handful of discriminative tokens. BM25 on 11 documents is effectively keyword overlap with extra steps.

Instead, the **trigger-phrase extraction** is the genuinely semantic component: it parses the "Use when..." / "Do not use for..." clauses that every skill description already contains (enforced by `agent-skill-design`), and matches the user's query against those trigger conditions directly.

**Trigger-phrase extraction algorithm**:
```
extractTriggers(description: string) → { positive: string[], negative: string[] }
```
1. Find the description text (frontmatter field, already available via `Skill.description`)
2. Split into sentences (period + space boundary)
3. For each sentence:
   - If starts with "Use when" or "Use for" → extract the clause as a positive trigger
   - If starts with "Do not use for" or "Do not use when" → extract as a negative trigger
   - Comma-separated items within a clause are split into individual trigger phrases
4. Each trigger phrase is normalized: lowercase, strip trailing punctuation, collapse whitespace
5. Result: `{ positive: ["comparing treatment groups", "ab test results", ...], negative: ["simple descriptive statistics", ...] }`

**Trigger matching algorithm**:
```
computeTriggerMatch(query: string, triggers: { positive: string[], negative: string[] }) → number [0, 1]
```
1. Tokenize query into lowercase tokens (stop-word removal applied)
2. For each positive trigger: compute token overlap between query tokens and trigger tokens. Score = `|intersection| / |trigger_tokens|` (proportion of trigger tokens matched). If any query token exactly matches a trigger token, that's a strong signal (+0.3 bonus).
3. `positiveScore = max(triggerScores)` — the best-matching positive trigger determines the score
4. For each negative trigger: same overlap computation. If negative trigger matches strongly (>0.5), reduce score.
5. `negativePenalty = max(negativeScores) * 0.5`
6. Final: `clamp(positiveScore - negativePenalty, 0, 1)`

**Keyword overlap algorithm**:
```
computeKeywordOverlap(query: string, text: string) → number [0, 1]
```
1. Tokenize both into lowercase tokens with stop-word removal
2. `overlap = |intersection(query_tokens, text_tokens)| / |union(query_tokens, text_tokens)|` (Jaccard coefficient)
3. Skill name tokens are weighted 2× in the text_tokens bag (name is higher signal)

**Name match algorithm**:
```
computeNameMatch(query: string, name: string) → number [0, 1]
```
1. Split skill name on hyphens → name parts: `["code", "review", "and", "quality"]`
2. For each name part: check if part appears in query tokens (lowercased)
3. `score = matched_parts / total_parts` (skip common connector words: "and", "or", "for", "the")
4. If full skill name appears in query, set score = 1.0 (direct reference)

**Composite scoring formula**:
```
score(skill, query) = λ₁ × normalize(triggerMatch(skill, query))
                    + λ₂ × normalize(keywordOverlap(skill, query))
                    + λ₃ × normalize(nameMatch(skill, query))
```
- `normalize(scores[])` = min-max normalization across all candidate scores. When `maxScore === minScore`, return `0.5` for all candidates (degenerate guard — avoids NaN, provides deterministic fallback).
- `λ₁ = 0.50, λ₂ = 0.30, λ₃ = 0.20` (trigger phrases dominate as the semantic signal, keyword overlap adds recall, name matching handles direct references)

**v2 extension (deferred)**: Add `@xenova/transformers` embeddings + RRF fusion. Only activates when `pruning.engine: "hybrid"` is set. Prerequisite: demonstrated failure cases (skill-miss rate >2% attributable to lexical mismatch).

### D3: Pruning Granularity — Entire `<skill>` XML Entries via `formatSkillsForPrompt()`

**Decision**: Prune at the `<skill>` entry level by filtering the `Skill[]` array and calling `formatSkillsForPrompt()` with the filtered subset.

**Implementation approach**:
1. From `event.systemPromptOptions`, get the `skills` array (`Skill[]`)
2. Filter to `includedSkills` based on scoring + threshold
3. Call `formatSkillsForPrompt(includedSkills)` to produce the pruned XML block
4. Strip the leading `\n\n` from `formatSkillsForPrompt()` output (the function prepends double-newline separators; we handle spacing explicitly to avoid double-newline artifacts after replacement)
5. In the assembled system prompt string, locate the skills block region and replace it with the pruned block + hint comment
6. If the replacement regex doesn't match (format change), log a warning and skip pruning — fail open, not closed

**Why not rebuild the entire system prompt**: The system prompt contains provider-specific content, context files, and other sections managed by pi core. Replacing only the skills section via string replacement is surgical and won't break when pi's prompt format changes. The regex anchors on the preamble and closing tag from the Agent Skills standard.

**Replacement strategy**:
```typescript
const SKILLS_BLOCK_RE = /\n\nThe following skills provide specialized instructions for specific tasks\.[\s\S]*?<\/available_skills>/;

function replaceSkillsBlock(systemPrompt: string, newBlock: string, hint: string): string {
  // Strip the leading \n\n that formatSkillsForPrompt() prepends
  const stripped = newBlock.replace(/^\n\n/, '');
  const replacement = `\n\n${stripped}\n${hint}`;
  const result = systemPrompt.replace(SKILLS_BLOCK_RE, replacement);
  if (result === systemPrompt) {
    // Pattern didn't match — fail open (return original prompt unchanged)
    return systemPrompt;
  }
  return result;
}
```

The regex captures the `\n\n` preamble prefix to avoid leaving orphaned newlines. If the stable preamble text changes in a future pi version, the regex silently fails to match and the original system prompt is returned unchanged — the agent gets all skills, which is the safe default.

### D4: Skill vs Tool Scope — Skills First, Tools in Phase 2

**Decision**: Phase 1 prunes skills only. Tools are added in Phase 2 with tiered classification (core always-on + contextual pruned).

**Rationale**:
- Skills are additive context — removing one never breaks the agent's core capability
- Tools are structural — removing `read` or `edit` breaks the agent loop entirely
- Skills are the safer domain to learn on, with lower consequences for false negatives
- Tools require additional design (tiering, dependency graph, pinning) that benefits from Phase 1 learnings
- Tool context (names + descriptions + parameter schemas) is a larger token surface than skills

### D5: Threshold Strategy — Floor + Ceiling + Score Gap Detection + Degenerate Guard

**Decision**: Include skills where `score >= maxScore × 0.4` (relative threshold), bounded by floor of 2 and ceiling of 5 total included skills (pinned + scored). If all scores are equal (`maxScore === minScore`), include only the floor (2 skills, sorted by name for determinism).

**Gap detection**: If `sorted_scores[i] - sorted_scores[i+1] > 0.3 × maxScore`, truncate after i regardless of ceiling. This catches natural drops where only 2-3 skills are truly relevant.

**Pinned skill interaction with ceiling**: Ceiling of 5 applies to total included skills. If 3 skills are pinned, only 2 additional scored skills can pass the threshold. This keeps total cognitive load bounded.

**Rationale**:
- Fixed top-K fails when query matches 0 or 6 skills
- Fixed threshold fails because scores are query-dependent
- Relative threshold adapts to the query landscape
- Floor of 2 prevents the degenerate case (all-zero scores → 0 matches)
- Ceiling of 5 keeps distractor count bounded even for broad queries
- Gap detection catches "cliff" score distributions
- Degenerate guard (equal scores) prevents NaN and provides deterministic fallback

### D6: Recovery Mechanism — Hidden Skills Hint + `/skill:name` Awareness

**Decision**: Two-layer recovery:

1. **Hidden-skills hint**: After the pruned `<available_skills>` block, inject a single HTML comment listing pruned skill names with an actionable instruction:
```
<!-- Pruned skills (not shown to save attention): duckdb-query-optimization, prompt-evaluation, statistical-analysis. Use /skill:name to load one. -->
```
~40-50 tokens, lists only names (no descriptions = no distractor re-introduction), directs the user to use `/skill:name`. **Note**: This is a passive recovery path — it requires the user to act on the hint. The model cannot self-recover mid-turn by requesting a skill (it has no tool to do so). Recovery latency is at minimum 1 full user turn. This is acceptable for v1; a `request_skill(name)` tool for mid-turn model recovery is a potential Phase 2 addition.

2. **`/skill:name` natural inclusion**: The pruner's `input` event handler returns `{ action: "continue" }` for all inputs. Pi's native skill expansion runs after the `input` event, so `/skill:code-review-and-quality` is expanded by pi into the user message. The pruner's `before_agent_start` handler then sees the expanded skill content in `event.prompt` — which produces a high name-match score for that skill, naturally including it in the current turn's skill set. No special interception is needed.

**Rationale for two layers**:
- The hint is passive but low-cost — it informs the user about what's available
- The `/skill:name` path is the truly active recovery mechanism — the user explicitly requests a skill and pi's native expansion + the scorer's name matching guarantees inclusion
- Mid-turn model self-recovery is NOT supported in v1. A `request_skill(name)` tool would enable this and is a Phase 2 candidate.

### D7: Pinning — Config-Based Only (Not Frontmatter)

**Decision**: Pinned skills are declared in `settings.json` config only. No `pinned: true` frontmatter field.

**Rationale**: 
- The `Skill` interface (`SkillFrontmatter` → `loadSkillFromFile()`) only extracts `name`, `description`, `disableModelInvocation` — arbitrary frontmatter fields like `pinned` are dropped during loading. Detecting `pinned: true` would require re-parsing the raw SKILL.md file, adding complexity.
- Config-based pinning keeps the pinning decision in the user/agent configuration layer, not in the skill authoring layer. A skill author shouldn't decide their skill is always relevant to every agent.
- Config-based pinning is consistent with the `model-profiles.yaml` pattern (external config controls behavior).
- Adding frontmatter `pinned` later is a simple extension if needed (requires upstream `Skill` type change or raw file re-parsing).

### D8: Configuration — `settings.json` + Toggle

**Decision**: Add `pruning` key to `settings.json` with mode toggle and parameters. Pruning is **active by default**.

**Schema**:
```json
{
  "pruning": {
    "mode": "auto" | "off" | "shadow",
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

**Modes**:
- `auto`: Active pruning — excluded skills removed from prompt. **Default.**
- `off`: No pruning — all skills included. User toggle to disable.
- `shadow`: Diagnostic mode — compute pruning decisions but inject all skills normally, log what *would* have been pruned. Useful for debugging scoring without affecting agent behavior.

**Default mode**: `auto` — pruning ships active. The fail-open architecture (regex miss → all skills included) and pinning provide safety nets. Users can toggle to `off` at any time if pruning causes issues.

### D9: Observability — Pruning Log + Skill-Miss Detection (Both Modes) + Aggregate Analysis

**Decision**: Log pruning decisions to `data/pruning.jsonl` with per-component scores. Detect skill misses in both auto and shadow modes. Provide aggregate analysis tool.

**Pruning log entry**:
```json
{
  "timestamp": "2026-05-16T10:30:00Z",
  "sessionId": "abc123",
  "mode": "auto",
  "query": "refactor the authentication module",
  "contextFile": "AGENTS.md",
  "candidates": [
    {
      "name": "code-simplification",
      "triggerScore": 0.95,
      "keywordScore": 0.70,
      "nameScore": 0.60,
      "compositeScore": 0.82,
      "included": true
    }
  ],
  "pinned": ["debugging-and-error-recovery"],
  "included": ["debugging-and-error-recovery", "code-simplification", "code-review-and-quality"],
  "excluded": ["agent-skill-design", "api-and-interface-design"],
  "skillBlockTokens": 350,
  "originalBlockTokens": 660
}
```

Note: Per-component scores (`triggerScore`, `keywordScore`, `nameScore`) are logged for threshold tuning — without them, you can't tell which scoring component caused a miss.

**Token counting**: We estimate token count by counting the characters of the skills block and dividing by 4 (rough heuristic for English text). This avoids adding a tokenizer dependency. The log entries `skillBlockTokens` and `originalBlockTokens` are estimates for tracking context reduction.

**Skill-miss detection**:
- **All modes** (auto, shadow, off): Log which skills the agent actually reads via the `tool_call` hook. This data is always collected regardless of pruning mode so we can measure pruning's impact.
- **Auto mode**: When the agent calls `read` with a path matching a pruned skill's `filePath`, log `{"event": "skill_miss", "skillName": "...", "sessionId": "..."}`. This is a direct signal that pruning removed a skill the agent needed.
- **Shadow mode** (diagnostic): Cross-reference which skills *would have been pruned* vs which the agent *actually read*. If the agent reads a skill that would have been pruned, log `{"event": "shadow_miss_candidate", "skillName": "...", "sessionId": "..."}`.
- **Off mode**: Still log skill reads for baseline comparison (which skills does the agent use when it can see everything?).

**Aggregate analysis**: Simple analysis script reads `data/pruning.jsonl` across sessions and reports:
- Overall skill-miss rate (auto mode) and shadow-miss-candidate rate (shadow mode)
- **Comparative skill usage**: Skills read in `off` mode but not in `auto` mode → pruning impact. Skills never read in any mode → candidates for removal.
- Per-skill miss frequency (skills often missed → description quality problem or threshold too aggressive)
- Per-skill inclusion rate (always included → candidate for pinning; never included → candidate for removal)
- Score distribution histograms for threshold tuning
- Rolling 200-query window for rate stability (prevents small-sample noise)
- **Mode comparison**: When the user toggles between `auto` and `off`, compare task outcomes to measure pruning's real behavioral impact

### D10: Re-pruning Cadence — Per User Turn Only

**Decision**: Re-evaluate skill relevance only on new user turns, not on tool-result turns or assistant turns.

**Rationale**:
- `before_agent_start` fires per user prompt — natural re-evaluation point
- Re-pruning mid-tool-chain creates churn (skills appearing/disappearing) that confuses the agent
- Topic drift across user turns is the primary use case for re-evaluation
- The hint + `/skill:name` recovery paths (D6) provide mid-turn recovery without re-pruning

### D11: Subagent Skill Inheritance — Documented Behavior

**Decision**: Subagents do NOT get independent pruning. This is correct behavior, not a limitation.

**Rationale**: 
- The subagent extension sets `noExtensions: true` on spawned subagent processes, meaning the pruner extension doesn't load in subagents
- Subagents receive their own system prompt from the agent definition + `appendSystemPrompt`, not the main agent's full system prompt. They don't inherit the main agent's `<available_skills>` block — they get skills from their own resource loader
- If a subagent needs specific skills, the parent agent should mention them in the task prompt (which it already does when delegating)
- Independent subagent pruning would require the pruner to load inside the subagent process (contradicts `noExtensions: true`) or for the parent to pre-compute a subagent-specific skill set (adds complexity with unclear benefit given subagents are short-lived, single-purpose)

### D12: Scoring Context — User Prompt + Project Context

**Decision**: Score against the user's prompt text + the first context file content (AGENTS.md), not just the prompt alone.

**Rationale**:
- Skills are often needed based on project context, not just the user's query. Example: user asks "optimize this query" → agent needs `duckdb-query-optimization`. The skill is relevant to the project's database, not the word "optimize."
- `event.systemPromptOptions.contextFiles` provides loaded context file contents
- Including project context disambiguates vague queries: "refactor the module" in a frontend project → `frontend-design` + `code-simplification`; in a backend project → `api-and-interface-design` + `code-simplification`
- Only include the first (primary) context file to avoid context explosion in the scoring step
- User prompt is weighted higher than context (it's the direct intent signal); context is a secondary bias signal

---

## Implementation Plan

### Phase 1: Skill Pruning Extension (v1)

**New files**:
1. `extensions/skill-pruner/index.ts` — Main extension: `before_agent_start` hook, `tool_call` observer for skill-read tracking, `input` pass-through
2. `extensions/skill-pruner/scorer.ts` — Trigger-phrase extraction + keyword overlap + name matching + composite scoring + threshold application
3. `extensions/skill-pruner/config.ts` — Configuration loading + defaults + validation
4. `extensions/skill-pruner/logger.ts` — Pruning decision logging to `data/pruning.jsonl`, skill-read tracking, miss detection
5. `extensions/skill-pruner/types.ts` — Shared types: ScoredSkill, PruningConfig, PruningDecision
6. `extensions/skill-pruner/test/scorer.test.ts` — Unit tests for scoring components
7. `extensions/skill-pruner/test/config.test.ts` — Unit tests for config loading
8. `extensions/skill-pruner/test/integration.test.ts` — Integration test: full pipeline + regex replacement

**Dependencies**: None new (zero npm packages). `formatSkillsForPrompt` imported from pi SDK.

**Implementation steps**:

1. **types.ts**: Define `ScoredSkill` (with per-component scores), `PruningConfig`, `PruningDecision` interfaces.

2. **scorer.ts**: Implement:
   - `extractTriggers(description: string)` — Parse "Use when.../Do not use for..." clauses
   - `computeTriggerMatch(query, triggers)` — Score against extracted triggers
   - `computeKeywordOverlap(query, text)` — Jaccard with stop-word removal + name weighting
   - `computeNameMatch(query, name)` — Token matching on skill name parts
   - `scoreSkills(query, contextContent, skills)` — Composite scoring with normalization + degenerate guard
   - `applyThreshold(scored, config)` — Floor + ceiling + gap detection + relative threshold

3. **config.ts**: Load config from `settings.json` → `pruning` key. Defaults: mode=auto, ceiling=5, floor=2, scoreThreshold=0.4, gapThreshold=0.3, pinned=[]. Validate: ceiling ≥ floor ≥ 1, thresholds in [0,1].

4. **logger.ts**: 
   - `logPruningDecision(decision)` — Append to `data/pruning.jsonl`
   - `trackSkillRead(skillPath)` — Track reads for miss detection
   - `detectMiss(prunedSkills, readSkills)` — Cross-reference for both modes

5. **index.ts**: Wire extension:
   - `before_agent_start` (first call): Lazy-initialize trigger phrase cache from skills array (skills aren't available in `session_start`; cache on first `before_agent_start` call and reuse for subsequent calls)
   - `before_agent_start`: Ensure trigger phrase cache is initialized (lazy init on first call). Score → threshold → filter skills → call `formatSkillsForPrompt()` → replace skills block via regex → return modified system prompt → log
   - `tool_call`: Track `read` calls that match skill `filePath` values
   - `input`: Return `{ action: "continue" }` for all inputs (pass-through; pi's native `/skill:name` expansion handles recovery)
   - Import `formatSkillsForPrompt` from pi SDK

6. **Tests**:
   - **scorer.test.ts**: Trigger extraction from various description formats, trigger matching with positive/negative signals, keyword overlap with stop words, name matching with hyphens and connector words, composite scoring, degenerate case (all-equal scores → 0.5), gap detection, threshold with pinned skills vs ceiling, weighted Jaccard assertions
   - **config.test.ts**: Default values, validation, invalid config handling
   - **integration.test.ts**: Full pipeline with mock skills → pruned skill list, system prompt string replacement (regex captures `\n\n` prefix, no double-newline artifact), fail-open path (regex doesn't match → original returned), empty skills array, all-zero scores, `/skill:name` expanded prompt produces high name-match, off-mode baseline, auto-mode miss detection, pinned-not-found handling, disabled-skill exclusion, non-skill path no-event gate

**Estimated size**: ~500-600 lines total across all files.

**Deferred**: D9 aggregate analysis script → Phase 1.5. See `extensions/skill-pruner/README.md` § "Analysis (deferred)" for planned report fields. `data/pruning.jsonl` remains the source of truth.

### Phase 2: Tool Pruning (v2)

**Prerequisite**: Phase 1 running in `auto` mode with observability data showing pruning is working within acceptable skill-miss rates (<2%). Phase 2 design is informed by Phase 1's real-world miss data and scoring gaps.

**Candidate design decisions** (to be finalized based on Phase 1 learnings):
- Tool tiering: `core` (always-on: read, edit, write, bash), `contextual` (pruned), `rare` (off by default, agent must request)
- Tool dependency graph: if `edit` active → force-include `read`; if `subagent` active → force-include `bash`
- Tool tier classification in config
- Separate ceiling for tools

**Recovery for tool pruning**: Must include a `request_tool(name)` tool that the model can call mid-turn to dynamically enable a pruned tool. Unlike skills (which are additive context), missing a tool is a hard failure — the model physically cannot call it. This is why tool pruning needs a different recovery mechanism than skill pruning.

### Phase 3: Embedding Hybrid (v3, optional)

**Prerequisite**: Demonstrated failure cases from Phase 1 observability (skill-miss rate >2% attributable to lexical mismatch, not description quality).

**Candidate design decisions**:
- `@xenova/transformers` as optional dependency (lazy-loaded when `pruning.engine: "hybrid"`)
- Precompute skill embeddings at session start
- RRF fusion: `final_score = 1/(k + keyword_rank) + 1/(k + embedding_rank)` with k=60
- Embedding cache on disk (`data/embedding-cache/`)
- Falls back gracefully to keyword-only if transformers library fails to load

---

## Open Questions (to resolve during implementation)

1. **Project context weighting**: How much should contextFiles[0] (AGENTS.md) contribute to scoring vs the user prompt? Current plan: user prompt is primary, context is secondary. Exact weighting TBD during testing. Possible approach: concatenate prompt + first 500 chars of context file, or compute separate scores and blend with configurable weight.

2. **Pie compatibility**: Pie (VS Code extension) assembles `systemPromptOptions` when launching pi. The pruner extension's `before_agent_start` handler runs after pie's system prompt construction. Since the pruner only replaces the `<available_skills>` block via targeted regex, it shouldn't affect pie's other contributions (model selection, thinking level, custom prompt). This needs verification in testing.

## Success Metrics

1. **Skill-miss rate <2%**: Over a rolling 200-query window. Measured by skill-miss detector in `auto` mode.
2. **Context reduction ≥40%**: Pruned skill blocks are ≥40% shorter than original on average.
3. **Pruning is non-harmful**: When user toggles `auto` → `off`, task outcomes should not systematically improve. Measured by comparative analysis across mode switches.
4. **Data collection is continuous**: Pruning decisions and skill-read events are logged in all modes, enabling ongoing analysis whether pruning is active or not.