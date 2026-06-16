# Model Scoring Methodology

> **Status: Transitioning to historical reference.** The capability scores defined
> here drive the current fitness-based selector (`computeFitness` / `selectModel`).
> This will be replaced by a data-driven stratified leaderboard — see
> [`subagent-model-selection-v2.md`](subagent-model-selection-v2.md) for the
> target design. Capability scores remain active until that migration is complete.

Last updated: 2026-05-16

## Purpose

This document defines the process for assigning capability scores
(`precision`, `creativity`, `thoroughness`, `reasoning`) to models in
`model-profiles.yaml`. These scores drive the subagent model selector
(`extensions/subagent/model-selection.ts`), which matches task requirements
to model capabilities via an asymmetric fitness function.

**Cost** scores have a separate, well-grounded methodology documented in
`internal/copilot-model-pricing.md` and `internal/ollama-pro-cloud-models-ranked.md`.
This document covers the four capability dimensions only.

## How scores are consumed

The fitness function (see `computeFitness()`) uses scores as follows:

- **Capped base reward**: `min(model, task) × task` — only task-relevant
  capability counts
- **Overkill penalty**: `1.5 × max(0, model − task)` — excess capability
  is penalized
- **Deficit penalty**: `2.0 × max(0, task − model)²` — missing capability
  is strongly penalized (quadratic)
- **Cost subtraction**: `0.5 × cost` — cheaper models preferred when
  fitness is comparable. When `profile.cost` is absent, the code falls
  back to `sum(precision + creativity + thoroughness + reasoning)` as
  the cost value. All current models have explicit cost fields.

This means:
- **A 1-point score difference matters.** A model at 3 vs. a task needing
  4 incurs a penalty of 2.0 × 1² = 2.0. A model at 3 vs. task needing 5
  incurs 2.0 × 4 = 8.0.
- **Clustering kills discrimination.** If 10 models all score 4/3/4/4,
  the selector chooses purely on cost. Scores must spread models across
  the 0–5 range to be useful.
- **Overkill is real.** A 5-scored model on a 2-scored task loses
  1.5 × 3 = 4.5 points per dimension. Over-scoring a model hurts it
  on easy tasks.

### Thinking-level filtering

Before fitness scoring, models are filtered by `thinking` level support.
The reasoning task score maps to a thinking level via `reasoningToThinking()`:

| Reasoning score | Thinking level |
|---|---|
| 0 | minimal |
| 1–2 | low |
| 3 | medium |
| 4 | high |
| 5 | xhigh |

A model is **excluded** from selection if it doesn't include the required
thinking level in its `thinking` array. This means:

- A model's reasoning score and its thinking array must be **coherent**.
  A model with reasoning=5 but thinking=[medium] can only be selected
  for reasoning=3 tasks, where its reasoning=5 then incurs overkill
  penalty. This is by design for models like Opus 4.7 whose provider
  restricts thinking levels — the model genuinely has frontier reasoning
  capability but can only apply it at medium thinking effort.
- When scoring reasoning, consider both raw capability AND practical
  accessibility via thinking levels. The score reflects capability;
  the thinking array constrains when that capability is available.
- A model with strong reasoning but limited thinking levels will
  still be selected for tasks whose requested thinking level it supports,
  where it may provide value (at the cost of some overkill penalty).

### Task-score rubric for callers

`model-profiles.yaml` scores describe model capability. Caller `taskScores`
should describe the **minimum capability actually needed**. To avoid
expensive overkill selections:

- Start from `2` on every dimension, but note that `reasoning` is
  special: omitting it also means `2`, which requests **low** thinking.
- Use `reasoning: 0` for direct/shallow work when minimal-thinking models
  should remain eligible.
- Raise to `3` for normal professional work that genuinely depends on
  that dimension.
- Use `4` only for unusually hard, high-risk, or highly interdependent
  work.
- Use `5` only for rare frontier-difficulty cases on that dimension.
- Score objective task difficulty — not business importance, urgency, or
  the caller's uncertainty.

## Dimension definitions

Each dimension measures a specific capability **as observed in agentic coding
tasks** (not general knowledge or chat). Scores are relative to the pool of
models in `model-profiles.yaml`, not absolute.

### Precision

> *How reliably does the model produce correct, compilable, specification-conforming output on the first attempt?*

- Measures: code correctness, test pass rate, instruction adherence,
  syntactic validity, absence of hallucinated APIs
