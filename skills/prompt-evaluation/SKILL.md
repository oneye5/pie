---
name: prompt-evaluation
description: Guides systematic prompt quality evaluation using metrics, golden sets, and automated regression. Use when measuring prompt quality, building evaluation harnesses, comparing prompt versions, or setting up CI-based prompt regression testing. Do not use for writing prompts or general code review.
---

# Prompt Evaluation

## Overview

Measuring prompt quality with numbers, not intuition. "This prompt seems good" is not evaluation — it's a bet. Evaluation makes every prompt change a measurable improvement or a measured regression. Without it, prompt iteration is gambling.

## When to Use

- Comparing two versions of a prompt to decide which to ship
- Building an automated evaluation pipeline for prompt changes
- Debugging why a prompt's quality degraded after a model update
- Setting up regression testing in CI for prompts
- Creating a golden set for systematic prompt testing
- Auditing prompt quality before production deployment

## Required Artifacts

- `analysis/eval/golden-set.json` — Curated test inputs with expected outputs
- `analysis/eval/scores.json` — Per-dimension scores for baseline and candidate
- `analysis/eval/report.md` — Comparison, regression analysis, ship/no-ship recommendation

## The Evaluation Pyramid

Build evaluation in layers. Each is cheaper per item than the one below and noisier than the one above. Mature teams run all five.

```
Layer 5: Production Observability     ← cheapest, catches unknown unknowns
Layer 4: Automated Regression (CI)    ← prevents silent regressions
Layer 3: LLM-as-Judge Scoring         ← scalable batch evaluation
Layer 2: Human Review (golden set)    ← defines what "good" means
Layer 1: Vibes (spot-check)           ← catches catastrophic failures only
```

**Never skip Layer 2.** If the team can't agree on what "good" looks like for 20-50 examples, no automated metric downstream will rescue the system.

### Layer 1 — Vibes Check

The author runs the prompt on 3-5 inputs and reads outputs. Only catches: no output, wrong language, infinite loops, obviously broken responses. Cost: near-zero. Signal: near-zero. Appropriate volume: enough to confirm the prompt runs at all. More than that is iteration theater.

### Layer 2 — Human Review on Golden Set

A person (author, domain expert, or small panel) scores each output against written criteria. Cost: minutes per item. Signal: gold standard. This is where you define correctness. Criteria must be written down — unspoken expectations produce uncalibrated scoring.

```
Example scoring rubric:
1. Correctness (1-5): Does the output achieve the task goal?
2. Faithfulness (1-5): Does it contain only facts from the context?
3. Helpfulness (1-5): Is it actionable and complete?
4. Conciseness (1-5): Is it direct, no filler?
```

### Layer 3 — LLM-as-Judge

Once criteria are stable, automate scoring with a judge model:

```
Prompt a stronger model with:
- The scoring rubric
- The input
- The output(s) under evaluation
- A strict JSON response schema

Run against the golden set. Score per dimension, aggregate.
```

**Judge calibration is mandatory.** Spot-check 5-10% of judge verdicts against human judgment weekly. When disagreement exceeds threshold, fix the judge prompt or rubric. An uncalibrated judge is confident noise.

### Layer 4 — Regression Suite (CI)

Run on every prompt change, model change, or retrieval change:

```yaml
# CI pipeline (pseudocode)
eval-pipeline:
  triggers: [prompt_changed, model_changed, retrieval_changed]
  steps:
    - load_golden_set
    - run_baseline_prompt
    - run_candidate_prompt
    - score_outputs
    - compare_scores
    - fail_if_regression:
        faithfulness: -5%
        helpfulness: -1pt
        correctness: -3%
```

**Fail-loud is non-negotiable.** A suite that warns and proceeds is ignored. Block merge until regression is investigated. False positives are annoying; silent regressions in production are damaging.

### Layer 5 — Production Observability

Sample 1-5% of real traffic, score against same metrics, watch for drift:

```
Three drift modes to monitor:
1. Input drift — users changing behavior (new question types)
2. Output drift — same inputs, different outputs (silent model update)
3. Quality drift — metrics no longer match user expectations (rubric rot)
```

Golden sets age. Production sampling catches what the golden set misses.

## Building a Golden Set

The golden set is the single most important artifact in prompt evaluation. Every layer depends on it.

### Sourcing

**Prefer real production inputs** over synthetic examples. Real users ask things you wouldn't imagine, in phrasings you wouldn't use, with assumptions you don't share. A synthetic golden set systematically misses these failures.

If production traffic doesn't exist yet, use the closest proxy: beta logs, support tickets, anonymized analytics from similar products.

### Curation

Sample for diversity, not volume. Stratify by:

- Intent type (information, action, clarification, complaint)
- Complexity (simple lookup, multi-step reasoning, edge case)
- User tier / domain
- Language / phrasing style

