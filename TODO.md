# Codebase review — in progress

Orchestrated pass over `docs/internal/code-review/SUMMARY_structural_issues.md`
(backlog S1–S11). Status legend: planned / scouting / in progress / in review /
done / deferred (needs user decision).

| Item | Issue | Status | Commit |
|---|---|---|---|
| W1 — Re-render hot path (memoize render boundary, stabilize `availableModels`) | S5 | done | `bd1eced` |
| W8 — Extract `evictSession(state, sp, {removeSummary, removeTabs})` | S1 / 02 C1 | done | `034ef31` |
| W9a — Archive/delete one-shot codemods | S10 | done | `58c7adf` (move `73073e1` prior) |
| W6 — Reconcile docs with `STATE_CONTRACT.md` | S7 | done | `2310d2e` |
| W2a — Thinking-level enum shared module | S1 | done | `c66b38e` |
| W2b — Pruning-summary math helper | S1 | done | `0c1b01d` |
| W2c — Checkpoint parse/read helpers | S1 | done | `dec9284` |
| W2d — Path utilities shared module | S1 | done | `99681d7` |
| W2e — Token formatting factory | S1 | done | `b267880` |
| W2f — Pricing logic across 3 packages | S1 | done | `f2253ca` |
| W2g — Coercion / failure-kind taxonomy (4 kind unions → shared/) | S1 | done | `4e91679` |
| W3 — Decompose `EffectRunner.run()` into dispatch table | S2 / 02 H1-H2 | deferred (frontier subagent blocked by session usage limit) | — |
| W4 — Tighten boundary-typing ring | S6 | deferred (frontier subagent blocked by session usage limit) | — |
| W5 — Fix silent error swallowing + atomic persistence + versioned migration | S3 | deferred (frontier + needs versioned-migration design decision) | — |
| W9b — Install-script portability | S10 | deferred (install-script edits need careful testing) | — |
| W7 — Refactor-hostile tests → behavior tests | S8 | deferred (after W3) | — |

## Decisions pending (resolve before resuming)
- **W5 versioned-migration design** — `parseCheckpoint` returns null on schemaVersion
  mismatch today; the next schema bump silently drops all user analytics. Need a
  version-table shape + migration path before implementing atomic persistence.
  Propose options to the user before spawning.
- **W2g type ownership — RESOLVED (user discretion):** option (a) — `shared/`
  owns the canonical 4 kind unions; both `extension/src/shared/tool-call-analysis`
  and `analysis/scripts/contracts.ts` re-export from there. Matches the W2f
  `shared/pricing-core.ts` precedent (shared/ already bridges analysis + extension
  via relative `.js` imports under NodeNext; a direct analysis↔extension cross-tree
  import would clash across bundler-vs-NodeNext resolution). Scope = the 4 unions +
  their `*_KINDS` const arrays (the taxonomy); the heavier coercion-*function*
  dedup (`coerceToolUsageRollup` etc.) is left as a follow-up.

## Discovered follow-ups (not in original backlog)
- **`pruning-settings.ts:24` `VALID_MODES`** omits `'custom'` (mirrors the
  `VALID_PRUNING_MODES` drift W2a fixed in protocol-validation). Host-side
  persistence may reject a `custom` pruning mode. Fix in a follow-up.
- **Analysis 95% line-coverage gate is already failing** (70.4% baseline, measured
  with the original pre-W2f `analysis/scripts/pricing.ts`). Pre-existing, NOT a
  W2f regression (W2f: 70.4%→70.4%, branches 87.3%→87.2%). The 95% gate in
  `scripts/run-tests.mjs:28` is hostile to cross-package extraction (extracted,
  well-covered code leaves the package's coverage scope). Revisit the threshold
  or the coverage-include strategy.
- **`isTaskBoundaryIntent`** in `stats-service/helpers.ts` is now unused after
  W2c (inlined into the shared checkpoint-io module). Safe to remove in a
  follow-up.
- **Dead `truncateText` wrapper** in `tool-call-summary.ts` after W2d (no
  remaining callers). Safe to remove.
- **W2g follow-up — `*_KINDS` const arrays remain duplicated** between
  `extension/src/host/run-analytics/coercion-rollups.ts` and
  `analysis/scripts/source.ts`. `VERIFICATION_COMMAND_KINDS` /
  `TOOL_FAILURE_KINDS` / `TOOL_RESULT_ISSUE_KINDS` are byte-identical arrays in
  both trees; `TREATMENT_CHANGE_KINDS` is an `array` in `coercion-rollups.ts`
  but a `new Set<TreatmentChangeKind>([…])` in `source.ts` (structural
  divergence → not merged). The coercion *functions*
  (`coerceToolUsageRollup`, `createEmpty*KindRecord`, `LEGACY_*_MAP`, sample
  splitting) also remain duplicated. A follow-up could converge all `*_KINDS`
  into `shared/tool-analysis-kinds.ts` (blessing the array form, with
  `source.ts` constructing its `Set` from it) and dedup the coercion functions
  into a shared `coercion-core.ts` — a larger, separate effort.
- **`header.ts` token grouping** changed from host-locale to `en-US` in W2e
  (intentional, deterministic). Confirmed acceptable.
- **`handleSessionClosed`** now drops the session summary (via
  `evictSession({removeSummary:true})`) where the old `removeSessionFromState`
  retained it. Currently unobservable (`SessionClosed` has no dispatch site) and
  aligns with full-eviction intent. Flagged by the W8 reviewer for awareness.

---

# Nested subagent expandable UI — sticky/scroll/overlap fix (2026-06-25)

The nested (depth ≥ 2) subagent header was `position: sticky` inside the
parent subagent's bounded scroll region, so it pinned to the parent's scroll
port and bled over the parent's own sticky header (12–19px measured overlap
via headless-Chrome CDP), and the nested body opened a second stacked 240px
scroll container (nested-scroll hell). Fixed for depth ≥ 2 only (depth-1
unchanged):