- Does NOT measure: cleverness, completeness, or reasoning depth
- A high-precision model generates code that compiles and passes tests
  without iteration. A low-precision model frequently needs corrections.

### Creativity

> *How well does the model handle novel problems that require non-obvious solutions?*

- Measures: ability to synthesize approaches from different domains,
  generate non-templated solutions, handle ambiguous/open-ended requirements
- Does NOT measure: correctness or thoroughness
- A high-creativity model proposes inventive solutions to unprecedented
  problems. A low-creativity model sticks to well-known patterns and
  struggles when patterns don't apply.
- **This is the hardest dimension to benchmark.** Weight qualitative
  assessment more heavily than benchmarks here.

### Thoroughness

> *How exhaustive and complete is the model's output?*

- Measures: edge case coverage, multi-file awareness, handling of all
  specified requirements, test comprehensiveness, attention to detail
- Does NOT measure: correctness of what it does cover, or speed
- A high-thoroughness model handles corner cases, writes comprehensive
  tests, and considers cross-cutting concerns. A low-thoroughness model
  addresses the happy path only.

### Reasoning

> *How well does the model handle problems requiring multi-step logical deduction?*

- Measures: chain-of-thought depth, ability to decompose complex problems,
  logical consistency across steps, abstract problem-solving
- Does NOT measure: speed or breadth of coverage
- A high-reasoning model solves problems requiring 5+ logical steps and
  maintains consistency. A low-reasoning model handles direct/shallow tasks
  but breaks down on multi-step logic.
- Also determines the `--thinking` level passed to the pi CLI (see
  `reasoningToThinking()` mapping).

## Score rubric (0–5)

Scores are **relative to the model pool**. Level 3 is the median eligible
model. At least ~20% of models should fall into each of the 1–2, 3, and
4–5 bands for each dimension.

| Level | Label | Behavioral indicator |
|-------|-------|---------------------|
| 0 | Unusable | Output is structurally broken; not useful for any variant of the dimension |
| 1 | Very poor | Occasionally produces something relevant, but unreliable even for trivial tasks |
| 2 | Below average | Works for simple cases; falls apart on moderate complexity |
| 3 | Adequate | Meets requirements for typical tasks; occasional misses on hard ones |
| 4 | Strong | Reliably good; handles complex cases with rare failures |
| 5 | Best-in-class | Top ~10% of the pool; excels even on the hardest tasks for this dimension |

**Distribution check**: after scoring, verify each dimension has reasonable
spread. If >50% of eligible models share the same score on a dimension,
the scores are too clustered and should be revisited.

## Benchmark proxy map

Use these benchmarks as **initial signals**, not direct translations.
Benchmarks measure specific slices of each dimension; real-world agentic
performance can diverge.

Boundary convention for all tables: lower bound inclusive, upper bound
exclusive (e.g., "65–80%" means ≥65% and <80%).

### Precision

| Benchmark | Weight | Notes |
|-----------|--------|-------|
| SWE-bench Verified (resolve rate) | Primary | Real GitHub issues; measures end-to-end code correctness |
| LiveCodeBench (pass@1) | Secondary | Competitive programming; measures algorithmic correctness |
| IFEval (instruction following) | Supporting | Measures spec adherence; less code-specific |

**Score mapping** (SWE-bench Verified, best available agent scaffold):

| SWE-V resolve rate | Suggested score |
|---------------------|-----------------|
| <45% | 1 |
| 45–55% | 2 |
| 55–65% | 3 |
| 65–80% | 4 |
| ≥80% | 5 |

### Creativity

| Benchmark | Weight | Notes |
|-----------|--------|-------|
| ARC-AGI-2 | Primary | Abstract reasoning on novel visual puzzles; closest proxy to creative problem-solving |
| Qualitative assessment | Co-primary | Solution diversity, non-obvious approaches in real usage |

**Score mapping** (ARC-AGI-2):

| ARC-AGI-2 score | Suggested score |
|------------------|-----------------|
| <15% | 1 |
| 15–30% | 2 |
| 30–50% | 3 |
| 50–70% | 4 |
| ≥70% | 5 |

**Note**: ARC-AGI-2 coverage is limited. When unavailable, use qualitative
assessment anchored to reference models (see Anchor Models below).

### Thoroughness

