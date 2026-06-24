# TODO — Deferred work

> **STATUS — 2026-06-24:** The deferred items below have been addressed and
> committed (composer-cleanup was already committed previously). The rest of
> this file is retained as the historical decision record.
>
> - `2c24267` — stratified ranker reweighted to `fileChurn` (dropped
>   `firstAttemptSuccess` from the composite; retained on `PreparedRunRow`).
> - `0985a90` — analytics: over-pruning signals (`skill_miss` /
>   `shadow_miss_candidate` / `tool_recovered`) ingested end-to-end + a
>   "prunes recovered" rate chart; other model-grouped views
>   (`createModelQuality`, `createTimeline.modelMix`, 11 dashboard views)
>   + the model filter dropdown re-keyed `modelId` → `modelFamily`
>   (fallback to `modelId`), mirroring the leaderboard.
> - `7cd3acd` — sticky expand/collapse headers extended to reasoning +
>   subagent blocks (`Collapsible.stickyHeader`; `.subagent-header`
>   `position:sticky` + `overflow:clip` root).
> - `a86d478` — UI controllability committed. **Supersedes the
>   "UI controllability (UNCOMMITTED)" note below:** the 3 mixed files
>   had already landed in `8fc7965`; this ships the remaining
>   settings/styles/flyout/tests and fixes the expanded-text slider max
>   (28 → 32) + base/composer font maxes to match `protocol-validation`.
> - `cf10bd9` — skill-pruner parse-failure fail-open observability
>   (`keptAllDueToParseFailure` → `prepassFailOpenReason`). Bundled in the
>   same commit (intertwined in the same files, all green/tested):
>   `getRecentConversation` context, model/auth try-catch fail-open,
>   diagnostic + input-handler removal.
> - Build artifacts regenerated from `data/outcomes/7161a5ef2dd349b4`;
>   `validate-site-data` passes (no longer stale).
> - `composer.draftTextBySession` cleanup parity was already committed.
>
> **Not autonomously addressed:**
> - **D7 tuning** (grace/close durations, new-command-during-grace) is
>   subjective UX feel — documented defaults retained; needs human runtime
>   testing to tune.
> - **Changed-files UI secondary findings** (sort by magnitude/status;
>   group by status; `hasNewChanges` → host state; resize-handle on peek)
>   remain deferred-by-design — each is gated on a trigger in its own note
>   ("revisit if", "only if reported", "out of scope; could later").
>
> **Deliberately left uncommitted (unrelated to these items):**
> - `settings.json` — a personal pruning model/provider swap.
> - `analysis/site/charts/toolduration.ts` — an unrelated tooltip-label
>   polish ("Total time" → "Total time (s)").

## Skill-pruner prune-list refactor — deferred follow-ups

**Implemented:** Flipped the pruner from an inclusion-list (LLM names what to
KEEP; empty = prune everything) to a **prune-list / exclusion** schema (LLM
names what to REMOVE; empty/missing = keep all). This fixes the "LLM returns
nothing → everything pruned" mismatch and makes the pruner keep-biased: the
system prompt now reasons about the full arc of work and infers implications
rather than hardcoding skill→task rules. Tool-pruning decisions are now written
to `data/pruning.jsonl` — the analytics contract already had the optional
`toolIncluded`/`toolExcluded`/`toolBlockTokens`/`originalToolBlockTokens`
fields, they were just never populated. `ceiling` is now soft guidance
communicated to the LLM, not a hard post-hoc clamp (hard-enforcing would force
over-pruning). Dependency handling switched from expansion to *protection*: a
dependency of a kept tool is protected from pruning. A `tool_recovered` event
is logged whenever the agent re-enables a pruned tool via `request_tool`.

### Deferred — analytics ingestion of over-pruning signals (out of scope; data now logged)
`data/pruning.jsonl` now carries three quality signals the analytics dashboard
does NOT yet ingest (`analysis/scripts/source.ts` `readPruningDecisions`
filters to decision-shaped lines, skipping events lacking `included`/`excluded`):
- `skill_miss` / `shadow_miss_candidate` — the agent read a skill the pruner
  had pruned (a wrong-prune). Logged since before this refactor; still un-ingested.
- `tool_recovered` — the agent called `request_tool` to re-enable a pruned tool
  (new). The most direct over-pruning metric.
