---
name: grill-with-docs
description: Grilling session that challenges your plan against the existing domain model, sharpens terminology, and updates documentation inline as decisions crystallise. Use when user wants to stress-test a plan against their project's language and documented decisions.
---

# Domain awareness

<what-to-do>

Interview me relentlessly about every aspect of this plan until we reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one-by-one. For each question, provide your recommended answer.

Ask the questions one at a time, waiting for feedback on each question before continuing.

If a question can be answered by exploring the codebase, explore the codebase instead.

</what-to-do>

<supporting-info>

## Domain awareness

During codebase exploration, also look for existing documentation:

### File structure

This project keeps design documentation in `docs/` and `AGENTS.md`:

```
/
├── AGENTS.md                  ← conventions and repo-specific instructions
├── docs/
│   ├── ARCHITECTURE.md        ← system overview, patterns, information flow
│   ├── STATE_CONTRACT.md      ← authoritative state management rules
│   └── ...other design docs
```

Key files to read before grilling:

- **`AGENTS.md`** — repo conventions, build commands, tooling expectations
- **`docs/ARCHITECTURE.md`** — system overview, architecture patterns, information flow, module boundaries
- **`docs/STATE_CONTRACT.md`** — authoritative rules for state management, session routing, mutation patterns

If any of these don't exist yet, proceed silently — don't flag their absence. Update them lazily when decisions crystallise.

## During the session

### Challenge against existing docs

When the user uses a term that conflicts with the language established in `ARCHITECTURE.md` or `AGENTS.md`, call it out immediately. "Your architecture doc defines the pattern as 'CQRS-shaped Elm/MVI', but you seem to be describing something different — which is it?"

### Sharpen fuzzy language

When the user uses vague or overloaded terms, propose a precise canonical term. "You're saying 'account' — do you mean the Customer or the User? Those are different things."

### Discuss concrete scenarios

When domain relationships are being discussed, stress-test them with specific scenarios. Invent scenarios that probe edge cases and force the user to be precise about the boundaries between concepts.

### Cross-reference with code

When the user states how something works, check whether the code agrees. If you find a contradiction, surface it: "The STATE_CONTRACT says session-scoped events must include sessionPath, but this handler doesn't — which is right?"

### Update docs inline

When a term or decision is resolved, update the relevant doc right there. Don't batch these up — capture them as they happen:

- **Terminology or conventions** → update `AGENTS.md`
- **Architectural concepts, module boundaries, patterns** → update `docs/ARCHITECTURE.md`
- **State rules, mutation patterns, protocol constraints** → update `docs/STATE_CONTRACT.md`
- **New design decision worth recording** → add to `docs/` as a new doc or append to an existing one

Use the format guidelines in [DOC-FORMAT.md](./DOC-FORMAT.md).

### Offer decision records sparingly

Only offer to record a decision when all three are true:

1. **Hard to reverse** — the cost of changing your mind later is meaningful
2. **Surprising without context** — a future reader will wonder "why did they do it this way?"
3. **The result of a real trade-off** — there were genuine alternatives and you picked one for specific reasons

If any of the three is missing, skip it. Use the format in [DECISION-FORMAT.md](./DECISION-FORMAT.md).

</supporting-info>