| Benchmark | Weight | Notes |
|-----------|--------|-------|
| SWE-bench Pro (resolve rate) | Primary | Multi-file, complex changes; measures completeness |
| Terminal-Bench | Secondary | Multi-step autonomous tasks; measures end-to-end coverage |

**Score mapping** (SWE-bench Pro):

| SWE-Pro resolve rate | Suggested score |
|-----------------------|-----------------|
| <25% | 1 |
| 25–32% | 2 |
| 32–40% | 3 |
| 40–50% | 4 |
| ≥50% | 5 |

### Reasoning

| Benchmark | Weight | Notes |
|-----------|--------|-------|
| GPQA Diamond | Primary | PhD-level science reasoning; best discriminator among frontier models |
| AIME 2026 | Secondary | Competition math; multi-step deduction |
| HLE (text-only) | Supporting | Frontier reasoning ceiling; useful for separating top-tier models |

**Score mapping** (GPQA Diamond):

| GPQA Diamond score | Suggested score |
|--------------------|-----------------|
| <75% | 1 |
| 75–82% | 2 |
| 82–88% | 3 |
| 88–93% | 4 |
| ≥93% | 5 |

## Fallback: parameter-tier heuristic

For models without benchmark data, use parameter count and model family as
a rough starting point, then adjust when benchmarks or usage data become
available.

| Model class | Default score range | Rationale |
|-------------|-------------------:|-----------|
| Dense <10B | 1 across all dims | Too small for reliable agentic work |
| Dense 10–30B | 2 across all dims | Basic capability, limited reasoning |
| Dense/MoE 30–120B | 2–3, dimension-dependent | Moderate capability; check family benchmarks |
| MoE 200B+ active >30B | 3–4, dimension-dependent | Frontier-adjacent; benchmark data usually exists |
| Frontier (Opus, GPT-5.x, Gemini 3.x Pro) | 4–5, dimension-dependent | Must have benchmark data; don't default |

These are **starting points only**. Always replace with benchmark-grounded
scores when data is available.

## Anchor models

Three reference models pin the scale. Their scores are considered stable
and other models are scored relative to them.

### GPT-4o — Low anchor (free tier baseline)

```yaml
precision: 2, creativity: 2, thoroughness: 2, reasoning: 1
```

**Justification**: GPT-4o is a non-reasoning model included at zero cost.
It handles simple tasks adequately but struggles with anything requiring
multi-step logic, multi-file changes, or creative problem-solving.
SWE-bench Verified ~48%. No reasoning/thinking support. This is the
baseline for "a model that barely qualifies for subagent work."

### Claude Sonnet 4.6 — Mid anchor (strong workhorse)

```yaml
precision: 4, creativity: 3, thoroughness: 4, reasoning: 4
```

**Justification**: Sonnet 4.6 is the most widely-used coding model in the
pool. SWE-bench Verified ~72%. GPQA Diamond ~89%. Reliably correct and
thorough on typical tasks. Creativity is adequate but not exceptional —
it follows patterns well but doesn't excel at unprecedented problems.
Strong reasoning with thinking support up to xhigh.

**Calibration note**: The 2026-05-16 recalibration lowered creativity
from 4→3 (no ARC-AGI-2 data; pattern-following in practice) and
reasoning from 5→4 (GPQA ~89% falls in the 88–93% band = score 4).

### Claude Opus 4.8 — High anchor (top tier)

```yaml
precision: 5, creativity: 4, thoroughness: 5, reasoning: 5
```

**Justification**: Opus 4.8 is the most expensive and capable model.
SWE-bench Verified ~87.6%. GPQA Diamond ~94.2% (claimed). Excels at
precision and thoroughness on complex multi-file tasks. Creativity is
strong but not perfect — it's more methodical than inventive. Reasoning
is best-in-class with extended thinking. Cost (30) already penalizes it
heavily; capability scores should reflect actual capability, not cost.

**Thinking interaction**: Opus 4.8 has thinking=[medium], so despite
reasoning=5 it can only be selected for tasks with reasoning=3. On those
tasks its reasoning=5 incurs overkill penalty (1.5x2). This is
intentional - the model is genuinely capable but provider-constrained.
The high cost (30) plus overkill already limits it to tasks where quality
justifies the expense.

**Availability note**: Opus 4.8 is eligible in local PI config and was
verified with a direct PI smoke test after refreshing GitHub Copilot OAuth
credentials on 2026-06-04.

## Scoring process for new models

