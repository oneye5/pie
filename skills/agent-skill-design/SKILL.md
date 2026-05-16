---
name: agent-skill-design
description: Guides writing effective pi skills that trigger reliably and execute correctly. Use when creating new skills, debugging skill activation failures, or reviewing skill quality. Do not use for writing application code or prompts — this is exclusively for SKILL.md authoring.
---

# Agent Skill Design

## Overview

Evidence-based skill authoring grounded in how models actually process instructions. A skill that doesn't trigger reliably is broken, regardless of content quality. Every design decision is backed by empirical research on context utilization, instruction following, and attention patterns.

## When to Use

- Creating a new skill for pi or any skill-based agent
- Debugging why a skill doesn't activate when expected
- Reviewing a skill for quality and reliability
- Refactoring a skill that's grown too large or branched into multiple modes
- Deciding whether to split a skill or keep it unified

## Required Artifacts

- `SKILL.md` — 150-300 lines, under 5,000 tokens
- `test/positive-triggers.md` — Prompts that SHOULD activate the skill
- `test/negative-triggers.md` — Prompts that should NOT activate the skill

## Core Design Rules

These rules MUST be followed. Skills that violate them are broken by design.

### 1. Description is a Routing Signal, Not Marketing

The `description` frontmatter field determines activation. Write it for the router, not the reader:

```yaml
# Good: job + trigger conditions + non-goals
description: Guides systematic statistical analysis of experimental results.
  Use when comparing treatment groups, interpreting A/B test results, or
  determining statistical significance. Do not use for simple descriptive
  statistics.

# Bad: marketing copy, no routing signal
description: Unlock the power of data with advanced analytics!
```

Include "Use when" and "Do not use when" clauses when adjacent skills share semantic territory.

### 2. One Skill, One Workflow

Split skills when they have different triggers, outputs, or decision rules. Multi-mode skills with conditional branching create the composition types models handle worst.

Research: GPT-4 scores 0.881 on flat AND composition, but as low as 0.083 on nested multi-layer compositions (ComplexBench, NeurIPS 2024).

```markdown
# Bad: multi-mode skill
## Mode A: Review Architecture
...40 lines...
## Mode B: Review Scope
...40 lines...
## Mode C: Review Tests
...40 lines...

# Good: three separate skills
review-architecture → triggered by "review the architecture"
review-scope → triggered by "review the scope"
review-tests → triggered by "review the tests"
```

**Accept structural duplication** between similar skills until there are at least three real consumers of the shared pattern. Premature abstraction is worse than duplication.

### 3. Context Must Be Lean and High-Signal

Every token must change behavior. If removing a sentence would not change what the model does, remove it.

Research: Reasoning accuracy drops from 0.92 to 0.68 as input grows from ~250 to ~3,000 tokens. Even duplicate padding degrades accuracy — length itself is the problem (Same Task, More Tokens, ACL 2024).

Target: 150-300 lines. Hard limit: 500 lines, 5,000 tokens.

Remove: decorative prose, repeated rationale, edge cases that don't change behavior, "motivation" sections explaining why the skill exists.

### 4. Critical Rules Go Early

Models attend most to beginnings (primacy) and endings (recency) of context. Middle-positioned information performs worse than providing no information at all.

Research: Middle-positioned QA accuracy: 52.9% vs 56.1% closed-book baseline (Lost in the Middle, TACL 2023).

**Must go near the top:**
- Mission statement
- Required artifacts
- Hard constraints (always/never rules)
- Human checkpoint triggers

**Must go near the end:**
- Guardrails
- Final handoff instructions
- Common failure modes

**Never put critical rules in the middle** of workflow phases where the "lost in the middle" effect is strongest.

### 5. Prefer Explicit Contracts

"If X is missing, stop and report Y" — not "Handle missing inputs appropriately." Name files, report headings, stop conditions, and success criteria explicitly.

The model cannot infer your intent. Make every expectation independently verifiable.

### 6. Human Checkpoints Must Be Narrow

Vague rules like "ask when uncertain" add constraint load on every action. Research shows each additional constraint increases the probability of violating all of them (IFScale, 2025).

```markdown
# Bad: vague, always triggers or never triggers
Ask the user when uncertain about anything.

# Good: concrete trigger condition
Stop and ask the user before modifying any file outside the target directory.
If the directory doesn't exist, ask whether to create it.
```

