# Subagent Model Selection v2

Status: **Designed** (2026-06-13, grilling session)

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
the main agent provides a **bucket hint** (`small`, `medium`, or `frontier`) per task
and an optional **thinkingLevel hint** (`minimal`, `low`, `medium`, `high`, `xhigh`).
Each `TaskItem` / `ChainItem` carries its own `bucket` and optional `thinkingLevel`
field, replacing `taskScores` at the same granularity.

The thinkingLevel hint preserves the caller's ability to request specific thinking
effort. When omitted, no thinking level is passed — the model uses its default
thinking behavior.

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

The stratified ranker lives in the analytics module (`analysis/scripts/stratified-ranker.ts`)
and computes on-demand from the analytics data store (JSONL + checkpoint files). It:

1. **Computes a per-run complexity score** (0–1) from 6 observable heuristics with
   equal weights:
   - `fileMutation.lineAdditions + lineDeletions + lineModifications` (total line mutations)
   - `fileMutation.touchedFileCount`
   - `toolUsage.totalCount`
   - `busyDurationMs`
   - `verification.totalCount`
   - `inputTokens`
   Each normalized to 0–1 via percentile rank against all runs in the current
   analytics data directory (recalculated on each computation), equal weights.

2. **Splits runs into complexity terciles** (low / medium / high).

3. **Computes outcome scores per complexity band** using point estimates (raw
   means/proportions, not CI lower bounds):
   - Satisfaction (1–5 mean)
   - Resolution rate (0–1 mean)
   - First-attempt success (0–1 proportion)
   - Tool reliability (0–1 proportion)
   - Verification adoption (0–1 proportion)
   - Token efficiency (median, inverted)

4. **Two-stage ranking within each band**:
   - Stage 1: rank by quality composite (6 dimensions above, equal weights)
   - Stage 2: within each quality tier (top/bottom half), re-rank by cost
     (using `models.json` pricing via `pricing.ts`)

5. **Assigns models to buckets** — models with ≥1 scored run in a complexity band
   are eligible. Each model appears in only its best band's bucket, where "best band"
   is the band with the highest absolute composite outcome score.

### Architecture

```
Subagent Extension                          Analytics Module
─────────────────                          ────────────────
bucket-selector.ts  ──calls──►  bridge.ts  ──calls──►  stratified-ranker.ts
(selection API:               (in-memory                (complexity scoring,
 filters, picks,              interface,                outcome ranking,
 fallback)                    stateless)                bucket assignment)
```

- **`extensions/subagent/bucket-selector.ts`** — selection API. Receives bucket hint +
  optional thinkingLevel, calls bridge for raw assignments, filters by thinkingLevel +
  provider allowlist + excludeModels, picks uniformly at random. Handles fallback to
  active model. Exposes `selectModel(bucket, thinkingLevel?, excludeModels?) → SelectionResult`.
- **`extensions/subagent/bridge.ts`** — in-memory interface. Stateless pass-through
  (no caching). Decouples the subagent extension from the analytics module's internals.
  Exposes `getBucketAssignments() → BucketAssignments`.
- **`analysis/scripts/stratified-ranker.ts`** — all computation: complexity scoring,
  outcome ranking, bucket assignment. Lives in the analytics module alongside the
  existing global leaderboard (`leaderboard.ts`, unchanged). Exposes
  `computeBucketAssignments(analyticsDir, modelConfig) → BucketAssignments`.

**`BucketAssignments`** maps bucket names to ranked model IDs:
```ts
{ small: string[], medium: string[], frontier: string[] }
```
The arrays are ordered by composite score (best first). The selector picks
uniformly at random from the filtered array.

**`BucketSelection`** is what `selectModel()` returns:
```ts
interface BucketSelection {
  modelId: string;
  thinkingLevel?: ThinkingLevel;  // caller-specified, may be undefined
  bucket: string;                   // which bucket was used
  pool: string[];                   // all models in the filtered bucket (diagnostic)
  fallback: boolean;                // true if active model fallback was used
}
```
The `pool` field replaces the current `fitScores` — diagnostic only, not used
for selection weighting.

### Selection at call time

When the main agent invokes the subagent tool with a bucket hint:

1. `setupModelSelection()` loads the simple model config + builds provider allowlists.
   The resulting `SelectionContext` contains:
   ```ts
   { modelConfig: SimpleModelConfig[], disabledProviders: Set<string>, allowedModelIds: Set<string> }
   ```
   No bucket assignments are preloaded.
