# Refactor: Skill Pruner Extension

Extracted oversized logic from the `before_agent_start` event handler in `extensions/skill-pruner/index.ts` into standalone module-scope helper functions.

## Functions Extracted

1.  **`shouldSkipPruning(event, activeConfig)`**:
    Handles the extension toggle check, "off" mode short-circuit, and the `MIN_PROMPT_LENGTH` guard.

2.  **`resolveVisibleSkills(skills, activeConfig)`**:
    Filters out skills with `disableModelInvocation` and resolves forced-include (pinned/alwaysKeep) skill names, including validation/warnings for disabled or missing skills.

3.  **`applySkillSelection(visibleSkills, llmSelectedSkills, effectivePinned, activeConfig, skillsExplicitlyEmpty)`**:
    Applies the LLM's skill selection, handles the union with pinned skills, applies the ceiling, and implements the per-category fail-open logic.

4.  **`applyToolSelection(allTools, llmSelectedTools, activeConfig, toolsExplicitlyEmpty)`**:
    Applies the LLM's tool selection, handles forced-keep tools, expands dependencies, applies the ceiling, and implements the per-category fail-open logic.

5.  **`buildPruningPayload(...)`**:
    Constructs the `PruningResult` object from the accumulated results and diagnostics.

## Orchestration Flow

The `before_agent_start` handler was reduced from ~700+ lines to ~100 lines of high-level orchestration:
- Configuration and session resolution.
- Skip checks.
- LLM prepass execution (via `runPruningPrepass`).
- Selection application (skills and tools).
- System prompt modification and decision logging.
- Feedback message generation.

## Validation

- Ran `npm run extensions:test` in the root directory.
- `skill-pruner` tests: 106 passed, 0 failed.
- Verified that existing behavior, including fail-open edge cases and error handling, is preserved.