- `tool-call-item.tsx`: `SubagentSingleBlock` computes `isNested =
  subagentDepth > 1`; nested header gets `subagent-header-nested`;
  `SubagentMessages` gains `isNested` → body gets `subagent-messages-scroll-
  nested` and skips resize handles.
- `tool-call.css`: `.subagent-header-nested { position: relative; top: auto;
  z-index: auto; }` (relative preserves the pending-ask-user `::after`
  anchor; z-index auto lets the parent's z-10 sticky header cover it instead
  of the nested header bleeding over); `.subagent-messages-scroll-nested {
  max-height: none; min-height: 0; overflow-y: visible; }` (flows inside the
  parent's single bounded scroll region).
- `test/nested-subagent-expand.test.ts` (NEW, 10 tests): nested recursion
  expand/collapse + toggle independence, depth-1-vs-nested class/CSS
  assertions, and a depth-3 fixture proving `subagentDepth` keeps
  incrementing so every level ≥ 2 is nested.

Verified: `npm test` (1591 pass), `typecheck`, `lint` green; real-browser CDP
confirms depth-1 stays sticky/capped and nested is relative/free-flowing with
no nested-over-outer bleed.

---

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

# Expandable UI refinement — aria-controls wired (2026-06-25)

- `aria-controls`/`id` is now wired between every expandable header and its
  body. `Collapsible` (reasoning / pruning-details / pruning-inline),
  `ToolCallCard` (`.tool-call-body-wrap`), and `SubagentSingleBlock`
  (`.subagent-messages`) each generate a stable `useId()` per instance: the
  header carries `aria-controls={bodyId}` and the body carries `id={bodyId}`.
  Because the bodies are lazily mounted only when open (perf: bodies are
  heavy), `aria-controls` is set ONLY when the body is actually mounted and
  omitted when collapsed — so the reference never points at a missing element
  (WAI-ARIA-correct). No mount-strategy / perf change. Pinned by
  `extension/test/aria-controls-wiring.test.ts`.
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
  (e.g. `prepassSafeguardReason`). **DONE 2026-06-25**: renamed to
  `prepassSafeguardReason` / `safeguardReason` (+ `skillSafeguardReason` /
  `toolSafeguardReason` locals) across the extension webview + skill-pruner
  producer/consumer (commit `964e133`). The host passes pruning details JSON
  through opaquely, so producer + consumer ship together; historical analytics
  query text mentioning the old name was left unchanged. Extension + skill-pruner
  tests green.
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
- 6 `prefer-const` errors in extension test files (`let runner: EffectRunner;`
  declared early, assigned late because a hoisted `dispatchArch` closure
  references it). **RESOLVED 2026-06-25 maintenance pass**: converted to a plain
  `const runner = new EffectRunner(deps);` reorder — verified this repo's eslint
  config has `no-use-before-define` OFF and TS does not flag deferred-body
  references, so no use-before-declaration error. `npm run lint` + `typecheck`
  now clean (5 test files: close/create/duplicate/open-session-ordering +
  session-tab-actions).
- `@typescript-eslint/no-unused-vars` is `off` for `extension/test/**` by project
  convention, so ~20 unused test imports/vars there are tolerated.
- skylos reports ~24 extension source files + `extensions/subagent/src/execute.ts`
  as having "unused imports"; `tsc --noUnusedLocals` confirms these are false
  positives (extension `src/` is fully clean). Not dead — do not remove.
  **Re-verified 2026-06-25**: `tsc --noUnusedLocals` across extension / subagent /
  skill-pruner reports ZERO unused symbols in any `src/` file; the only
  genuinely-unused import in the repo was `sum` in
  `analysis/site/charts/toolduration.ts` (removed).

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
- **Doc drift**: `docs/CHANGED-FILES-UI-PLAN.md` previously described the rail
  as "right-side" with a "left-edge handle" and "left-casting shadow".
  **RESOLVED 2026-06-25 maintenance pass**: corrected the 7 stale positional
  descriptors to match the left-side reality AND added a move-note under
  "Post-implementation revisions" referencing commit `8548ce0`. Also fixed the
  stale `left-edge handle` → `right-edge handle` header comment in
  `extension/src/webview/panel/styles/file-changes.css`.
- **Peek covering**: peek (overlay) now anchors `left:0` and covers the start
  of agent replies during a *deliberate* glance (~260px). Acceptable since
  left placement makes peeks deliberate-only, but if the covering cost
  matters, narrow the peek `--file-changes-drawer-width` (260→~190) or make
  peek in-flow (nudge) so it covers nothing. Pin is in-flow and unaffected.

LANDED in `eb7edc0` ("Make file path the open-in-editor hitbox"): the
`FileName` button↔span refactor (whole path is the click hitbox; row DOM
`<button class="file-change-name">` → `<button class="file-change-path-text">
<span class="file-change-name">`) was committed together with updates to the 3
`FileChangesPanel` tests. **Verified 2026-06-25**: all 3 tests pass green on
clean HEAD; no outstanding work here.

---

# Codebase-maintenance pass (2026-06-25)

Ran the `codebase-maintenance` skill (dead-code → smells → duplicates →
complexity → large-files → lint/test → gitignore → doc-drift). All green;
smells (semgrep) clean. Outcomes:

Done:
- **Dead code**: `tsc --noUnusedLocals` verified the skylos import findings in
  `extension/src/` + `extensions/subagent/src/` are false positives (src fully
  clean). Removed the one real dead import: `sum` in
  `analysis/site/charts/toolduration.ts`. (Test-file unused imports tolerated
  by convention — `no-unused-vars` off for `extension/test/**`.)
- **Lint debt**: 6 pre-existing `prefer-const` errors fixed via plain `const`
  reorder (see section above).
- **Duplicates**: extracted shared `loadModelsJsonProviders()` into
  `analysis/scripts/load-models.ts` (DRY for `model-family.ts` + `pricing.ts`,
  same package, behavior-preserving). Documented the cross-package
  `coercion-rollups.ts` ↔ `analysis/scripts/source.ts` duplication with
  "keep synchronized" headers (mirrors `backend/pricing.ts` pattern; extraction
  undesirable — would create a cross-package dep). Other dupes justified
  (test fixtures, documented structural dup).
- **Large files / complexity**: split `settings-menu-subcomponents.tsx`
  (996→535, UI-appearance block → new `ui-appearance-settings.tsx`) and
  `skill-pruner/src/pruning.ts` (553→246, prepass → new `prepass.ts`). All 10
  high-complexity functions are domain-appropriate dispatchers/validators
  (left as-is). Removed a stale "TEMP DIAGNOSTICS" console.log block in
  `composer/hooks.ts`.
- **Doc drift**: corrected `CHANGED-FILES-UI-PLAN.md` positional descriptors
  (see section above). Markdown-drift scan otherwise clean (only 2 README
  `npmjs.com` URLs return 403 — bot-blocking, verified not broken; left as-is).

New deferred follow-ups (from this pass):
- **`extension/src/host/sidebar/provider.ts` (677loc)** — soft multi-concern
  split. **DONE 2026-06-25** (commit `d49fbcf`-1): extracted `SidebarHotReloader`
  (`hot-reloader.ts`, 186loc) + `StateAppliedWatchdog` (`state-applied-watchdog.ts`,
  198loc) into siblings; provider.ts now 422loc as the orchestrator. Behavior-
  preserving; added `test/state-applied-watchdog.test.ts` for the throttle
  window + ack-clearing logic.
- **`extensions/skill-pruner` has no `tsconfig.json`** → no standing typecheck
  gate; 2 genuine pre-existing type issues were undetected by CI. **DONE
  2026-06-25** (commit `57aa6ab`): added `tsconfig.json` (ESM/bundler config +
  ambient stubs for the `@mariozechner/pi-*` peer packages so the gate covers
  internal types without flagging pi-API drift) + `types-global.d.ts`; fixed
  the 2 issues (`llm-scorer.ts` filter type predicate, `logger.test.ts`
  stale PruningDecision fixtures); wired `extensions:typecheck` into the root
  `typecheck` chain. pi-API drift (pi-tui theme signature, AgentToolResult/
  CustomMessage) remains a separate follow-up.
- **`AlwaysKeepPicker` promotion** to `components/` **DONE 2026-06-25** (commit
  `d49fbcf`): co-located `filterKeepCatalog` (its only consumer) with the picker
  in `components/always-keep-picker.tsx` so the move needs no `components/ →
  composer/` back-dependency; barrel re-exports preserved.
