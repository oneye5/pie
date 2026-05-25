---
name: plan-execution
description: "Use when you have an approved implementation plan to execute. Implements each task using TDD (test-first), verifies everything works, and ensures nothing is left broken. Activates after braindump-to-plan produces an approved plan."
---

# Plan Execution

Implement an approved plan task-by-task using test-driven development.

## Philosophy

You have a plan the user approved. Now execute it efficiently:
- Work through tasks sequentially
- Write tests first, then implement
- Verify continuously
- Don't stop to ask permission between tasks — the user already approved the plan
- DO stop if you hit something that contradicts the plan or reveals the plan is wrong

## When to Use

- After `braindump-to-plan` produces an approved plan
- User says "go", "looks good", "ship it", or otherwise approves

## The Execution Loop

For each task in the plan:

### 1. Write Failing Tests

Write tests that define the expected behavior for this task. Run them — they MUST fail (proving they test something real).

If a test passes immediately, it's not testing new behavior. Fix or remove it.

### 2. Implement

Write the minimal code to make tests pass. Follow existing patterns and conventions.

- Don't over-engineer
- Don't add features beyond what the test requires
- Don't refactor unrelated code

### 3. Verify Green

Run all tests (not just the new ones). Everything must pass.

- New tests pass → implementation is correct
- Existing tests pass → nothing was broken
- If something breaks, fix it before moving on

### 4. Refactor (if needed)

Only after green:
- Remove duplication introduced by this task
- Improve names if unclear
- Extract helpers if genuinely reused

Keep tests green throughout.

### 5. Move to Next Task

No need to ask the user. Proceed to the next task.

## Hard Rules

### TDD is Non-Negotiable

```
Write test → Watch it fail → Write code → Watch it pass
```

No exceptions. If you write implementation code before a test exists for that behavior, delete it and start over.

### Verify Before Claiming Done

After ALL tasks are complete:
1. Run the full test suite
2. Verify all tests pass with clean output
3. Check for any lint/type errors
4. Only THEN tell the user it's done

Never say "done" or "all tests pass" without having run the commands and seen the output in THIS session.

### Stop Conditions

Stop execution and check in with the user if:
- The plan has a contradiction or gap that prevents a task from being implemented
- A task reveals the architecture needs to change in a way that affects other tasks
- Tests reveal the plan's assumptions were wrong
- You're genuinely stuck after 2-3 attempts at a task

Do NOT stop for:
- Routine implementation decisions
- Choosing between equivalent approaches
- Minor deviations from plan that are clearly better

## Test Quality

Tests should:
- Test behavior, not implementation details
- Use real code paths (minimize mocks)
- Have clear names that describe what's being verified
- Cover edge cases and error paths, not just happy paths
- Be independent (no test depends on another running first)

## Completion Report

When all tasks are done, report:

```
## Done

Implemented [feature name]:
- [brief summary of what was built]
- [number] tests added, all passing
- [any notable decisions made during implementation]
```

Keep it brief. The user can look at the code.

## What NOT to Do

- Don't ask "shall I continue?" between tasks
- Don't provide progress updates after each task (just work)
- Don't write a summary of what you're about to do before doing it
- Don't create documentation files unless the plan explicitly includes them
- Don't refactor existing code that isn't part of the plan
- Don't add error handling for impossible scenarios
- Don't add comments explaining obvious code