1. **Collect benchmark data.** Check SWE-bench, LiveCodeBench, GPQA
   Diamond, AIME 2026, ARC-AGI-2 from independent evaluators (Artificial
   Analysis, Vals AI, MathArena, SWE-bench leaderboard). Prefer
   independent evaluations over vendor self-reports.

2. **Map benchmarks to initial scores** using the proxy tables above.
   Record the benchmark values used.

3. **Cross-check against anchors.** Compare the new model's scores to the
   three anchor models. Ask: "Is this model really better/worse than
   Sonnet 4.6 at precision? By how much?" Adjust if the benchmark mapping
   produces an implausible relative ranking.

4. **Apply qualitative adjustments (±1 max).** If personal experience or
   credible third-party reports strongly contradict the benchmark signal,
   adjust by at most 1 point. Document the reason with a † mark in the
   justification table.

5. **Check distribution.** After adding the model, verify no dimension has
   >50% of eligible models at the same score. If clustering occurs,
   re-examine the clustered models for differentiating signals.

6. **Document the justification.** Update the score justification table
   (below) with the benchmark data and any qualitative adjustments.

## Adjusting existing scores

Scores should be revisited when:

- New independent benchmark results are published
- A model is observed to consistently over/under-perform its scores in
  real subagent tasks
- A new model generation makes the relative ranking stale
- Distribution check reveals excessive clustering

