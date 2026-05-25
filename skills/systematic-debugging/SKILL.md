---
name: systematic-debugging
description: "Use when encountering any bug, test failure, or unexpected behavior. Enforces root-cause investigation before proposing fixes. Guessing wastes time — trace the problem systematically."
---

# Systematic Debugging

## Core Rule

```
NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST
```

If you haven't completed investigation, you cannot propose fixes.

## When to Use

- Tests fail after a code change
- Build breaks
- Runtime behavior doesn't match expectations
- Something worked before and stopped
- You've already tried a fix and it didn't work

## The Four Phases

### Phase 1: Investigate

Before attempting ANY fix:

1. **Read error messages carefully** — full stack traces, line numbers, error codes. They often contain the answer.
2. **Reproduce consistently** — can you trigger it reliably? What are the exact steps?
3. **Check recent changes** — git diff, recent commits. What changed?
4. **Trace data flow** — where does the bad value originate? Trace backward through the call stack until you find the source.

### Phase 2: Understand the Pattern

1. **Find working examples** — locate similar working code in the same codebase
2. **Compare** — what's different between working and broken?
3. **Identify dependencies** — what other components does this touch?

### Phase 3: Hypothesize and Test

1. **Form ONE hypothesis** — "I think X is the cause because Y"
2. **Test minimally** — smallest possible change to test the hypothesis
3. **One variable at a time** — don't fix multiple things at once

### Phase 4: Fix

1. **Write a failing test** that reproduces the bug
2. **Implement the fix** — address root cause, not symptom
3. **Verify** — test passes, no other tests broken
4. **If fix doesn't work after 3 attempts** — stop. The architecture might be wrong. Discuss with the user.

## Red Flags — STOP and Return to Phase 1

- "Quick fix for now, investigate later"
- "Just try changing X and see"
- "It's probably X, let me fix that"
- Proposing solutions before tracing data flow
- Each fix reveals a new problem in a different place (architectural issue)
- 3+ failed fix attempts (question the architecture, don't try fix #4)

## Common Rationalizations

| Excuse | Reality |
|--------|---------|
| "Issue is simple" | Simple issues have root causes too |
| "No time for process" | Systematic is FASTER than guess-and-check |
| "Just try this first" | First fix sets the pattern. Do it right. |
| "Multiple fixes saves time" | Can't isolate what worked. Causes new bugs. |
| "I see the problem" | Seeing symptoms ≠ understanding root cause |
