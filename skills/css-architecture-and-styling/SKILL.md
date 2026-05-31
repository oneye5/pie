---
name: css-architecture-and-styling
description: 'Maintainable, scalable raw CSS for component-based interfaces. Use when writing or refactoring `.css` files, designing cascade strategy, naming, layout, spacing, or styling tokens. Do not use for backend logic or pure visual direction work where `frontend-design` is the better fit.'
---

# CSS Architecture and Styling

Write raw CSS that remains predictable as the codebase grows. Favor low
specificity, explicit component boundaries, reusable class APIs, and modern CSS
features that reduce override churn.

## Overview

This skill is for day-to-day CSS authoring in codebases that use raw stylesheets.
It complements `frontend-design`: use this skill when the hard part is cascade,
layout, naming, responsiveness, or maintainability rather than visual concepting.

The guidance here synthesizes recurring advice from well-regarded CSS sources,
especially MDN's CSS documentation, web.dev's Learn CSS course, and Harry
Roberts' CSS Guidelines. The common thread is consistent: understand the
cascade, keep selectors simple, compose with classes, and use modern primitives
before inventing local hacks.

## When to Use

- Adding or refactoring raw `.css` for UI components, pages, or webviews
- Fixing style bugs caused by cascade, specificity, inheritance, or layout
- Establishing naming conventions, tokens, or stylesheet organization
- Replacing brittle one-off overrides with reusable component rules
- Improving responsive behavior, spacing systems, or layout resilience

**Do not use for:**
- Pure visual exploration or aesthetic direction without a CSS architecture task
- Backend logic, APIs, or non-visual refactors
- Framework-specific styling APIs when no raw CSS decisions are involved

## Core Principles

### 1. Design the Cascade on Purpose

- Organize styles by responsibility: tokens, reset/base, layout/objects,
  components, and utilities/overrides
- Prefer source-order and `@layer` decisions over selector arm-wrestling
- Put rules where developers will expect to find them, not where it happened to
  be convenient during a patch

### 2. Keep Specificity Low

- Prefer single-class selectors for most component rules
- Avoid IDs in CSS
- Avoid long descendant chains, element-qualified classes, and unnecessary
  nesting
- Use `!important` only for deliberate utility/trump behavior or hard
  interoperability constraints, never as the default way out of a bad cascade

### 3. Name for Intent and Reuse

- Use hyphenated class names
- Use BEM-like block, element, and modifier naming when component
  relationships need to stay explicit
- Name classes for purpose and reuse, not page location
- Keep JS hooks separate from styling hooks

### 4. Compose Instead of Entangling

- Separate structure from skin when that split makes reuse cheaper
- Extend components with modifier classes or custom properties instead of
  location-based overrides
- Prefer adding opt-in variants over mutating a base component indirectly

### 5. Prefer Modern Layout Primitives

- Use flexbox and grid for primary layout work
- Use `gap` for sibling spacing when the container owns the rhythm
- Use `minmax()`, `clamp()`, `min()`, and `max()` when they simplify responsive
  behavior
- Reach for container queries when a component depends on its own available
  space rather than the whole viewport

### 6. Tokenize Repeated Decisions

- Put colors, spacing, radius, shadows, durations, and z-index scales in CSS
  custom properties
- Prefer semantic tokens at the component or theme boundary
- Do not repeat hard-coded values across unrelated selectors unless the
  duplication is genuinely incidental

### 7. Favor Resilient Sizing and Internationalization

- Prefer relative and content-aware units where appropriate: `rem`, `%`, `fr`,
  `ch`, `lh`
- Prefer logical properties such as `margin-inline`, `padding-block`, and
  `inline-size` when layout should survive writing-mode and direction changes
- Check long labels, wrapped text, empty states, and overflow before calling the
  styling done

### 8. Comment Intent, Not Syntax

- Comment non-obvious constraints, hacks, browser quirks, or coupling
- Do not explain what obvious declarations already say
- Remove obsolete comments when the implementation changes

## Recommended Structure

When adding or reorganizing a stylesheet, prefer an order like this:

1. Tokens
2. Base or reset adjustments
3. Layout or object primitives
4. Components
5. Utilities and explicit overrides

For a small single-file stylesheet, clear section headers are enough. For a
larger surface, split by domain or component once related rules stop fitting in
one file cleanly.

## Workflow

### 1. Read Before Writing

- Identify the owning component and the exact rule that currently wins
- Inspect computed styles before adding overrides
- Decide whether the change belongs to tokens, layout, component styling, or a
  utility

### 2. Fix the Right Layer

- If the problem is repeated values, add or adjust a custom property
- If the problem is ordering, fix source order or use `@layer`
- If the problem is specificity, simplify selectors rather than escalating them
- If the problem is layout, revisit box model, intrinsic sizing, overflow, and
  flex/grid behavior before adding positional hacks

### 3. Implement the Smallest Structural Change

- Prefer adjusting an existing class API over introducing a one-off descendant
  override
- Add a modifier or utility only when the variation is real and reusable
- Delete redundant rules created by the fix instead of leaving dead weight

### 4. Validate Across States

- Check narrow, typical, and wide widths
- Check hover, focus, selected, disabled, empty, and error states when relevant
- Check long content and wrapping behavior

### 5. Debug with the Browser's Mental Model

- Trace cascade, inheritance, specificity, and source order in DevTools
- Verify which rule wins and why
- Treat layout bugs as box-model or sizing problems first, not as reasons to add
  more selectors

## Anti-Patterns

- Styling primarily by DOM location, such as `.dialog .content ul li a`
- ID selectors in CSS
- Deep nesting that recreates markup structure instead of styling a component API
- Reactive `!important` to beat an avoidable selector problem
- Magic numbers with no explanation when they encode a real constraint
- Repeating colors or spacing values everywhere instead of tokenizing them
- Using margins on every child when container-managed `gap` is clearer
- Global element selectors that accidentally restyle embedded or third-party UI

## Decision Rules

When multiple CSS options seem plausible, prefer the one that:

1. Uses the fewest selector parts
2. Keeps the change closest to the owning component or token
3. Preserves reuse outside the current page location
4. Avoids creating a new exception that later needs another exception

## Output Expectations

When using this skill, produce:

- Raw CSS or CSS-adjacent edits that match the repository's existing style
- Short rationale for any new naming or layering pattern introduced
- Minimal override depth and no avoidable specificity escalation
- Responsive behavior that is intentional rather than patched after the fact

## Verification

Before finishing, confirm all of the following:

- [ ] Selectors remain short and mostly class-based
- [ ] Repeated design decisions are tokenized where that reduces real coupling
- [ ] Primary layout uses flexbox, grid, or other modern primitives where useful
- [ ] Responsive behavior is checked at small, medium, and large widths
- [ ] No new deep descendant chains or reactive `!important` rules were added
- [ ] Comments explain only non-obvious behavior or constraints

If the change only works because the selector became more specific than the rest
of the stylesheet, treat that as a design smell and keep refactoring.