2. Per task: `bucketSelector.selectModel(bucket, thinkingLevel?, excludeModels?)` is called.
3. The selector calls `bridge.getBucketAssignments()` — bridge calls stratified ranker.
4. Filter by thinkingLevel if provided (exclude models that don't support that level
   per the simple config). If no models remain, relax to the nearest supported thinking
   level with a diagnostic log.
5. Filter by provider allowlist + excludeModels set.
6. Pick uniformly at random from remaining entries.
7. If bucket is empty (no qualifying models), return the active model as fallback.
   The subagent always has a usable model.

### Retry logic

Keep `MAX_MODEL_RETRIES = 5`. On failure, retry with the same bucket but exclude
the failed model via `excludeModels`. If the bucket is exhausted, fall back to
the active model.

### Bootstrapping

The ranker returns empty bucket assignments until **40 scored runs** exist in the
analytics store. Every subagent call during bootstrap falls back to the active model.
No progress diagnostic is shown — the fallback is transparent to the caller.

Main-agent runs seed the leaderboard naturally during normal use.

### Simple model config

`model-profiles.yaml` (same filename, same location) with a new schema:

```yaml
- id: claude-sonnet-4.6
  eligible: true
  thinking: [low, medium, high, xhigh]
  disabled_reason: null
  cost: 10  # fallback when models.json pricing unavailable

- id: gpt-5-mini
  eligible: false
  disabled_reason: "repeated tool failures in subagent mode"
  thinking: [low, medium]
  cost: 5
```

Five fields only: `id`, `eligible`, `thinking`, `disabled_reason`, `cost`.

- **Config is eligibility authority** — `eligible: false` overrides leaderboard.
  No automatic data-driven exclusion. Bad models are manually disabled.
- Models in analytics data but not in the config are **included** (treated as eligible).
  A warning is raised — this should never happen in practice.
- `models.json` stays as the pricing authority. `pricing.ts` is unchanged.

### Schema migration

Hard break — no compatibility layer:

- `taskScores` → `bucket` + optional `thinkingLevel` everywhere:
  tool schema (`SubagentParams`, `TaskItem`, `ChainItem`), types (`SingleResult`),
  agent frontmatter
- `defaultScores: precision=3,reasoning=4` → `bucket: medium, thinkingLevel: high`
  in agent frontmatter
- Agent `AgentConfig` interface: `defaultScores` field removed, `bucket` +
  `thinkingLevel` added
- Unit test enforcing no repo-level agents use `defaultScores` after migration

### Caching

No caching. The stratified ranker computes on every invocation. The computation
is lightweight enough that caching complexity isn't worth it.

### Analytics directory discovery

The bridge passes the analytics directory path to the stratified ranker.
The directory is resolved by the subagent extension at startup from the pi config
(the same config that defines providers in `models.json`). The path is stored in
`SelectionContext` alongside the model config and allowlists.

The stratified ranker reads JSONL + checkpoint files from that directory.
If the directory is missing or empty, the ranker returns empty bucket assignments
(same as bootstrap — fall back to active model).

### Relationship to existing leaderboard

The existing global leaderboard (`analysis/scripts/leaderboard.ts`) is unchanged.
It continues to serve the analytics dashboard with its CI-lower-bound composite
ranking. The stratified ranker is a separate artifact used only by the subagent
extension.

## What gets replaced

| Old | New |
|-----|-----|
| `model-profiles.yaml` capability scores | Same file, new schema (eligible, thinking, disabled_reason, cost) |
| `model-selection.ts` (`computeFitness`, `selectModel`, `reasoningToThinking`) | `bucket-selector.ts` + `bridge.ts` (selection API) |
| `model-scoring-methodology.md` | Historical reference |
| Per-task `taskScores` parameter | Per-task `bucket` + optional `thinkingLevel` hint |
| `MIN_CAPABILITY_AGGREGATE` temp guard | `eligible: false` in config (manual) |
| `execute.ts` `setupModelSelection` | Simplified: load config + allowlists only |
| Agent frontmatter `defaultScores` | `bucket` + optional `thinkingLevel` |
| `analysis/` — nothing | `analysis/scripts/stratified-ranker.ts` (new) |

## What stays

