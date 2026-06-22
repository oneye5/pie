# TODO — Deferred work

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
- **D2** Collapsed sliver ~28px, full-height: count at top + an A/M/D kind
  legend (one row per present kind, glyph + count, reusing the per-row status
  vocabulary). Refined from the original stacked +/- diff bar: the green/red/
  dark-track "health-bar" read as noise and conveyed no magnitude at a glance;
  the legend surfaces what kind of work happened (created vs modified vs
  deleted) instead. Magnitude lives in the tooltip (`N · A3 M7 D2 · +X / -Y`)
  and the expanded aggregate header.
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
- **D7** Aggregate header (`N files · +A / -D`) + per-row horizontal diff bar
  (scaled to the session's largest row); edit-chronology order, no sort.
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

### Secondary finding (deferred — documented, not implemented)
- The truncation top fade is gated on `truncated && hasContent && lines.length >= 2`,
  which was tuned for the old per-row layout. A single long source line (e.g. a
  ~140-char reasoning burst with no newline) can now wrap to ≥3 rows and hard-clip
  at the top with **no** soft fade, because `lines.length === 1` defeats the gate.
  Newest text + caret still visible (bottom-anchored); purely cosmetic. Fix would
  need a visual-overflow check (ResizeObserver / `scrollHeight > clientHeight`)
  to drive the fade, rather than the source-line-count proxy.

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

### Secondary findings (deferred — documented, not implemented)
- ANSI not stripped in the terminal pane (`textFromToolResult`).
- `exitCode` not surfaced in the terminal UI.
- Long-line handling inconsistency (command truncates vs output wraps).
- stderr not distinguished from stdout.
- Truncation "Full log: path" is plain text, not a clickable path.
- Reasoning collapsed summary has no size hint (tool calls show `~543 lines`).
- Reasoning expanded has no streaming cursor.
