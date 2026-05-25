---
name: braindump-to-plan
description: "Use when the user shares an idea, feature request, or rough braindump that needs implementation. Produces an actionable implementation plan in a SINGLE pass — no multi-turn spec writing. Replaces separate brainstorming, spec-writing, and plan-writing phases."
---

# Braindump to Plan

Turn a user's rough idea into an actionable implementation plan in one pass.

## Philosophy

The user's time is precious. Don't drag them through rounds of clarifying questions, spec documents, and plan reviews as separate steps. Instead:

1. **Read the braindump** — extract intent, constraints, and success criteria
2. **Explore context** — check relevant files, docs, existing patterns in the codebase
3. **Produce a plan** — present it for review in a single response

## When to Use

- User shares a feature idea, braindump, or rough description of what they want
- User says "build X", "I want Y", "let's add Z"
- Any creative/implementation work that isn't a trivial one-liner

## Hard Rules

- **Maximum 1-2 clarifying questions** — only ask if the braindump is genuinely ambiguous about something critical (e.g., which of two mutually exclusive approaches to take). If you can reasonably infer intent, just proceed.
- **No separate spec document** — the plan IS the spec.
- **No multi-turn question loops** — don't ask questions one at a time. If you must ask, batch them.
- **Present the plan in one shot** — don't drip-feed sections for approval.

## The Process

### 1. Absorb the Braindump

Read everything the user provided. Extract:
- **Goal**: What are they trying to achieve?
- **Constraints**: Technical limits, existing patterns to follow, things to avoid
- **Success criteria**: How do we know it's done?

### 2. Explore Context (silently)

Before producing the plan:
- Check relevant existing files and patterns
- Understand the current architecture
- Note conventions (naming, file structure, test patterns)
- Identify what exists vs what needs to be created

### 3. Produce the Plan

Present a plan with this structure:

```markdown
## Plan: [Feature Name]

**Goal:** [One sentence]

**Approach:** [2-4 sentences on architecture/strategy]

### Tasks

1. **[Task name]**
   - Files: [create/modify which files]
   - What: [concrete description of changes]
   - Tests: [what tests verify this works]

2. **[Task name]**
   ...

### Out of Scope
- [Things explicitly NOT being done]
```

#### Task Granularity

Each task should be a coherent unit of work (a feature slice, a module, a behavior) — not individual keystrokes. A task can take 5-30 minutes. Don't break things into "write test" / "run test" / "write code" / "run code" / "commit" micro-steps — that's implementation detail.

#### Task Content

- **Exact file paths** — always
- **What changes** — concrete enough to implement unambiguously
- **What tests prove it works** — describe the behavior being verified
- **No placeholders** — no "TBD", "add appropriate handling", "similar to above"

### 4. Wait for User Review

After presenting the plan, wait. The user will either:
- **Approve** → proceed to implementation (invoke plan-execution)
- **Request changes** → revise the plan and re-present
- **Ask questions** → answer and revise if needed

## Key Principles (from Superpowers)

- **YAGNI** — Don't add features the user didn't ask for
- **DRY** — Don't duplicate logic
- **Design for isolation** — Break into units with clear boundaries and interfaces
- **Follow existing patterns** — In existing codebases, match conventions
- **TDD** — Every task includes what tests verify it (implementation will use red-green-refactor)

## What NOT to Do

- Don't ask "what's your preferred approach?" when the braindump already implies one
- Don't write a spec file to disk before the user has approved anything
- Don't propose 2-3 approaches with trade-offs (just recommend one, note alternatives briefly if relevant)
- Don't ask about edge cases you can handle with reasonable defaults
- Don't ask one question per message
- Don't offer a "visual companion"
- Don't require the user to approve individual sections

## Transition

Once the user approves the plan, use the `plan-execution` skill to implement it.