**Include every past failure.** Every production incident, every escalated ticket, every "the assistant gave the wrong answer" complaint becomes a permanent test case. This is the cheapest way to prevent regressions on failures you've already paid for.

### Sizing

- **Start:** 20-50 examples. Enough to force writing acceptance criteria.
- **Grow to:** 100-200. Enough for LLM-as-judge scores to stabilize (noise floor stops dominating).
- **Maximum:** Don't exceed 500 unless you genuinely need coverage depth. Past 500, the marginal example adds less than the marginal curation cost. A rotted 1,000-example set is worse than a healthy 200-example set.

### Maintenance

- **Owner:** One person responsible. Calls when examples become obsolete.
- **Review cadence:** Quarterly. Check set still reflects production traffic.
- **Add discipline:** Every production incident → new test case.
- **Remove discipline:** When a product change makes an example impossible, retire it.

## Evaluation by Output Type

| Output Type | Primary Metrics | Method |
|------------|----------------|--------|
| **Extraction** (entity, date) | Exact match, F1 | Programmatic (regex, schema validation) |
| **Classification** (intent, sentiment) | Per-class precision, recall, F1 | Programmatic against labeled set |
| **Open-ended text** | Rubric dimensions (1-5) + pairwise preference | LLM-as-judge + human calibration |
| **RAG output** | Faithfulness, relevance, context precision/recall | RAGAS framework (judge-based) |
| **Agent trajectories** | Goal achievement + tool call correctness + error recovery | Trajectory-based scoring |

**For RAG systems:** Use RAGAS metrics — faithfulness and answer relevance don't require ground truth, context precision and recall do. Score generation and retrieval separately — they fail differently.

**For agentic systems:** Score the final result AND the trajectory. Did the agent achieve the goal? Select correct tools? Recover from errors? Stop in finite time? A perfect final answer reached through looping and wasted tool calls is not a success.

## Automated Regression Setup

Minimum viable harness:

```python
# eval_harness.py (conceptual)
def evaluate(prompt_text, golden_set):
    scores = []
    for item in golden_set:
        output = run_prompt(prompt_text, item.input)
        scores.append(score_output(output, item.expected))
    return aggregate(scores)

def score_output(output, expected):
    return {
        "correctness": check_correctness(output, expected),
        "faithfulness": check_faithfulness(output, expected.context),
        "helpfulness": judge_score(output, "helpfulness"),
        "conciseness": len(output.tokens)
    }
```

**Run triggers (non-negotiable):**
1. Any merge touching prompt files
2. Any model version pin change
3. Any retrieval index or context assembly change

**Threshold discipline:**
| Metric | Regression Threshold | Action |
|--------|---------------------|--------|
| Faithfulness | -5% | Block merge |
| Helpfulness | -1 pt (1-5 scale) | Block merge |
| Correctness | -3% | Block merge |
| Latency | +50% | Warn, investigate |
| Cost | +50% | Warn, investigate |

## Integration with Analytics

When evaluating prompts tracked by the analytics system:

```
1. Record promptHash for each version
2. Compare satisfaction and resolution rates between hashes
3. Use statistical analysis skill for significance testing
4. Cross-reference eval scores with analytics outcomes
   → High eval score + low satisfaction = eval isn't measuring what matters
   → Low eval score + high satisfaction = eval is too strict or measuring wrong thing
```

## Anti-Patterns & Red Flags

| Pattern | Symptom / Red Flag | Fix |
|---|---|---|
| **Vibes-only shipping** | Shipping without scored eval; spot-checking only | Build a 20-example golden set immediately |
| **Synthetic datasets** | Every change scores positive; missed production bugs | Source examples from real traffic/logs |
| **Uncalibrated judge** | Flat scores; missed regressions; "confident noise" | Weekly human spot-check (5-10% of verdicts) |
| **Passive CI** | Suite warns but doesn't block; devs route around it | Implement fail-loud thresholds; block merges |
| **Stale Evaluation** | Quality drops silently after model/index updates | Auto-trigger eval on model version changes |
| **Rotted Golden Set** | High scores but unhappy users; no owner assigned | Quarterly review; add every prod incident as a case |
| **Misaligned Metrics** | Eval passes, product fails; metrics never change | Re-derive rubric from user complaints/analytics |

## Verification

- [ ] Golden set exists with 20-50+ curated inputs, includes past failures
- [ ] Written scoring rubric with per-dimension criteria
- [ ] At least Layers 1-3 operational (vibes + human + judge)
- [ ] Judge calibrated against human review in the last week
- [ ] Regression suite configured with fail-loud thresholds
- [ ] Golden set owner assigned, quarterly review scheduled
- [ ] Prompt version tracking integrated with analytics promptHash