| Component | Fate |
|-----------|------|
| `pricing.ts` | Unchanged — cost for stratified ranking |
| `models.json` | Unchanged — pricing data source |
| `analysis/scripts/leaderboard.ts` | Unchanged — global dashboard leaderboard |
| `model-resolution.ts` | Unchanged |
| `runner.ts` | Minor — receives `BucketSelection` (modelId + optional thinkingLevel) instead of `modelOverride` + `thinkingLevel` from the old selector |
| `modes.ts` | Minor changes — passes bucket+thinkingLevel |
| `agents.ts` | Schema change — `defaultScores` field removed, `bucket` + `thinkingLevel` added to `AgentConfig`. `parseDefaultScores()` replaced with `parseBucketAndThinking()` |
| Provider toggle logic (`PROVIDER_TOGGLES_ENV`, `parseProviderToggles`) | Unchanged |

## Temp fix (in place)

`model-selection.ts` currently enforces `MIN_CAPABILITY_AGGREGATE = 10` — models with
`precision + creativity + thoroughness + reasoning < 10` are excluded from
selection. This removes GPT-4o (7), GPT-4.1 (8), GPT-5-mini (8),
devstral-small-2 (9), ministral-3 (9) while keeping Haiku 4.5 (10) and
Flash (10).

Remove this guard when the v2 system is operational.

## Resolved decisions

- **Bucket hint + optional thinkingLevel, not taskScores** — main agent provides
  `small`/`medium`/`frontier` per task, not per-dimension taskScores. Optional
  `thinkingLevel` hint (`minimal`/`low`/`medium`/`high`/`xhigh`) for explicit
  thinking control. When omitted, no thinking level is passed — the model uses
  its default.
- **Caller-driven thinking levels** — thinking level is always caller-specified,
  not baked into leaderboard entries. If the requested level is unsupported by
  all models in the bucket, relax to the nearest supported level with a diagnostic.
- **Per-model leaderboard entries** — entries are per-model (`modelId` only), not
  per `modelId::thinkingLevel`. The leaderboard aggregates performance across all
  thinking levels used with that model.
- **Data source: main-agent runs** — the leaderboard draws primarily from
  `RunSnapshot` records (main-agent outcomes). Subagent-specific metrics
  supplement later.
- **Complexity score: 6 signals, equal weights** — line mutations, touched file
  count, tool call count, busy duration, verification count, input tokens.
  Percentile-normalized against the current analytics store, averaged.
- **Point estimates, no CI lower bounds** — trust raw means/proportions. No
  per-model minimum run count except the global 40-run bootstrap gate.
- **Two-stage leaderboard ranking** — first rank by quality composite (6 dims:
  satisfaction, resolution rate, first-attempt success, tool reliability,
  verification adoption, token efficiency — equal weights). Then within each
  quality tier (top/bottom half), re-rank by cost.
- **Uniform random selection** — within a bucket, all entries have equal selection
  probability. Ranking determines membership, not selection weight.
- **No quality floor** — trust ranking + fallback to active model.
- **Relative tercile boundaries** — recalculated on each leaderboard computation.
- **Best band = highest absolute composite score** — for entries appearing in
  multiple complexity bands, the band with the highest absolute composite outcome
  score wins.
- **Simple model config: YAML** — 5 fields: `id`, `eligible`, `thinking`,
  `disabled_reason`, `cost`. Same filename (`model-profiles.yaml`), same location.
  `pricing.ts` continues to read `models.json` for real token pricing.
- **Config is eligibility authority** — `eligible: false` overrides leaderboard.
  No automatic data-driven exclusion. Models in analytics data but not in config
  are included with a warning.
- **Hard schema break** — `taskScores` replaced by `bucket` + optional
  `thinkingLevel` everywhere. No compatibility layer.
- **40-run bootstrap gate** — ranker returns empty until 40 scored runs exist.
  Every subagent call falls back to active model during bootstrap.
- **No caching** — stratified ranker computes on every invocation. Bridge is
  stateless pass-through.
- **Three-file split** — `bucket-selector.ts` (selection API) → `bridge.ts`
  (decoupling interface) → `stratified-ranker.ts` (computation, in analytics module).
  `model-selection.ts` is deleted.
- **Stratified ranker in analytics module** — `analysis/scripts/stratified-ranker.ts`
  alongside the existing `leaderboard.ts`.
- **Retry: MAX_MODEL_RETRIES = 5** — retry with excludeModels. Fall back to active
  model when bucket exhausted.
- **Agent frontmatter: manual migration** — `defaultScores` → `bucket` +
  `thinkingLevel`. Repo-level unit test to enforce.
- **`reasoningToThinking()` removed** — no longer needed.

## Open questions for implementation

- None remaining from original plan. All prior open questions resolved during
  2026-06-13 grilling session.
