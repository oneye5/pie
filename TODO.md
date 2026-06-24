# Nested Subagent Enablement — Work Plan

Goal: make agents trigger nested subagents more often, safely.

## Scope (decided)
- **A** — `worker.md`: prompt encourages delegating independent sub-steps (scout for recon, worker for sub-impl), parallel when independent.
- **B** — `subagent` tool `description`/`promptSnippet`: advertise that subagents may delegate further (depth-limited).
- **C** — Open `scout` to nesting via new `canSpawn` frontmatter allowlist → preserves read-only invariant (scout can only spawn `scout`). `reviewer` stays a leaf.
- **D** — `MAX_DEPTH` env-configurable (`PIE_SUBAGENT_MAX_DEPTH`), exposed in the pie settings menu.
- **E** — Tree-wide session budget (shared counter via AsyncLocalStorage), env-configurable (`PIE_SUBAGENT_MAX_TREE_SESSIONS`), exposed in the pie settings menu.

## Protections (kept)
- `MAX_DEPTH` (default 3, now configurable) — caps nesting depth.
- `MAX_SESSIONS_PER_CALL` = 20 — per-tool-call breadth.
- `MAX_PARALLEL_TASKS` = 8 / `MAX_CONCURRENCY` = 4.
- `checkTrailLoop` — same agent ≥2× in ancestry blocked.
- **NEW** `canSpawn` allowlist — caller-restricted spawning.
- **NEW** tree-wide session budget — caps total sessions across the nested tree (default 50).

## Tasks

### Subagent extension (self-contained)
- [x] `agents.ts`: add `canSpawn?: string[]` to `AgentConfig`; parse from frontmatter (reuse list parser).
- [x] `runner.ts`: extend `SubagentRuntimeContext` (`canSpawn?`, `budget?`); add `getMaxDepth()` + `getMaxTreeSessions()` resolvers + `consumeTreeSlot()`; fix stale `noExtensions` comment.
- [x] `src/execute.ts`: use `getMaxDepth()`; canSpawn enforcement; ensure budget at root; new error responses.
- [x] `src/modes.ts`: `buildRuntime` threads `canSpawn` (child's) + shared `budget`; consume tree slot at each spawn point.
- [x] `agents/scout.md`: add `subagent` to `tools`, add `canSpawn: [scout]`.
- [x] `agents/worker.md`: delegation guidance (A).
- [x] `src/register.ts`: advertise nesting (B).
- [x] `README.md`: update Limits section.
- [x] tests: canSpawn enforcement; tree budget; configurable depth (`nesting-controls.test.ts`).

### Pie settings menu plumbing (live runtime prefs, mirrors `subagentAlwaysParentModel`)
- [x] `shared/protocol/settings.ts`: `subagentMaxDepth`, `subagentMaxTreeSessions` in `ChatPrefs` + defaults.
- [x] `shared/protocol-validation.ts`: numericRanges entries.
- [x] `backend/rpc.ts`: `RuntimePrefsSetParams` + validation.
- [x] `backend/request-handler.ts`: set `PIE_SUBAGENT_*` env vars.
- [x] `host/session-service/startup.ts`: send on startup.
- [x] `host/session-service/service.ts`: send on setPrefs.
- [x] `webview/panel/composer/settings-menu-subcomponents.tsx`: two range sliders in `SubagentSettings`.

### Verify
- [x] `npm run extensions:test -- --package subagent` (454 pass, 96.6% lines / 90.4% branches)
- [x] `cd extension && npm run typecheck && npm run build` (synced)
- [x] `cd extension && npm test` (1579 pass, 0 fail in isolation)
- [~] reviewer subagent: blocked by stale in-process module cache (running pi loaded old extension source at startup); self-review completed instead. **Restart pi** to load the new extension source and exercise nesting live.

## Known limitations / deferred
- Model-retry path (`runWithModelRetry`) may spawn up to `MAX_MODEL_RETRIES+1` sessions but consumes only one tree slot — consistent with the existing per-call `MAX_SESSIONS_PER_CALL` counter. Acceptable for a safety cap; revisit if model-failure cascades become a cost problem.
- New knobs are NOT added to `FunctionalSettingsSnapshot` (run-analytics) — they're runtime config, not per-run analytics. Add later if per-run depth/budget analytics are wanted.
- `reviewer` remains a leaf (no `subagent` tool) by design.
