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

---

# Expandable UI refinement — deferred

- `aria-controls`/`id` is not wired between any expandable header and its body.
  The shared `<Collapsible>` (`extension/src/webview/panel/components/collapsible.tsx`)
  intentionally renders its body only when `open` (perf: reasoning/tool/subagent
  bodies are heavy). A correct `aria-controls` would require keeping the body
  mounted with `hidden` when collapsed — revisit if that perf cost is acceptable,
  or wire it per-site for already-always-rendered bodies.
- Composite headers (`ToolCallHeader`, `SubagentSingleBlock`) use a
  `role="button"` div rather than a real `<button>` because they contain nested
  interactive controls (copy-error `StatusChip`, file/path buttons). A real
  `<button>` cannot contain button descendants, so this is the established
  pattern. A future pass could split the leading label into a real `<button>`
  toggle and lift action buttons out as siblings (changes hitbox UX).

---

# Pruning keep-all safeguard labeling — done; deferred follow-ups

The prepass panel labeled any 100%-prune keep-all as "Fail-open" with reason
"keeping all as fail-open", which misframes a *legitimate* full prune (e.g. a
non-coding query needing zero dev-skills) as an LLM error. Fixed (behavior
unchanged): label → "Keep-all safeguard", reason strings → "keeping all as a
safeguard", comments/README/protocol doc reworded, and the skill comment no
longer claims "almost always a misunderstanding".

Deferred (intentionally NOT done in this pass):
- **Field rename** `prepassFailOpenReason` / `failOpenReason` → something neutral
  (e.g. `prepassSafeguardReason`). Kept for protocol/analytics/transcript
  stability; renaming ripples through webview parser, types, message-builders,
  analytics schema, and ~15 test assertions. Revisit if the vocabulary drift
  becomes confusing.
- **Distinguish legitimate full-prune from over-prune** (declined). The keep-all
  safeguard still fires for correct 100% prunes. A future heuristic (e.g. detect
  non-coding queries, or trust the prepass when reasoning explicitly justifies
  a full prune) could let correct full-prunes through. Tools stay fail-open
  regardless (zero tools is fatal).

---

# Dead-code / styling pruning — deferred (2026-06-25)

Committed in `f6ec55f`. The following were intentionally NOT committed:

## Left in working tree (concurrent WIP interleaved) — LANDED in `245f351`
Dead-code cleanups that were deferred because the files carried concurrent
files-reviewed feature work. They landed with that feature in `245f351`:
- `analysis/scripts/source.ts` — removed dead export `DEFAULT_SITE_DIST_DIR`
- `analysis/test/pipeline-e2e.test.ts` — removed unused imports (`deepClone`, `RunOutcome`, `SiteDataBundle`, `PreparedRunRow`)
- `analysis/test/stratified-ranker.test.ts` — removed unused import `RunOutcomeResolution`

## Pre-existing lint debt (not introduced by this pass)
- 6 `prefer-const` errors in extension test files: `let runner: EffectRunner;` is
  declared early and assigned late because a closure references it, so it cannot
  be `const` without a TS use-before-declaration error. Needs test restructure.
  `npm run lint` was already failing on these before this pass (11 → 6 problems).
- `@typescript-eslint/no-unused-vars` is `off` for `extension/test/**` by project
  convention, so ~20 unused test imports/vars there are tolerated.
- skylos reports ~24 extension source files + `extensions/subagent/src/execute.ts`
  as having "unused imports"; `tsc --noUnusedLocals` confirms these are false
  positives (extension `src/` is fully clean). Not dead — do not remove.

---

# Files-reviewed analytics — optional follow-ups (2026-06-25)

`readCountsByFile` capture + `filesReviewedCount` / `readRevisitRate` derivations
+ the "Files reviewed per run" dashboard chart landed in `245f351`. Deliberately
scoped out (revisit only if wanted):
- DuckDB `runs` table columns for `files_reviewed_count` / `read_revisit_rate` (and
  a `file_review` view) for ad-hoc SQL. Omitted to match the `editRevisitRate`
  precedent — churn rates live only in `run-summary.json`, not in DuckDB.
- A "files reviewed" aggregate (median/mean across runs) in `OverviewData`.
- `filesReviewedCount` as a complexity signal / leaderboard dimension — would shift
  rankings; add only if a breadth-of-investigation quality signal is wanted.

---

# Changed-files rail moved to the LEFT — deferred follow-ups (2026-06-25)

Committed in `8548ce0`. The rail was relocated from the right side of the panel
to the left, so the collapsed sliver no longer collides with the transcript's
right-edge scrollbar (scroll-overshoot was accidentally opening the peek/pin).
Sliver + peek/pin behavior and visuals are unchanged, only mirrored. No
gating heuristics were added — left placement removes the collision
structurally (no scrollbar on the left; reading-rest never reaches the rail).

Deferred / out of scope (revisit if wanted):
- **Doc drift**: `docs/CHANGED-FILES-UI-PLAN.md` still describes the rail as
  "right-side" with a "left-edge handle" and "LEFT-casting shadow". It is a
  historical design plan; update the positional descriptors if it should
  reflect current positioning, or leave as-is as a design record.
- **Peek covering**: peek (overlay) now anchors `left:0` and covers the start
  of agent replies during a *deliberate* glance (~260px). Acceptable since
  left placement makes peeks deliberate-only, but if the covering cost
  matters, narrow the peek `--file-changes-drawer-width` (260→~190) or make
  peek in-flow (nudge) so it covers nothing. Pin is in-flow and unaffected.

Unrelated (NOT from this task — left uncommitted, per AGENTS.md):
- A concurrent in-flight `FileName` button↔span refactor in
  `file-changes-panel.tsx` + `file-changes.css` (the whole path is now the
  click hitbox) is present in the working tree but was NOT committed with the
  rail move. That refactor changed the row DOM
  (`<button class="file-change-name">` → `<button class="file-change-path-text"><span class="file-change-name">`)
  but did not update the 3 `FileChangesPanel` tests that assert
  `<button class="file-change-name">`, so those 3 tests currently FAIL in the
  working tree. The rail-move commit `8548ce0` excluded that refactor and is
  green. Whoever owns the `FileName` refactor needs to update:
  - `FileChangesPanel collapsed: renders sliver + aggregate header (SSR-safe)`
  - `FileChangesPanel pinned: renders right resize handle + close, no sliver`
    (the `resize-handle-right` assertion passes; only the `<button class="file-change-name">` assertion fails)
  - `FileChangesPanel pinned: deleted row is disabled with a Deleted title`
