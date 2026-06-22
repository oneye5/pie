# TODO — Deferred work

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
- **D2** Collapsed sliver ~28px, full-height: count at top + total `+N`/`-N`
  churn (how much changed, always visible) + an A/M/D kind legend (one row per
  present kind, glyph + count, reusing the per-row status vocabulary). Refined
  from the original stacked +/- diff bar: the green/red dark-track "health-bar"
  read as noise and conveyed no magnitude at a glance; the legend surfaces what
  kind of work happened (created vs modified vs deleted) and the `+N`/`-N`
  totals carry the magnitude. The sliver `title` carries the full summary
  (`N · A3 M7 D2 · +X / -Y`).
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
  Edit-chronology order, no sort. Detail (full path + description + stats +
  diff hint; per-kind breakdown) surfaces on hover via `Tooltip` (a `triggerClass`
  prop was added so the wrapper span can act as a flex child).
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
