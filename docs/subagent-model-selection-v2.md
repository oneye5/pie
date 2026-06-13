# Subagent Model Selection v2

Status: **Planned** (2026-06-11)

## Problem

The current subagent model selector (`extensions/subagent/model-selection.ts`) uses
manually-assigned capability scores (precision, creativity, thoroughness, reasoning)
in `model-profiles.yaml` matched against per-call `taskScores` via an asymmetric
fitness function. Issues:

1. **Scores aren't grounded in statistical reality** — they're assigned from
   benchmarks and qualitative judgment, not observed outcomes.
2. **Main agent burden** — scoring task complexity on every subagent call is
   unnecessary cognitive overhead for the calling model.
3. **Bad models can be selected** — small/weak models (e.g., 10B params) can win
   the fitness race on low-scored tasks despite being unusable for agentic work.
4. **Existing leaderboard bias** — the analytics leaderboard uses 95% CI lower
   bounds that crush rarely-used models, creating a vicious cycle where small
   models never accumulate enough data to rank.

## Design

### Main agent interface

Instead of per-dimension `taskScores` (precision, creativity, thoroughness, reasoning),
the main agent provides a **bucket hint** (`small`, `medium`, or `frontier`) per task.
Each `TaskItem` / `ChainItem` carries its own `bucket` field, replacing `taskScores`
at the same granularity. Different tasks in a parallel call can target different buckets.

### Data source

The leaderboard draws **primarily from main-agent `RunSnapshot` records**. A model
that performs well as a main agent on low-complexity tasks is a good candidate
for the `small` subagent bucket. Subagent-specific process metrics (task
completion rate, tool reliability) supplement the ranking when per-subagent-task
records become available, but are not required for the initial implementation.

Satisfaction and resolution are main-agent outcomes; they are attributed to the
model that ran the main agent, not to subagent models. This is intentional —
a model's general quality is a strong predictor of its subagent quality.

### Stratified leaderboard

A new leaderboard lives in `extensions/subagent/` and computes on-demand from
the analytics data store (JSONL + checkpoint files). It:

1. **Computes a per-run complexity score** (0–1) from observable heuristics:
   `fileMutation.lineAdditions + lineDeletions + lineModifications` (total line
   mutations), `fileMutation.touchedFileCount`, `toolUsage.totalCount`,
   `busyDurationMs`, `toolUsage.subagentTaskScores` (composite mean across
   dimensions; defaults to 0 for runs with zero subagent calls),
   `verification.totalCount`, `inputTokens`. Each normalized to
   0–1 via percentile rank against all runs in the current analytics data
   directory (recalculated on each leaderboard computation), equal weights to
   start, tunable with data.

2. **Splits runs into complexity terciles** (low / medium / high).

3. **Computes outcome scores per complexity band** using point estimates (raw
   means/proportions, not CI lower bounds):
   - Satisfaction (1–5 mean)
   - Resolution rate (0–1 mean)
   - First-attempt success (0–1 proportion)
   - Tool reliability (0–1 proportion)
   - Verification adoption (0–1 proportion)
   - Token efficiency (median, inverted)
   - **Cost efficiency** (composite quality × output tokens per USD, using `models.json` pricing)

4. **Ranks models within each complexity band** by composite score.

5. **Assigns models to buckets** — models with ≥1 scored run in a complexity band
   are ranked by composite outcome score (no per-model minimum; the global 40-run
   bootstrap gate is sufficient). Cost efficiency is baked into the composite
   score as a weighted dimension — no separate quality-tolerance + cost-preference
   step. No dual membership per `modelId::thinkingLevel` — each entry appears in
   only its best band's bucket, where "best band" is the band with the highest
   absolute composite outcome score.

   **Thinking levels as separate entries**: each `modelId::thinkingLevel` combination
   is a distinct leaderboard entry. A single model can appear in multiple buckets
   at different thinking levels (e.g., `gpt-5.5::xhigh` in `frontier`, `gpt-5.5::low`
   in `medium`). The "no dual membership" rule applies per `modelId::thinkingLevel`,
   not per `modelId`.

   Price awareness: for the `small` bucket, cost efficiency is a primary factor
   since quality differences are small for simple tasks. For the `frontier` bucket,
   quality dominates cost. `medium` balances both.

### Selection at call time

When the main agent invokes the subagent tool with a bucket hint:

1. Look up the bucket → get ranked `modelId::thinkingLevel` entries
2. Pick uniformly at random from all entries in that bucket
3. Pass model + thinking level to the runner (same as today, but no separate thinking filter)
4. **Fallback**: if the bucket is empty (no qualifying models), fall back to the
   current active model (the model running the main agent session). This ensures the
   subagent always has a usable model.

### Bootstrapping

The subagent tool refuses to run until **40 scored runs** exist in the analytics
store. Message: "Subagent model selection is calibrating. Continue working with
the main agent to build the performance baseline (X/40 scored runs)."

Main-agent runs seed the leaderboard naturally during normal use.

### Simple model config

A YAML file replaces `model-profiles.yaml` with per-model entries:

```yaml
- id: claude-sonnet-4.6
  eligible: true
  thinking: [low, medium, high, xhigh]
  disabled_reason: null
  cost: 10  # fallback when pricing data unavailable

- id: gpt-5-mini
  eligible: false
  disabled_reason: "repeated tool failures in subagent mode"
  thinking: [low, medium]
  cost: 5
```

The config is the **authority on eligibility** — `eligible: false` excludes a model
from all buckets regardless of leaderboard performance. `eligible: true` models that
don't appear in any leaderboard bucket simply aren't selected (insufficient data).

### Caching

The leaderboard is computed on first subagent call and cached until the analytics
data directory's mtime changes. No per-call recomputation.

### Relationship to existing leaderboard

The existing global leaderboard (`analysis/scripts/leaderboard.ts`) is unchanged.
It continues to serve the analytics dashboard with its CI-lower-bound composite
ranking. The new stratified leaderboard is a separate artifact used only by the
subagent extension.

## What gets replaced

| Old | New |
|-----|-----|
| `model-profiles.yaml` capability scores | Simple model config (YAML: eligible, thinking, disabled_reason, cost) |
| `model-selection.ts` (`computeFitness`, `selectModel`) | Bucket selector (bucket hint → random pick from leaderboard entries) |
| `model-scoring-methodology.md` | Historical reference |
| Per-task `taskScores` parameter | Per-task `bucket` hint parameter (`small`/`medium`/`frontier`) |

## What stays

| Component | Fate |
|-----------|------|
| `pricing.ts` | Kept — cost is a leaderboard dimension |
| `models.json` | Kept — pricing data source |
| `analysis/scripts/leaderboard.ts` | Unchanged |
| `model-resolution.ts` | Unchanged |
| `runner.ts` | Unchanged |
| `modes.ts` | Minor changes for bucket hint parameter |
| `agents.ts` | Unchanged |
| `execute.ts` (`setupModelSelection`) | Rewired to load leaderboard instead of profiles |

## Temp fix (in place)

`model-selection.ts` now enforces `MIN_CAPABILITY_AGGREGATE = 10` — models with
`precision + creativity + thoroughness + reasoning < 10` are excluded from
selection. This removes GPT-4o (7), GPT-4.1 (8), GPT-5-mini (8),
devstral-small-2 (9), ministral-3 (9) while keeping Haiku 4.5 (10) and
Flash (10).

Remove this guard when the v2 leaderboard is operational.

## Resolved decisions

- **Bucket hint, not taskScores** — main agent provides `small`/`medium`/`frontier`
  per task, not per-dimension taskScores. Mental model: Haiku/Sonnet/Opus tiers,
  vendor-neutral names. Each `TaskItem`/`ChainItem` carries its own `bucket` field.
- **Data source: main-agent runs** — the leaderboard draws primarily from `RunSnapshot`
  records (main-agent outcomes). Subagent-specific metrics supplement later.
- **Complexity score: 6 signals, equal weights** — line mutations, touched file count,
  tool call count, busy duration, verification count, input tokens.
  Subagent task scores signal removed (no longer exists in v2).
  Percentile-normalized against the current analytics store (recalculated each time),
  averaged. Tunable with data. **(Revised 2026-06-13)**
- **Point estimates, no CI lower bounds** — trust raw means/proportions. No per-model
  minimum run count. Global 40-run bootstrap gate is sufficient.
- **Thinking levels as separate entries** — `modelId::thinkingLevel` is the leaderboard
  key. Same model at different thinking levels can appear in different buckets.
- **Uniform random selection** — within a bucket, all entries have equal selection
  probability. Ranking determines membership, not selection weight.
- **No quality floor** — trust ranking + fallback to current active model.
- **Relative tercile boundaries** — recalculated on each leaderboard computation.
- **Two-stage leaderboard ranking** — first rank by quality composite (6 dims:
  satisfaction, resolution rate, first-attempt success, tool reliability,
  verification adoption, token efficiency — equal weights). Then within each
  quality tier (top/bottom half), re-rank by cost. This separates quality and
  cost concerns. **(Added 2026-06-13)**
- **Best band = highest absolute composite score** — for entries appearing in
  multiple complexity bands, the band with the highest absolute composite outcome
  score wins.
- **Simple model config: YAML** — id, eligible, thinking (supported levels),
  disabled_reason, cost (fallback when models.json pricing is unavailable).
  This is the single authority for subagent-related model metadata.
  `pricing.ts` continues to read `models.json` for real token pricing.
  **(Revised 2026-06-13)**
- **Config is eligibility authority** — `eligible: false` overrides leaderboard.
  No automatic data-driven exclusion — bad models are manually disabled when
  they prove problematic.
- **Hard schema break** — `taskScores` replaced by `bucket` + optional `thinkingLevel`
  everywhere (tool schema, agent frontmatter, types). No compatibility layer.
  **(Added 2026-06-13)**

## Open questions for implementation

- ~~Cost efficiency dimension weight in the composite score~~ → resolved: two-stage ranking
- ~~Leaderboard composite weights~~ → resolved: 6 equal quality weights + cost tier re-rank
