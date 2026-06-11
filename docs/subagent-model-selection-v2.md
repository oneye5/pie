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

Instead of per-call `taskScores` (precision, creativity, thoroughness, reasoning),
the main agent provides a single **bucket hint**: `small`, `medium`, or `frontier`.

### Stratified leaderboard

A new leaderboard lives in `extensions/subagent/` and computes on-demand from
the analytics data store (JSONL + checkpoint files). It:

1. **Computes a per-run task complexity score** (0–1) from observable heuristics:
   `lineMutationTotal`, `touchedFileCount`, `toolCallCount`, `busyDurationMs`,
   `subagentCompositeMean`, `verificationTotalCount`, `inputTokens`. Each
   normalized to 0–1 via percentile rank, equal weights, averaged.

2. **Splits runs into complexity terciles** (low / medium / high).

3. **Computes outcome scores per complexity band** using point estimates (raw
   means/proportions, not CI lower bounds):
   - Satisfaction (1–5 mean)
   - Resolution rate (0–1 mean)
   - First-attempt success (0–1 proportion)
   - Tool reliability (0–1 proportion)
   - Verification adoption (0–1 proportion)
   - Token efficiency (median, inverted)
   - **Cost efficiency** (output value per USD, using `models.json` pricing)

4. **Ranks models within each complexity band** by composite score.

5. **Assigns fixed slots to buckets**:
   - High-complexity band: top 3 → **frontier** bucket
   - Medium-complexity band: top 4 → **medium** bucket
   - Low-complexity band: top 5 → **small** bucket

A model appears in only its best band's bucket (no dual membership).

### Selection at call time

When the main agent invokes the subagent tool with a bucket hint:

1. Look up the bucket → get ranked model list
2. Pick uniformly at random from all models in that bucket
3. Apply thinking-level filter from the simple model config
4. Pass model override to the runner (same as today)

### Bootstrapping

The subagent tool refuses to run until **40 scored runs** exist in the analytics
store. Message: "Subagent model selection is calibrating. Continue working with
the main agent to build the performance baseline (X/40 scored runs)."

Main-agent runs seed the leaderboard naturally during normal use.

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
| `model-profiles.yaml` capability scores | Simple model config (eligible, thinking, disabled_reason, cost) |
| `model-selection.ts` (`computeFitness`, `selectModel`) | Bucket selector (bucket hint → random pick from bucket) |
| `model-scoring-methodology.md` | Historical reference |
| Per-call `taskScores` parameter | Single `bucket` hint parameter |

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

## Open questions for implementation

- Complexity signal weights (starting with equal, tune with data)
- Cost efficiency dimension formula and weight
- Leaderboard composite weights (reuse existing or re-tune?)
- Simple model config format (JSON, YAML, or TypeScript module?)