Wiring these into `contracts.ts` / `prepare.ts` / `duckdb.ts` / `site-data.ts` /
the pruning charts (e.g. a "prunes that were recovered" rate) would close the
feedback loop. Foundation is in place (events logged with `sessionId` +
`timestamp`); only the pipeline + chart are missing.

### Deferred — parse-failure observability (minor)
When the prepass LLM returns non-empty non-JSON prose, `parseLlmResponse` now
resolves to keep-all (the phase-3 prose-name scrape was removed because prose
usually names items to KEEP, which would invert intent). This is the safe
default but is indistinguishable in analytics from "model correctly kept all"
except by inspecting `llmResponse`. If schema-regression observability matters,
thread a `keptAllDueToParseFailure` flag from `parseLlmResponse` →
`runLlmPruning` → `PrepassRunResult` → a `prepassFailOpenReason`-style note.

## Sticky expand/collapse header — extend to reasoning + subagent (follow-up)

**Implemented (tool-call cards):** the tool-call expand/collapse hitbox is now a
single full-width `role=button` with a clear hover/focus affordance and a
larger min-height, and the header is `position: sticky; top: 0` so a tall open
body never strands the collapse control off-screen. The card root switched
`overflow: hidden` → `overflow: clip` (clips to rounded corners identically but
is NOT a scroll container, so it doesn't trap the sticky header). See commit
`refactor(panel): clear, full-width + sticky tool-call expand/collapse hitbox`.

**Deferred — same treatment for the other expandable sections:**
- **Reasoning blocks** (`reasoning-block.tsx`, via the generic `Collapsible`):
  its hitbox is already a clear full-width `<button>` with hover/focus, so only
  the *sticky* part is missing. Reasoning is capped at
  `--expanded-section-max-height` (240px) so sticky rarely triggers, but for
  consistency a `stickyHeader` opt-in on `Collapsible` (opaque header bg when
  stuck) would help long blocks the user resizes tall. The generic `Collapsible`
  has no `overflow` trap, so sticky works without an `overflow: clip` change
  there — the only design question is the opaque header background (reasoning's
  open body is `bg-control/60` translucent, so a pinned header needs a chosen
  opaque surface).
- **Subagent threads** (`tool-call-item.tsx` `SubagentBlock` + `.subagent-header`):
  can be very tall (nested transcript) but use a different header component and
  a wrapper with `overflow-hidden` (which would trap sticky — needs the same
  `overflow: clip` swap). Revisit if the tool-call sticky pattern reads well.

## Provider-agnostic analytics leaderboard

**Implemented:** the analytics leaderboard (both the site-data `createModelLeaderboard`
and the dashboard's in-browser `leaderboardRows`) now groups by canonical model
family, not the provider-specific `modelId`. Same underlying model offered by
multiple providers (e.g. `umans-glm-5.2` via Umans and `glm-5.2:cloud` via Ollama
Cloud → family `glm-5.2`) collapses into one row. The backend keeps storing each
run's provider-specific `modelId` distinctly; each leaderboard row exposes a
`providers` breakdown (provider-specific ids + run/scored counts) so provider
differences stay investigable. Foundation: optional `family` field in
`models.json` + `model-family.ts` resolver (mirrors `pricing.ts`) +
`PreparedRunRow.modelFamily` (resolved at prepare time) + DuckDB `model_family`
column.

### Deferred — other model-grouped analytics views (out of scope; user asked for the leaderboard only)
`modelFamily` is now on every `PreparedRunRow`, so these are straightforward
follow-ups that reuse the same resolver — no new foundation needed:
- `model-quality.json` (`createModelQuality` in `site-data.ts`) still groups by
  provider-specific `modelId` → shows two rows for the same family.
- Dashboard model-grouped views (`modelThinkingRows`, `compositionByModelRows`,
  `outcomeTimeSummary`, `mutationRows`, time/pareto rows, etc.) and the model
  filter dropdown still key on `modelId`.
- `stratified-ranker.ts` (subagent bucket assignment) groups by `modelId`.

### Deferred — local build artifacts need regeneration (gitignored, user workflow)
`analysis/site/data/`, `analysis/data/exports/`, and `analysis/data/usage.duckdb`
are gitignored local outputs. After this schema change they are stale
(`model-leaderboard.json` lacks `providers`, run-summary rows lack
`modelFamily`, DuckDB lacks `model_family`). Regenerate from the real source via
`npm run export-site-data -- --storage-dir <path>` (the workspace used for the
last committed local data was `7161a5ef2dd349b4`). `npm run validate-site-data`
(default) will flag the stale local data until then.

## Changed-files UI (from docs/CHANGED-FILES-UI-PLAN.md)

**Implemented: D1–D8.** Reviewer-audited; build / typecheck / tests green.
Full decision record lives in the plan doc. Summary:

- **D1** Peek-vs-pin: peek = transient webview-local overlay (reserves no
  space); pin = host state `ViewState.fileChangesExpanded` (in-flow reserved).
  A type-level pin in `sync-contract.test.ts` fails to compile if a
  `fileChangesPeek*` field is ever promoted into ViewState.
- **D2** Collapsed sliver ~48px, full-height: count at top + total `+N`/`-N`
  churn (how much changed, always visible) + an A/M/D kind legend, AND below
  them a read-only vertical list of the affected files, each occupying TWO
  rows — row 1 = kind glyph + truncated basename, row 2 = per-file `+N`/`-N`
  churn — filling the remaining height so the tall sliver's vertical room
  surfaces per-file magnitude (extends the aggregate `+/-` down to each file)
  at a glance. Peek/pin for the full, interactive list; each sliver entry
  carries its full path as a hover `title`. Refined from the original stacked
  +/- diff bar (noise, no magnitude at a glance). The sliver `title` carries
  the full summary (`N · A3 M7 D2 · +X / -Y`).
- **D3** Peek is `position: absolute` over the transcript edge (not a push);
  hover region = rail subtree (sliver ∪ overlay); dismiss on mouse-leave /
  click-outside / Escape.
- **D4** One content model — peek and pin render the same header + file list.
- **D5** Drag-resize width via left-edge `ResizeHandle` (new
  `useResizableWidth`, ephemeral). Default 200px, range 160–480px. Peek ignores
  the drag width (transient; resizing peek is out of scope).
- **D6** Auto-open removed: `autoOpenFileChangesRail` pref +
  `autoExpandedBySession` host state + `shouldAutoOpen` block + 3 send resets
  + cleanup spreads + settings toggle — all deleted. `hasNewChanges` pulse is
  the mid-turn signal.
- **D7** Aggregate header (`N files · +A / -D`) + per-row `+N`/`-N` line stats.
  **Post-impl revision:** the per-row red/green diff bar was removed — it
  restated the `+N`/`-N` numbers beside it and wasted ~40px/row; that space is
  reclaimed for the (ellipsized) file path so more of the path shows at rest.
  Edit-chronology order, no sort. **Iteration 3 (tooltips removed; list
  scrolls):** the expanded drawer no longer wraps the path or the aggregate
  header in `Tooltip` — they obscured the list, so the hover-only detail they
  carried (full path, per-kind breakdown) is dropped in favor of a calm,
  scrollable list. Per-file churn now lives inline on the sliver's second row
  (D2); the drawer's height chain was made flex-based (`display:flex` column +
  `flex:1` inner + `min-height:0`) so `.file-changes-list` reliably scrolls
  when it overflows instead of the drawer growing to fit (`overscroll-behavior:
  contain` keeps the scroll self-contained). The now-dead `triggerClass` prop
  was removed from `Tooltip`.
  **Iteration 2 (row hover = act mode):** the per-row buttons no longer reserve
  space — `.file-change-actions` is `max-width:0; overflow:hidden; opacity:0`
  at rest so the full path fills the row ("read" mode); on row hover/focus the
  two primary buttons (View diff, View in editor) slide in from the left and
  the path collapses to its basename. Copy path + Revert moved to a
  self-contained right-click `FileChangeContextMenu` (two-step revert confirm);
  the in-row `CopyPathButton`/`RevertButton` were deleted.
- **D8** Touch (`matchMedia (hover: hover)` false): tap sliver = peek; pin
  button in peek header = pin. Desktop: hover = peek, click sliver = pin.

### D9 — Tuning parameters (chosen; revisit if felt)
- Hover-intent open delay 160ms, close delay 120ms.
- Default drawer width 200px, drag bounds 160–480px.
- `hasNewChanges` pulse: subtle 1.8s opacity pulse on the accent-colored
  count, `prefers-reduced-motion` guarded.

### Contract change (done)
- `STATE_CONTRACT.md § Webview-Local State` allowlist gained a peek/hover-overlay
  bullet (analogous to `contextMenu`); matching type-level pin in
  `sync-contract.test.ts`. Drag width already covered by `drag state`.

### Secondary findings (still deferred — documented, not implemented)
- Sort by magnitude / status; group by status — revisit if D7 doesn't satisfy.
- `hasNewChanges` is per-component (keyed by `activeSessionPath`), doesn't
  survive tab-switch; move to host state only if reported.
- Resize-handle on peek (out of scope; could "pin on drag" later).
- Peek overlay stacking confirmed vs the floating jump-to-latest button
  (z-index 280) — peek bumped to z-index 300 to clear it (within
  `.panel-main`'s isolated stacking context). No sticky headers exist.

## Activity-tail wrapping (preview bar)

Implemented: the live activity-preview body text now wraps to fill the reserved
width and collapses source newlines (joined with a space; blank lines dropped)
instead of one ellipsis-clipped row per source line. The block keeps its fixed
reserved height (`height: var(--activity-tail-content-min-height)` +
`overflow: hidden`); the text is bottom-anchored so the newest content + caret
stay visible and wrapped overflow clips at the top. The composite header
(`label ▸ input`) stays a clipped one-liner.

### Secondary finding (implemented)
- The truncation top fade is now driven by actual rendered overflow rather than
  the source-line-count proxy. `turn-activity-tail.tsx` measures the wrapped
  content height vs the reserved block height (via a `useContentOverflow` hook
  on `ResizeObserver`; initial state seeded from `lines.length >= 2` so static
  `renderToString` renders behave as before). This catches both "many short
  source lines" and "one long line that wraps across several rows" — the case
  the old `lines.length >= 2` gate missed (`lines.length === 1`).

Implemented: D1–D6.
- D1: reasoning bounded with a resizable `<div>` (uses `useResizableHeight`
  directly + top/bottom `ResizeHandle`, not `ResizablePre`).
- D2: shared `expandedSectionMaxHeight` pref + `--expanded-section-max-height`
  CSS var applied to all four expanded sections (reasoning, shell terminal,
  tool-result `<pre>`, subagent thread).
- D3: default lowered 360px → 240px.
- D4: open-while-running kept unchanged.
- D5: turn-active hold removed; `TurnActiveContext` fully deleted (module +
  providers in `virtual-list.tsx` / `transcript-message-list.tsx` + test
  helper). Close fires per-command after grace.
- D6: close transition 180ms → 300ms (expand keyframe bumped too, to keep the
  documented symmetry). `TOOL_CALL_CLOSE_TRANSITION_MS`/`_GRACE_MS` exported so
  tests track tuning.

### D7 — Tuning parameters (still open)
Play with these for seamlessness:
- Grace duration `TOOL_CALL_CLOSE_GRACE_MS` (currently 1000ms).
- Close duration + easing (currently 300ms `grid-template-rows` + `opacity`).
- New-command-during-grace edge case: recommendation (a) accepted — let the
  prior command finish its slow close (brief double-open). Revisit if janky.

### D8 — Resize handles only when content overflows (implemented)
`useResizableHeight` now exposes `canResize = contentOverflows || height !== null`;
all four expanded sections gate their top/bottom `ResizeHandle` on it. Short
sections (content fits naturally) get no grab strips, so their clickable area
isn't crowded. Handles reappear on overflow, and stay once the user has resized
(so they're never stranded). Decision record in `EXPANDED-SECTION-UI-PLAN.md`.

### Secondary findings (implemented / blocked)
- ✅ ANSI stripped in the terminal pane — new shared `stripAnsiEscapes` applied in
  `textFromToolResult` (highlight.ts), the single display chokepoint, so the
  terminal pane, error detail, and activity tail all render clean text.
- ✅ `exitCode` surfaced — exported `extractExitCode` recovers the numeric code
  (the SDK appends "Command exited with code N" on failure); rendered as a
  danger-tinted `exit N` badge in the terminal footer. Only non-zero (alert on
  failure).
- ✅ Long-line handling — terminal output now `white-space: pre` + horizontal
  scroll (`overflow-x: auto`) instead of `pre-wrap` + `overflow-wrap: anywhere`,
  preserving table/column/progress alignment.
- ⛔ stderr not distinguished from stdout — BLOCKED: the SDK's bash tool pipes
  `child.stdout` and `child.stderr` to the same `onData` handler and merges them
  into one `content` text blob with no discriminator. Distinguishing requires an
  SDK change; a webview heuristic would only guess.
- ✅ "Full log: path" clickable — threaded `onOpenFile` into `ToolCallBody`; the
  path renders as a `ClickablePathButton` (consistent with the header).
- ✅ Reasoning collapsed size hint — `~N lines` in the collapsed header (reuses
  exported `countTextLines`); shown only for multi-line reasoning.
- ✅ Reasoning expanded streaming cursor — `streaming` prop (from the owning
  message's active-streaming state) appends a blinking `.reasoning-stream-cursor`.

## Model leaderboard file-churn reweight — deferred follow-ups

**Implemented:** Reweighted the model leaderboard composite to weight on more
indicative factors. Removed `firstAttemptSuccess` (1-prompt success) from the
composite — it rewarded trivial 1-prompt sessions and penalized great
long-running planning sessions, so it was not a signal of success. Replaced it
with a new `fileChurn` dimension at the same 0.15 weight: the mean per-run
re-edit rate (fraction of EDIT ops that revisited an already-edited file),
inverted so higher = less churn = better. This is "modifying the same snippet
over and over" — the clearest signal the agent kept getting it wrong. fileChurn
is a raw process metric (not mastery-blended, like tokenEfficiency). The signal
is captured end-to-end: a per-file edit-count map (`editCountsByFile`, keyed by
a path hash) is populated at the tool-call level in the extension, persisted,
coerced, and derived into `editRevisitRate` on `PreparedRunRow`. Weights still
sum to 1.0; a dashboard↔Node parity test now guards the two hand-mirrored
implementations from drifting. `firstAttemptSuccess` stays on `PreparedRunRow`
(the interruptions chart uses it) — only the composite dropped it.

### Deferred — propagate the reweight philosophy to the stratified ranker (out of scope)
`analysis/scripts/stratified-ranker.ts` (subagent bucket selection) is a
separate composite with its own equal-weight scoring. It still uses
`firstAttemptSuccess` (weight 1/6) and does not use `fileChurn`/`editRevisitRate`
at all. Per `AGENTS.md` the two leaderboards are intentionally distinct, so
this was left unchanged. But the rationale — "1-prompt success is not a signal;
file churn is the indicative negative" — arguably applies to model selection
broadly, so the stratified ranker is now philosophically inconsistent with the
model leaderboard. If the philosophy should propagate, swap `firstAttemptSuccess`
for `fileChurn` in `computeOutcomeScores` (1/6 weight) and surface
`editRevisitRate`; its tests pin the 6-dim shape and `firstAttemptSuccess`
proportion assertion and would need updating.

### Note — fileChurn is dormant on historical data
`editCountsByFile` is only populated for runs captured after this change (the
extension was rebuilt). Historical runs lack the map → `editRevisitRate` is null
→ the fileChurn dimension is skipped for those rows (consistent with how null
`verificationPassRate`/`tokenEfficiency` dims are dropped, on a <1.0 scale until
data accumulates). The dimension activates as new runs accumulate. No aggregate
churn proxy was possible: `touchedFileCount` is actually op-count
(editCount+writeCount+deleteCount), not distinct files, so per-file capture was
required.

## composer.draftTextBySession cleanup parity — deferred follow-up

**Fixed (in scope):** the "text cleared when a new session finishes loading"
bug. `handlePendingPathReplaced` now migrates `composer.draftTextBySession`
(pending→resolved) like its sibling composer maps, and the webview
`useComposerInput` `[sessionPath]` seed effect preserves live text across the
pending→resolved resolution instead of clobbering it with the stale/empty
draft. Regression tests: `test/arch-pending-path-draft.test.ts`, and the
pending→resolved case in `test/composer-draft.test.ts`.

**Deferred (out of scope, pre-existing latent leak):** `draftTextBySession` is
the one per-session composer map that is NOT cleaned on tab close / eviction.
`handleSessionScopeCleared` (`src/host/core/reducer/session-handlers.ts`) and
`removeSessionFromState` (`src/host/core/reducer/helpers.ts`) both clean
`pendingComposerInputsBySession` + `activeRunSummaryBySession` but omit
`draftTextBySession`; `arch-session-scope-cleanup-parity.test.ts` also omits it
from its `base` setup + `checks` list. Closed/evicted sessions therefore leak
their draft text indefinitely. Low impact (small per-entry; paths are unique so
no stale-revive risk), but it is the same class of bug the parity test exists to
prevent, and Fix A above now makes `draftTextBySession` a formally "migrating"
map, so the inconsistency with cleanup is more visible. To close: add a
`draftTextBySession` destructure+clean to both functions and add it to the
parity test's `base` + `checks`.

## UI controllability — more font/color/sizes + wider slider bounds (implemented, UNCOMMITTED)

**Status: complete & verified, but NOT committed per user instruction** ("dont
commit"). All changes live uncommitted in the working tree. Build / typecheck /
affected tests are green (59/59 affected tests pass; typecheck clean).

**What it adds:**
- **New per-place font sizes** (driven by new `ChatPrefs` fields → CSS vars in
  `app-body.tsx`): `uiBaseFontSize` → `--panel-font-size` (body + `message-prose`
  + inline editor; default 13), `uiComposerFontSize` → `--panel-composer-font-size`
  (the composer `<textarea>` via new `.composer-input-textarea` class; default 13).
  Keeps the existing `expandedSectionFontSize`. Three independent size levers.
- **New color overrides:** `uiMutedColor` → `--panel-muted` (overrides the
  foreground-derived shade; default '' = derived), `uiLinkColor` → `--panel-link`
  (hyperlinks in `.message-body a` + `.ask-prose a` now route through it; default
  '' = follows `--panel-accent`, preserving the bundled gold link look).
- **Widened slider bounds** (UI flyout + `protocol-validation.ts` ranges):
  corner radius 0–16 → 0–24; message width 60–100 → 40–100; expanded height
  120–720 → 80–1600; activity rows 1–6 → 1–12; expanded text 9–18 → 8–32.
- Theme presets extended to 6 color fields (`muted`/`link` added; presets pin
  them to '' so selecting one resets those overrides).

**Why uncommitted — file overlap with concurrent work:** the repo has uncommitted
concurrent "changed-files read state" work (`readFilePaths` / `setFileRead` /
`handleSetFileRead`) by another session. Three of my files carry BOTH my changes
and theirs in separate regions:
- `extension/src/webview/panel/app-body.tsx` (mine: CSS-var wiring + deps; theirs: readFilePaths plumbing)
- `extension/src/shared/protocol-validation.ts` (mine: widened `numericRanges` + new `stringKeys`; theirs: `case 'setFileRead'`)
- `extension/test/sync-contract.test.ts` (mine: new-field default assertions; theirs: a readFilePaths line)
A stash `my-changed-files-isolation` and two `reset: moving to HEAD` reflog
entries confirm active concurrent git operations.

**To commit later (once concurrent work is resolved):** stage only my hunks of
the 3 mixed files (e.g. via index plumbing — `git show HEAD:<path>` to a temp,
apply my edits, `git hash-object -w`, `git update-index --cacheinfo` — which
leaves their working-tree hunks untouched) together with the 14 clean files
listed below, then commit. My 14 clean (non-overlapping) files:
`extension/src/shared/protocol/settings.ts`, `…/composer/settings-menu-helpers.ts`,
`…/composer/settings-menu-subcomponents.tsx`, `…/styles/{index,composer,transcript,extension-ui-prompt,inline-editor}.css`,
`…/panel/ui.tsx`, and tests `chat-prefs`, `protocol-validation`, `settings-menu-ui-flyout`,
`webview-style-contract`, `turn-activity-region` (the last is an unrelated
pre-existing `never[]` type-fix needed to unblock the build's typecheck gate).

**Build note:** the extension was already rebuilt (`npm run build`) and synced
to the installed VS Code extension while the merged content was present, so the
feature is live in the running extension — but a later revert/reset by the
concurrent session would undo that sync; rebuild after the commit.
