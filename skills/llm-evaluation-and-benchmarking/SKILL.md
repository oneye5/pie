---
name: llm-evaluation-and-benchmarking
description: Guides systematic evaluation of LLM-based agents. Use when designing evaluation criteria for agents, measuring model improvements, building benchmarks, or determining whether a model change actually improved outcomes. Do not use for code review or simple prompt testing.
---

# LLM Evaluation and Benchmarking

## Overview

Structured framework for evaluating LLM agents across behavior, capabilities, reliability, and safety. Measuring models in isolation is not enough — agents interact with tools, environments, and users. Evaluation must capture this complexity.

## When to Use

- Comparing two models or agent configurations on real tasks
- Designing an evaluation harness or benchmark for the analytics system
- Determining whether a model upgrade improved outcomes
- Defining success criteria for an agent before deploying it
- Investigating why high benchmark scores don't translate to user satisfaction
- Setting up regression testing for model/prompt changes

## Required Artifacts

- `analysis/eval-plan.md` — Objectives, success metrics (KPIs), and sampling strategy.
- `analysis/eval-results.md` — Raw data, per-dimension scores, and confidence intervals.
- `analysis/eval-recommendation.md` — Ship/no-ship decision with evidence-based rationale.

## The Evaluation Taxonomy

Evaluate agents along four objectives, each with distinct metrics:

### 1. Agent Behavior (Black-Box Outcomes)

What the user experiences. The most important layer.

| Metric | Definition | How to Measure |
|--------|-----------|----------------|
| Success Rate | Fraction of tasks fully completed | Automated checker or LLM-as-judge |
| Output Quality | Accuracy, relevance, coherence, adherence to spec | Rubric-based human or LLM scoring |
| Latency (TTFT) | Time to first token in streaming mode | Instrumentation, always measured |
| Cost | Tokens consumed × model pricing | API usage tracking |

**Key insight:** Success Rate alone is insufficient. A 90% success rate that takes 30s per task and costs $0.50 per run is different from one that takes 2s and costs $0.01. Report all four dimensions.

### 2. Agent Capabilities (Process-Level)

How the agent achieves its goals.

| Capability | What to Measure | Metrics |
|-----------|----------------|---------|
| Tool Use | Correct tool selection and parameter generation | Invocation accuracy, parameter F1, execution success |
| Planning & Reasoning | Multi-step action sequences | Node F1 (tool selection), Edge F1 (order), Progress Rate |
| Memory & Context | Information retention across turns | Factual recall accuracy, consistency score |
| Multi-Agent | Collaboration and task distribution | Collaborative efficiency, communication overhead |

**When capabilities matter:** If the agent succeeds on simple tasks but fails on complex ones, capability evaluation reveals which component breaks. A model with excellent behavior scores but poor planning will fail when tasks get harder.

### 3. Reliability

Consistency under repetition and perturbation.

| Aspect | Metric | How to Test |
|--------|--------|-------------|
| Consistency | pass^k (success on all k trials) | Run same task 5-10 times, require all pass |
| Input Robustness | Success rate on perturbed inputs | Paraphrase prompts, add distractors, inject typos |
| Error Recovery | Proportion of injected errors handled gracefully | Inject tool failures, API errors, null responses |
| Environmental Robustness | Success when environment changes | Modify web page structure, change tool signatures |

**pass@k vs pass^k:**
- `pass@k`: Succeeds at least once in $k$ tries (best for creative/open-ended tasks).
- `pass^k`: Succeeds in *all* $k$ tries (required for mission-critical/deterministic tasks).

### 4. Safety and Alignment

Trustworthiness, fairness, and compliance.

| Aspect | What to Check | Method |
|--------|--------------|--------|
| Harm Prevention | No dangerous, unethical, or policy-violating outputs | Red-teaming, adversarial prompts |
| Fairness | No disparate outcomes across user groups | Stratify results by demographic dimensions |
| Truthfulness | No confident hallucinations | Factual accuracy against ground truth |
| Explainability | Agent can justify its decisions | Human review of reasoning traces |

## Building an Evaluation Harness

The minimum viable eval harness:

```
1. GOLDEN SET: 20-50 real task inputs, curated for diversity
2. RUNNER: Apply agent to each input, capture full trajectory + output
3. SCORER: Assign per-dimension scores (programmatic + LLM-as-judge + human)
4. COMPARATOR: Diff current scores against baseline
5. REPORTER: Surface regressions, fail-loud on threshold breach
```

