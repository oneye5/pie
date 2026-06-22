# TODO — Deferred work

## Changed-files UI (from docs/CHANGED-FILES-UI-PLAN.md)

**Planning complete (grilling); implementation NOT started.** Decisions D1–D8
settled; D9 (tuning) open. Summary of the agreed design:

- **D1** Peek-vs-pin split: zero reserved space mid-turn; hover/tap = ephemeral
  overlay peek; click = persisted pin (`fileChangesExpanded`).
- **D2** Collapsed floor = thin count + `+`/`-` diff-bar sliver (~8–12px).
- **D3** Peek is an overlay over the transcript edge (not a push); hover region
  = sliver ∪ overlay.
- **D4** Peek renders the full file list (one content model with pin).
- **D5** Drag-resize width via left-edge handle; ephemeral per-session
  (mirrors resizable-height precedent). Default ~200px, range ~160–480px.
- **D6** Remove auto-open (`autoOpenFileChangesRail` pref + `autoExpandedBySession`
  host state); `hasNewChanges` pulse is the mid-turn signal.
- **D7** Aggregate header (`N files · +x / −y`) + per-file diff bar; edit-chronology
  order, no sort.
- **D8** Touch: tap = peek, pin button in peek header = pin.

### D9 — Tuning parameters (open)
- Hover-intent delay (~150–250ms) + peek dismiss delay.
- Default drawer width + drag bounds (placeholders: 200px / 160–480px).
- Whether `hasNewChanges` should animate (today static) — needs
  `prefers-reduced-motion` guard.

### Contract change required at implementation time
- Add transient peek/hover-overlay visibility to `STATE_CONTRACT.md §
  Webview-Local State` allowlist (analogous to `contextMenu`), with a matching
  `sync-contract.test.ts` entry. (Drag width is already covered by `drag state`.)

### Secondary findings (deferred — documented, not implemented)
- Sort by magnitude / status (sort-UX question; revisit if D7 doesn't satisfy).
- Group by status (Created/Modified/Deleted) — alternative glanceability aid.
- `hasNewChanges` is per-component (keyed by `activeSessionPath`), doesn't
  survive tab-switch; move to host state only if reported.
- Peek overlay stacking vs sticky headers / composer popovers — confirm z-index
  at implementation (`.panel-main` already `isolation: isolate`).
- Resize-handle on peek (out of scope; could "pin on drag" later).

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
