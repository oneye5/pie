---
name: prompt-engineering
description: Guides effective prompt writing and iteration for LLMs and agents.
---

# Prompt Engineering

## Overview
Writing clear, testable instructions that reliably steer LLMs. Treat prompts as code: version them, test them, and refine them.

## When to Use
- Authoring or revising system prompts.
- Debugging unexpected agent behavior.
- Optimizing prompts for consistency.

## Required Artifacts
- `prompts/` directory with version‑controlled prompt files.
- `analysis/eval/prompt-tests.json` with 10‑20 test cases.
- `CHANGELOG.md` documenting changes.

## Prompt Structure
1. **Identity** – 1‑3 sentence role definition.
   ```markdown
   You are a SQL query assistant. Output only valid PostgreSQL.
   ```

2. **Instructions** – Concrete, observable rules.
   ```markdown
   - Use snake_case.
   - Output raw code; no Markdown.
   - No ES6+ suggestions.
   ```

3. **Examples (Few‑Shot)** – 2‑5 diverse examples.
   ```markdown
   <user_query>
   How do I sort an array of objects by date?
   </user_query>
   <assistant_response>
   [
     { "item": "a", "date": "2024-01-10" },
     { "item": "b", "date": "2024-01-05" }
   ].sort((x,y)=>x.date.localeCompare(y.date));
   ```

4. **Context** – Naming, test framework, build conventions.
   - File naming: `snake_case.js`
   - Test framework: QUnit 1.x
   - Build: `make` with Closure Compiler
```

## Iteration Workflow
1. **Write** the prompt using the structure above.  
2. **Test** with 10‑20 representative inputs.  
3. **Score** outputs against concrete criteria.  
4. **Identify** the most common failure mode.  
5. **Rewrite** the prompt to address that failure.  
6. **Retest** until scores stabilize.  
➡ *Make one change at a time.*

## Quick Reference Checklist
- [ ] Clear, testable instructions.  
- [ ] 2‑5 diverse examples.  
- [ ] Scored against criteria.  
- [ ] No vague language (“be helpful”).  
- [ ] Version‑controlled (promptHash recorded).

## Common Pitfalls
- Vague directives (“be helpful”, “do your best”).  
- Overly long prompts (> 2,000 tokens).  
- Missing examples or examples that don’t cover edge cases.  
- Mixing role definitions across system/user blocks.