**Golden set principles:**
- Source from real production inputs, not author imagination
- Include past failures (every incident becomes a permanent test case)
- Stratify by task type, complexity, and domain
- Start at 20-50 examples, grow to 100-200
- Review quarterly — retire obsolete examples, add new ones

## Evaluation Levels (Cost vs. Signal Tradeoff)

| Level | Cost/Item | Signal Quality | When to Use |
|-------|-----------|---------------|-------------|
| **L1 — Programmatic** | Near-zero | High for exact-match, schema, numeric | Schema validation, math, exact output matching |
| **L2 — LLM-as-Judge** | ~0.1-1¢ | Medium (biased but scalable) | Batch scoring, dashboards, >20 outputs per change |
| **L3 — Human Review** | High (minutes) | Gold standard | Calibrating judges, high-stakes decisions, edge cases |
| **L4 — Production Sampling** | Variable | Catches unknown unknowns | Drift detection, novel input patterns |

**Never skip L3 for judge calibration.** An uncalibrated LLM-as-judge produces confident-looking noise. Spot-check 5-10% of judge verdicts against human judgment weekly.

## LLM-as-Judge Design

```markdown
You are an expert evaluator. Score the agent's output on these dimensions:

1. Correctness (1-5): Does it achieve the task goal?
2. Helpfulness (1-5): Is the output useful and actionable?
3. Conciseness (1-5): Is it direct without unnecessary content?

Input: {task_input}
Output: {agent_output}
Reference: {reference_output}

Return JSON: {"correctness": int, "helpfulness": int, "conciseness": int, "rationale": str}
```

**Judge biases to control for:**
- **Position bias:** Swap order in pairwise comparisons, run both ways
- **Verbosity bias:** Longer outputs score higher — use length-controlled rubrics
- **Self-preference bias:** Models prefer their own outputs — use cross-family judges
- **Authority bias:** Judges defer to confident-sounding wrong answers — require evidence in rationale

## Regression Testing

Run on every change that touches: model version, prompt text, tool configuration, retrieval index.

```
CI PIPELINE:
1. Load golden set
2. Run current agent on each input
3. Score outputs against baseline
4. FAIL if any metric drops >5% or >1 point on 1-5 scale
5. Pass with report
```

Fail-loud is non-negotiable. A suite that warns and proceeds is a suite the team learns to ignore.

## Applying to the Analytics System

The analytics system tracks treatment comparisons. Map the taxonomy:

```
Behavior → satisfaction scores, resolution rates, latency
Capabilities → tool success rates, verification pass rates, subagent scores
Reliability → pass^k on repeated runs, tool failure recovery
Safety → (future: policy violations, bias analysis)
```

**When comparing models via analytics:**
- Use statistical analysis skill for significance testing
- This skill defines WHAT to measure and HOW to interpret
- Cross-reference: a model with higher satisfaction but worse consistency may not be an upgrade

## Pitfalls & Rationalizations

| Pitfall / Rationalization | Reality / Fix |
|---------------------------|----------------|
| **Benchmark overfitting** (Optimizing prompts for the golden set) | Use diverse, real inputs; refresh golden set quarterly. |
| **Single-metric obsession** (Only tracking success rate) | Report all four behavior dimensions (Success, Quality, Latency, Cost). |
| **Ignoring cost-quality tradeoff** (Perfect outputs at 10x cost) | Always include cost per-task in evaluation. |
| **Uncalibrated judges** (Trusting LLM judgments without spot-checks) | Weekly human calibration: spot-check 5-10% of judge verdicts. |
| **No production sampling** (Golden set is green, users say red) | Continuous sampling of 1-5% of real traffic for drift detection. |
| "The model scores high on MMLU, it'll be fine" | Benchmarks measure isolated capabilities; agents operate in dynamic environments. |
| "We spot-checked a few outputs" | Manual samples are biased. Use a curated golden set. |
| "We'll add eval later" | Eval added after a regression is damage control, not evaluation. |
| "The golden set is 500 examples, we're covered" | Volume $\neq$ Coverage. A rotted golden set produces high-confidence false signal. |

## Verification

- [ ] Evaluation objectives mapped to specific metrics
- [ ] Golden set sourced from real inputs, includes past failures
- [ ] At least three evaluation levels used (programmatic + judge + human)
- [ ] Judge calibrated against human review (weekly spot-check)
- [ ] Regression suite blocks merge on threshold breach
- [ ] Production sampling configured for drift detection