**Process**:
1. Identify the trigger (new data, observed behavior, distribution issue)
2. Compare current score to benchmark proxy table
3. Compare to anchor models (unchanged? if anchor models themselves need
   updating, that's a bigger recalibration event)
4. Propose new score with justification
5. Run `npm run test -- --package subagent` to verify no test regressions

## Score justification table

This table shows the **current live scores** in `model-profiles.yaml`.
All eligible models are included.

Qualitative adjustments (±1 from benchmark proxy) are marked with † and
explained in the notes column.

<!-- When updating YAML scores, update this table too. -->

| Model | P | C | T | R | Key evidence | Notes |
|-------|---|---|---|---|-------------|-------|
| claude-opus-4.8 | 5 | 4 | 5 | 5 | SWE-V 87.6%→5, GPQA 94.2%*→5 | **Anchor: high.** thinking=[medium]. Verified available through PI after Copilot OAuth refresh on 2026-06-04 |
| claude-opus-4.7 | 5 | 4 | 5 | 5 | SWE-V 87.6%→5, GPQA 94.2%*→5 | **Anchor: high.** thinking=[medium] limits selection to reasoning=3 tasks. Methodical > inventive |
| claude-opus-4.6 | 4 | 4 | 4 | 5 | SWE-V 80.8%→5†, GPQA 91.3%→4† | †P: proxy says 5, scored 4 (SWE-V at boundary; 80.8% barely ≥80%). †R: proxy says 4, scored 5 (AIME 2026 ~98.2% + thinking=[xhigh] justifies +1) |
| claude-sonnet-4.6 | 4 | 3 | 4 | 4 | SWE-V ~72%→4, GPQA ~89%→4 | **Anchor: mid.** C: no ARC-AGI-2 data; pattern-following in practice. R: GPQA 89% = score 4 per proxy |
| claude-sonnet-4.5 | 4 | 3 | 4 | 4 | SWE-V ~68%→4, GPQA ~87%→3† | †R: proxy says 3, scored 4 (same family as Sonnet 4.6 with thinking=[high]; marginal +1) |
| claude-haiku-4.5 | 3 | 2 | 2 | 3 | SWE-V ~52%→2†, GPQA ~80%→2† | †P: proxy says 2, scored 3 (adequate on simple tasks despite low SWE-V). †R: proxy says 2, scored 3 (thinking=[medium] provides usable reasoning). T: speed-optimized, thin coverage |
| gpt-5.5 | 5 | 4 | 5 | 5 | SWE-V 88.7%→5, GPQA ~93%→4† | †R: proxy says 4, scored 5 (AIME 2026 top scorer + thinking=[xhigh]; +1). C: strong but not ARC-AGI-2 leader |
| gpt-5.4 | 4 | 3 | 4 | 5 | AIME ~99%, GPQA 92.8%→4† | †R: proxy says 4, scored 5 (AIME 2026 leader at ~99% + thinking=[xhigh]; +1). T: no SWE-Pro data; scored 4 from general coding performance |
| gpt-5.4-mini | 3 | 2 | 3 | 3 | Scaled-down 5.4; limited benchmarks | Parameter-tier + family heuristic. Mini models score lower across all dims |
| gpt-5.3-codex | 4 | 2 | 4 | 4 | SWE-V ~69%→4, SWE-Pro 56.4%→5†, LiveCode 71.2% | P: SWE-V ~69% = score 4 per proxy. †T: proxy says 5, scored 4 (SWE-Pro leader, but −1 for code-specialized narrow scope). C: code-specialized pattern-follower |
| gpt-5.2-codex | 4 | 2 | 3 | 4 | SWE-V ~66%→4, GPQA 93.2%→5† | †R: proxy says 5, scored 4 (GPQA at boundary; older gen with less capable thinking than 5.4+; −1). C: code-specialized. T: less thorough than 5.3-codex |
| gpt-5.2 | 4 | 3 | 3 | 4 | SWE-V ~66%→4, GPQA 93.2%→5† | †R: proxy says 5, scored 4 (same rationale as 5.2-codex). T: adequate but not exhaustive |
| gpt-5-mini | 2 | 2 | 2 | 2 | Limited benchmarks | Free tier; better than 4o but still limited |
| gpt-4.1 | 2 | 2 | 2 | 2 | SWE-V ~50%→2 | Free tier; no reasoning/thinking support |
| gpt-4o | 2 | 2 | 2 | 1 | SWE-V ~48%→2 | **Anchor: low.** No thinking support |
| gemini-3.1-pro-preview | 4 | 5 | 4 | 5 | GPQA 94.1%→5, ARC-AGI-2 77.1%→5 | †P: no SWE-V data; scored 4 from family heuristic (frontier Gemini; +1 from tier-3 default). †T: scored 4 from strong multi-step performance (+1). Creativity leader |
| gemini-3-pro-preview | 4 | 4 | 3 | 4 | SWE-V ~63%→3†, GPQA ~88%→3† | †P: proxy says 3, scored 4 (mid-range SWE-V but qualitatively reliable; +1). †R: proxy says 3, scored 4 (reasoning in practice matches tier; +1) |
| gemini-3-flash-preview | 3 | 3 | 2 | 3 | Limited benchmarks | Flash-tier; speed-optimized. T: thin on edge cases |
| grok-code-fast-1 | 3 | 2 | 3 | 3 | Limited independent benchmarks | Code-focused; no creativity evidence |
| deepseek-v4-pro:cloud | 5 | 3 | 5 | 5 | LiveCode 93.5% (max), SWE-V high | Frontier open-source. C: methodical, not inventive |
| deepseek-v4-flash:cloud | 3 | 2 | 3 | 3 | Scaled-down v4-pro; 284B MoE (13B active) | Family heuristic; significantly smaller active params |
| gemini-3-flash-preview:cloud | 3 | 3 | 2 | 3 | Same underlying model as copilot flash | Should match copilot variant scores |
| gemma4:31b-cloud | 3 | 3 | 3 | 3 | 31B dense; limited benchmarks | Parameter-tier heuristic |
| qwen3.5:397b-cloud | 4 | 3 | 3 | 4 | AIME 91.3%, GPQA 88.4%→3† | †R: proxy says 3, scored 4 (AIME 91.3% + thinking=[xhigh] justifies +1). C/T: no strong evidence for 4 |
| qwen3.5:cloud | 3 | 3 | 2 | 3 | Smaller variant of 397b; mixed sizes | Size penalty; less thorough |
| qwen3-coder-next:cloud | 4 | 2 | 3 | 2 | 80B MoE (3B active); code-specialized | Very small active params limit all dims. †P: scored 4 despite code focus (−1 from proxy-5; tiny active params) |
| qwen3-coder:480b-cloud | 4 | 2 | 3 | 3 | 480B MoE (35B active); code-specialized | P: no SWE-V data to justify 5; scored 4 from family. T: no evidence for 4 |
| kimi-k2.7-code:cloud | 4 | 3 | 4 | 5 | Built on K2.6 with coding improvements | †R: scored 5 (inherits K2.6 reasoning + coding enhancements). P: code-focused but broad capability |
| kimi-k2.6:cloud | 4 | 4 | 4 | 5 | AIME 96.4%, GPQA ~91%→4† | †R: proxy says 4, scored 5 (AIME 96.4% + HLE 54.0% (tools) + thinking=[xhigh]; +1). Top open-weight model |
| kimi-k2.5:cloud | 4 | 3 | 3 | 4 | Earlier gen than k2.6; less data | Family heuristic; less thorough than k2.6 |
| nemotron-3-super:cloud | 3 | 3 | 3 | 3 | 120B MoE (12B active); limited benchmarks | Small active params; no data to justify 4s |
| glm-5:cloud | 4 | 3 | 4 | 4 | SWE-V ~75%→4, AIME ~93% | 744B MoE (40B active); similar tier to glm-5.1 |
| glm-5.1:cloud | 4 | 3 | 4 | 4 | SWE-V 77.8%→4, AIME 95.3%, GPQA 86.2%→3† | †R: proxy says 3, scored 4 (AIME 95.3% + thinking=[high] justifies +1). P: SWE-V 77.8% < 80% threshold = 4 |
| glm-4.7:cloud | 3 | 3 | 3 | 3 | 355B MoE (32B active); limited benchmarks | Older gen; heuristic scoring |
| gpt-oss:120b-cloud | 4 | 3 | 3 | 4 | 120B dense; limited benchmarks | Dense 120B justifies 4 on precision/reasoning |
| minimax-m2.1:cloud | 3 | 3 | 2 | 3 | 230B MoE (10B active); tools only | No thinking mode; heuristic scoring similar to m2.7 |
| minimax-m2.5:cloud | 3 | 3 | 3 | 4 | 230B MoE (10B active); tools+thinking | Family heuristic; similar to m2.7 with thinking mode |
| minimax-m2.7:cloud | 3 | 3 | 3 | 3 | 230B MoE (10B active); limited benchmarks | Small active params; heuristic scoring |

*Anthropic-claimed, pending independent verification

### 2026-05-16 recalibration highlights

This pass primarily:
- reduced clustered 4/5 scores where GPQA, SWE-bench Pro, or ARC-AGI-2 did not support them
- lowered creativity scores for strongly pattern-following models without evidence for higher novelty
- lowered thoroughness scores that had been defaulted to 4 without strong completeness evidence
- brought small-active-parameter flash/MoE variants closer to their observed coding capability
- raised `gemini-3.1-pro-preview` to better match its frontier benchmark profile

## Current distribution issues (2026-05-16)

Current YAML score distributions for eligible models **after** the
2026-05-16 recalibration:

| Score | Precision | Creativity | Thoroughness | Reasoning |
|-------|-----------|------------|--------------|----------|
| 1 | 0% | 0% | 0% | 2% |
| 2 | 7% | 38% | 21% | 14% |
| 3 | 36% | 48% | **52%** | 36% |
| 4 | **50%** | 12% | 19% | 31% |
| 5 | 7% | 2% | 7% | 17% |

Precision=4 now sits at the 50% border. Creativity=3 and reasoning are
back below the clustering threshold. Thoroughness=3 remains the main
remaining issue at 52%.

**Remaining issues**: Precision=4 is still borderline and thoroughness=3
remains above the 50% threshold. A second pass should identify which
precision=4 models could be differentiated to 3 or 5, and which
thoroughness=3 models have evidence to move to 2 or 4. This may require
additional benchmark data (SWE-bench Pro for thoroughness, SWE-bench
Verified for precision).

## Recalibration triggers

Schedule a full rescoring pass when:
- 3+ new frontier models are added in a batch
- An anchor model is superseded (e.g., Sonnet 4.6 replaced by 4.7 as mid
  anchor)
- >50% of eligible models share the same score on any dimension
- Subagent selection quality degrades noticeably in real usage

## Appendix: benchmark sources

| Benchmark | URL | Update frequency |
|-----------|-----|-----------------|
| SWE-bench Verified | https://swebench.com/verified | Per submission |
| SWE-bench Pro | https://swebench.com/ | Per submission |
| LiveCodeBench | https://livecodebench.github.io/ | Continuous |
| GPQA Diamond | https://artificialanalysis.ai/evaluations/gpqa-diamond | Per model release |
| AIME 2026 | https://matharena.ai/?comp=aime--aime_2026 | Per model release |
| ARC-AGI-2 | https://arcprize.org/leaderboard | Per submission |
| HLE | https://artificialanalysis.ai/evaluations/humanitys-last-exam | Per model release |
| Terminal-Bench | https://awesomeagents.ai/leaderboards/coding-benchmarks-leaderboard/ | Periodic |
