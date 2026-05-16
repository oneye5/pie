---
name: statistical-analysis
description: Guides systematic statistical analysis of experimental results. Use when comparing treatment groups, interpreting A/B test results, determining statistical significance, or analyzing the analytics system's run outcomes. Do not use for simple descriptive statistics or basic charting.
---

# Statistical Analysis

## Overview

Perform rigorous statistical analysis. Back conclusions with evidence, quantify uncertainty, and document methods. Visual impressions are not analysis; report confidence intervals.

## When to Use

- Comparing satisfaction scores or resolution rates across models/treatments
- Interpreting treatment comparison results from the analytics system
- Determining if a model change produced a statistically significant improvement
- Designing an experiment before collecting data
- Checking if verification adoption correlates with resolution
- Evaluating subagent performance differences

## Required Artifacts

- `analysis/hypothesis.md` — Stated null and alternative hypotheses, written before touching the data
- `analysis/results.md` — Statistical test results with test statistics, p-values, confidence intervals, and effect sizes
- `analysis/conclusion.md` — Actionable interpretation in plain language, distinguishing statistical from practical significance

## Core Rules

**Do not perform post‑hoc analysis; pre‑register hypotheses and stopping rules.** Plan analyses before seeing data; pre‑register hypotheses and stopping rules.

**Pre‑register all analysis parameters.** Include sample size, test selection, and stopping criteria.

**Report effect sizes and confidence intervals.** Note practical significance; small gains may lack impact.

## Statistical Test Selection

| Situation | Test | Notes |
|-----------|------|-------|
| Comparing means, two groups, normal | Two-sample t-test (Welch's) | Use Welch's unless variances are known equal |
| Comparing means, two groups, non-normal | Mann-Whitney U | Robust to outliers, tests stochastic dominance |
| Comparing means, 3+ groups | One-way ANOVA | Follow with post-hoc correction if significant |
| Comparing proportions | Chi-squared or Fisher's exact | Fisher's for small samples (expected count < 5) |
| Comparing rates over time | Poisson regression | For event counts (failures, tool errors per run) |
| Correlation between scores | Spearman's ρ | Use rank correlation for satisfaction scores |
| Before/after same subjects | Paired t-test or Wilcoxon signed-rank | Same prompts, different models |
| Multiple outcomes simultaneously | MANOVA | Controls for family-wise error when outcomes are correlated |

## A/B Testing Workflow

1. **State hypotheses.** H₀: no difference between treatments. H₁: there is a meaningful difference. Define "meaningful" numerically (minimum effect size of interest).

2. **Calculate required sample size.** Use power analysis: α = 0.05, power = 0.80. For proportions, a 5pp difference with baseline 50% needs ~1,500 per group. Don't start without enough data.

3. **Check for sample ratio mismatch (SRM).** If treatment A has 1,000 runs and treatment B has 800, investigate why before analyzing. Imbalance signals a bug or selection bias.

4. **Verify assumptions.** Normality (QQ plot, Shapiro-Wilk), independence, equal variance (Levene's test). If assumptions fail, switch to non-parametric alternatives or use bootstrap.

5. **Run the test.** Report test statistic, p-value, confidence interval (95%), and effect size (Cohen's d, relative risk, or odds ratio as appropriate).

6. **Correct for multiple comparisons.** If testing 10 metrics, adjust α (Bonferroni: α/10) or control FDR (Benjamini-Hochberg). Report both raw and adjusted p-values.

7. **Replicate before shipping.** A single experiment is a signal, not proof. Run a holdout or wait for new data before concluding.

## Interpreting the Analytics System

The analytics pipeline tracks these key comparisons:

```
Run outcomes: resolution (success/partial/failure), satisfaction (1-5)
Treatments: model, thinking level, prompts, tools, skills, extensions
Confounders: task complexity, session length, time of day
```

### Comparing Models

- Group runs by model, control for task complexity (stratify or include as covariate)
- Compare satisfaction scores with Mann-Whitney U (ordinal data)
- Compare resolution rates with Chi-squared
- Check if differences persist across task types (interaction effects)
- **If no task complexity controls exist:** report findings as descriptive, not causal. Note "model A had higher satisfaction" not "model A is better."

### Comparing Skills and Extensions

- This is observational data, not randomized — treat as correlation, not causation
- Use propensity score matching or stratification to control for selection bias
- Report "runs using skill X had Y higher satisfaction" not "skill X improves satisfaction"
- **Confounding check:** Are runs using skill X systematically different? (e.g., only used on complex tasks, only by experienced users)

### Comparing Prompts

- The analytics system tracks `promptHash` and `promptFamily`
- Compare satisfaction and resolution rates between prompt versions
- Pair with `prompt-evaluation` skill for systematic quality measurement
- Run the same tasks with both prompts when possible (within-subjects design)

### Practical Significance Thresholds

When interpreting analytics results, apply these defaults unless domain context says otherwise:

| Metric | Trivial | Small | Meaningful |
|--------|---------|-------|------------|
| Satisfaction (1-5) | < 0.1 pts | 0.1-0.3 pts | > 0.3 pts |
| Resolution rate | < 1pp | 1-3pp | > 3pp |
| Tool success rate | < 2pp | 2-5pp | > 5pp |
| Latency | < 5% | 5-15% | > 15% |

A statistically significant difference below the meaningful threshold is not actionable.

## Common Pitfalls

| Pitfall | Detection | Fix |
|---------|-----------|-----|
| Peeking (stopping early) | p-values systematically near 0.05 | Sequential analysis or pre-registered stopping |
| Ignoring effect size | Significant p but tiny difference | Report effect size and practical significance |
| Multiple comparisons | Many tests, a few significant | Adjust α (Bonferroni) or control FDR |
| Simpson's paradox | Trend reverses when stratifying | Always stratify by known confounders |
| Survivorship bias | Only analyzing completed runs | Include abandoned/timeout runs in denominator |
| Regression to the mean | Extreme group improves on retest | Compare against control group, not baseline |
| Assuming causation | Observational data treated as experiment | Randomized controlled comparisons only |

## Bootstrap for Robust Inference

When assumptions are uncertain, bootstrap:

```
1. Sample with replacement from the data N times (N ≥ 1,000)
2. Compute the statistic of interest for each sample
3. Take the 2.5th and 97.5th percentiles as the 95% CI
```

Bootstrap works for means, medians, ratios, and custom metrics without distributional assumptions.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "The difference looks obvious, we don't need tests" | Visual impressions are confirmation bias in action. Test it. |
| "p = 0.051 is almost significant" | Almost significant is not significant. Gather more data or accept H₀. |
| "We'll just run it a few more times" | Sampling to significance produces false positives. Pre-register stopping rules. |
| "All the significant results point the same way" | Directional consistency is not a statistical test. Run the proper test. |
| "We don't have enough data for significance" | Report the effect size with wide confidence intervals. Uncertainty is information. |

## Red Flags

- p-values reported without test statistics or effect sizes
- Sample sizes decided mid-experiment
- Multiple metrics tested without correction
- "We removed these outliers" without pre-registered criteria
- Comparing selected subgroups not defined before data collection
- Treating observational comparisons as causal claims

## Verification

- [ ] Hypotheses stated before data analysis began
- [ ] Test selection justified (assumptions checked)
- [ ] Effect sizes and confidence intervals reported
- [ ] Multiple comparison correction applied if needed
- [ ] Exploratory findings labeled as exploratory
- [ ] Artifacts saved to `analysis/hypothesis.md`, `analysis/results.md`, `analysis/conclusion.md`