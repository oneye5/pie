---
name: verification-before-completion
description: "Use before claiming any work is complete, fixed, or passing. Requires running verification commands and confirming output before making success claims. Evidence before assertions, always."
---

# Verification Before Completion

## Core Rule

```
NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE
```

If you haven't run the verification command in this response, you cannot claim it passes.

## The Gate

Before claiming ANY status (done, fixed, passing, working, complete):

1. **Identify** — What command proves this claim?
2. **Run** — Execute the command (fresh, in this session)
3. **Read** — Full output, check exit code
4. **Verify** — Does output confirm the claim?
   - NO → State actual status with evidence
   - YES → State claim WITH the evidence

Skip any step = unverified claim.

## What Counts as Verification

| Claim | Requires | NOT Sufficient |
|-------|----------|----------------|
| Tests pass | Test command output showing 0 failures | Previous run, "should pass" |
| Build succeeds | Build command with exit 0 | "Linter passed" |
| Bug fixed | Reproduce original symptom: now passes | "Code changed" |
| Type-checks | `tsc --noEmit` or equivalent: 0 errors | "No red squiggles" |
| Requirements met | Line-by-line against plan | "Tests pass" |

## Red Flags — STOP

If you catch yourself:
- Using "should", "probably", "seems to"
- Saying "Great!", "Perfect!", "Done!" before running verification
- About to commit without verifying
- Relying on a previous test run (stale)
- Thinking "just this once"

## The Bottom Line

Run the command. Read the output. THEN claim the result. Non-negotiable.
