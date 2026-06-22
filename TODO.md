# TODO — Deferred work

## Changed-files UI (from docs/CHANGED-FILES-UI-PLAN.md)

**Implemented: D1–D8.** Reviewer-audited; build / typecheck / tests green.
Full decision record lives in the plan doc. Summary:

- **D1** Peek-vs-pin: peek = transient webview-local overlay (reserves no
  space); pin = host state `ViewState.fileChangesExpanded` (in-flow reserved).
  A type-level pin in `sync-contract.test.ts` fails to compile if a
  `fileChangesPeek*` field is ever promoted into ViewState.
- **D2** Collapsed sliver ~12px, full-height: count + vertical stacked +/- diff
  bar (add bottom / del top, scaled to add+del).
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

## Expanded-section UI (from docs/EXPANDED-SECTION-UI-PLAN.md)

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

### Secondary findings (deferred — documented, not implemented)
- ANSI not stripped in the terminal pane (`textFromToolResult`).
- `exitCode` not surfaced in the terminal UI.
- Long-line handling inconsistency (command truncates vs output wraps).
- stderr not distinguished from stdout.
- Truncation "Full log: path" is plain text, not a clickable path.
- Reasoning collapsed summary has no size hint (tool calls show `~543 lines`).
- Reasoning expanded has no streaming cursor.