Limit to 2-3 checkpoint conditions per skill. Each competes for attention with workflow instructions.

### 7. Make It Measurable

Every skill needs a checkable definition of done. Without it, you can't evaluate whether the skill works.

```markdown
## Success Criteria
- [ ] All required artifacts created at specified paths
- [ ] No more than one human checkpoint triggered per execution
- [ ] Workflow completes without loops or stalls
```

Create at least one positive-trigger and one negative-trigger prompt for activation testing.

## Recommended Skill Structure

Follow this section order for reliable execution:

| Section | Purpose | Why Here |
|---------|---------|----------|
| Frontmatter | Routing metadata | Loaded first, determines activation |
| # Title + Overview | One-sentence mission | Immediate orientation |
| ## When to Use | Trigger conditions + non-goals | Expands routing signal |
| ## Required Artifacts | File paths and output contracts | Makes workflow inspectable |
| ## Core Rules / Constraints | Non-negotiable behavior rules | Benefits from primacy effect |
| ## Workflow Phases | Ordered execution steps | Main operational body |
| ## Common Pitfalls / Rationalizations | Known failure modes | Reference during execution |
| ## Red Flags | Warning signs of breakage | Diagnostic aid |
| ## Verification | Checklist before calling done | Keeps closeout deterministic |

## Anti-Patterns Catalog

| Anti-Pattern | Why It Fails | Fix |
|-------------|-------------|-----|
| Vague description | Weak routing signal | State job + trigger + non-goal |
| Multi-mode skill | Composition collapse (accuracy → 0.083) | Split into separate skills |
| Critical rules buried late | Primacy effect — later rules dropped | Move invariants near top |
| Laundry list of edge cases | Context bloat, diluted core | Keep canonical cases only |
| Companion-file dependency | Breaks on clients only loading SKILL.md | Core workflow self-contained in SKILL.md |
| Base-skill wrapper hierarchy | Fragile abstractions, drift | Accept duplication, split when real |
| Untestable definition of done | Can't evaluate or regress | Explicit artifacts + commands |
| "Ask when uncertain" | Constraint load on every action | Name exact trigger conditions |
| Interactive scripts | Hangs in autonomous runs | Fully flag-driven, `--help` supported |
| Decorative prose | Context rot — distracts from instructions | Cut everything that doesn't change behavior |

## Research Findings Cheat Sheet

| Finding | Implication |
|---------|-------------|
| Accuracy drops from 0.92→0.68 (250→3K tokens) | Keep skills 150-300 lines |
| U-shaped attention (primacy + recency) | Rules early, guardrails late |
| Best model: 68.9% at 500 instructions | Minimize constraint count |
| Nested composition: 0.083 accuracy | Never build multi-mode skills |
| Even 1 distractor degrades performance | Zero decorative content |
| Middle info worse than no info | Never put critical rules mid-file |

## Skill Review Checklist

When reviewing a skill, check:

- [ ] Description clearly states what triggers the skill and what doesn't
- [ ] Skill has exactly one primary job and one output contract
- [ ] Required artifacts are named with exact file paths
- [ ] Hard constraints and invariant rules appear in the first 40% of the file
- [ ] Human checkpoints are concrete and sparse (≤3 conditions)
- [ ] Guardrails appear at the end
- [ ] Every sentence changes behavior — no decorative prose
- [ ] Body is 150-300 lines (500 max)
- [ ] Core workflow understandable from SKILL.md alone
- [ ] At least one positive and one negative trigger prompt exists
- [ ] Success criteria are checkable, not subjective

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "It's a short skill, we can add more modes" | Single-mode is not about length — it's about composition complexity. |
| "This edge case matters" | It wastes more attention than it saves. Put it in references/. |
| "The model is smart, it'll figure out the intent" | Models follow patterns, not intentions. Make the contract explicit. |
| "Duplication is bad, we should share structure" | Premature abstraction is the #1 source of skill fragility. |
| "Longer context windows mean we can write longer skills" | Reasoning degrades at 500 tokens, not 500K. The limit is cognitive, not technical. |

## Verification

- [ ] SKILL.md is 150-300 lines, under 5,000 tokens
- [ ] Description includes trigger conditions and non-goals
- [ ] Single workflow — no mode-switching branches
- [ ] Hard constraints appear early in the file
- [ ] Guardrails appear at the end
- [ ] Positive and negative trigger tests exist
- [ ] No decorative prose or vague directives
