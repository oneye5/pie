# Expanded-section UI plan — bash/terminal tool + reasoning preview

**Status:** Open (planning). Not yet implemented.

Audit + grilling decisions for the two expandable transcript surfaces: the
shell/terminal tool pane and the reasoning preview block. Scope is the
user-reported pain: **expanded sections stay open too long and consume too
much vertical space**, dominating the transcript during an active turn.

The code is the authoritative record once implemented; this plan captures the
decisions and their rationale while the work is in progress.

---

## Context: what was audited

Two render surfaces in `extension/src/webview/panel/`:

1. **Shell/terminal tool UI** — `transcript/tool-call-card.tsx`, `ToolCallBody`
   shell branch + `TerminalOutput`. Renders a `$ command` line plus a streaming
   `<pre>` (default `max-height: 360px`, top + bottom resize handles,
   stick-to-bottom, blinking cursor). Styled by `styles/tool-call.css` +
   `styles/highlight.css`.
2. **Reasoning preview UI** — `transcript/message-item/reasoning-block.tsx`
   built on the generic `Collapsible` (`components/collapsible.tsx`).
   Collapsed shows an 80-char stripped summary; expanded renders full
   markdown, throttled (100 ms leading / 120 ms trailing parse), at
   `--expanded-font-size` (default 12 px). **No max-height, no resize handles —
   grows unbounded.**

Both lean on shared infra: `components/resizable-pre.tsx`,
`components/use-resizable-height.ts`, `components/resize-handle.tsx`, and
`transcript/use-collapsible-open.ts`. Auto-expand is driven by
`autoExpandReasoning` / `autoExpandToolCalls` (both default `false` in
`DEFAULT_CHAT_PREFS`, `shared/protocol/settings.ts`).

### Why "they stay open and take too much space" happens (root cause)

This is **by design**, not a bug — which is why the fix is a policy change, not
a defect patch:

- Defaults are collapsed, so tool calls and reasoning *start* collapsed.
- **But** shell bodies auto-show while running:
  `showBody = open || (isShell && isRunning) || lingering` in `tool-call-card.tsx`.
- **And** their post-completion auto-close is deliberately *held while the turn
  is active*: `turnActive === true → canClose = false` (line ~625), with the
  comment *"avoid collapse→re-expand churn when the agent runs consecutive
  commands."*

Net effect during an active turn: every executed shell command leaves its
~360 px pane open and stacked, and 3–4 consecutive commands push the rest of
the transcript out of view. The current design optimized against flicker and
traded away vertical space — the wrong trade for reported usage.

---

## Decisions (from grilling)

### D1 — Bound reasoning with the resizable model

Reasoning adopts the same bounded + resizable model tool-call output already
uses: a `max-height`-capped, top + bottom `ResizeHandle` region. **Not**
`ResizablePre` — that renders a `<pre>`, which would force `white-space: pre`
and a monospace font on rendered markdown prose (headings, lists, tables,
nested code blocks) and mangle the layout. Instead, call `useResizableHeight`
directly on a `<div>` wrapping the `.message-body` (the same pattern
`TerminalOutput` already uses for its streaming pane), keeping the generic
`Collapsible` for the header/chevron.

- **Why:** a long reasoning block currently pushes tool calls and replies out
  of view. Short reasoning (the common case) is unaffected by a max-height
  (content < cap → no scroll).
- **Trade-off accepted:** reasoning is prose read top-to-bottom, so a scroll
  window interrupts reading differently than scanning tool output (reference
  material). Worth it to stop one block from dominating the viewport.
- **Consistency:** reuses the existing `useResizableHeight` / `ResizeHandle`
  infra. `docs/STATE_CONTRACT.md § Webview-Local State` lists "drag state —
  transient tab drag-and-drop position" (scoped to tabs), but the codebase
  already extends that same ephemeral-height pattern to resizable panes (see
  the `use-resizable-height.ts` comment citing that section); this work adds no
  new webview-local state category — per-drag height stays ephemeral and
  unpersisted, exactly as for tool-call output today.

### D2 — Shared `expandedSectionMaxHeight` pref + CSS var

Add one `ChatPrefs.expandedSectionMaxHeight: number` (default **reduced** from
today's 360 px — see D3), surfaced as a range slider in the settings menu and
pushed to the DOM as a `--expanded-section-max-height` CSS var in
`app-body.tsx` — mirroring exactly how `expandedSectionFontSize` →
`--expanded-font-size` already works (`app-body.tsx:419`).

Applied to **all four** expanded sections for consistent behaviour:

| Section | Current model | After |
|---------|---------------|-------|
| Reasoning (`reasoning-block.tsx`) | unbounded | `max-height: var(--expanded-section-max-height)` + div-based resizable wrapper (not `ResizablePre`) |
| Shell terminal (`tool-call-terminal-pre`) | hardcoded `max-height: 360px` | `var(--expanded-section-max-height)` |
| Tool result `<pre>` (`tool-call-pre-resizable`) | hardcoded `max-height: 360px` | `var(--expanded-section-max-height)` |
| Subagent thread (`subagent-messages-scroll`) | **fixed** `height: var(--subagent-thread-height)` (300 px) | migrate to `max-height: var(--expanded-section-max-height)` |

- **Why shared:** `expandedSectionFontSize` already unifies font size across
  all expanded sections (its settings hint: *"Tool-call output, reasoning,
  system prompts, and code blocks"*). A shared height knob matches that
  precedent and collapses three divergent hardcoded defaults (360 / 360 / 300)
  into one. Per-drag overrides remain ephemeral, so the pref is only the
  *starting* bound.
- **Subagent migration:** the subagent thread already calls
  `useResizableHeight`; switching it from a fixed `height` to a `max-height`
  is a CSS change, not a logic change. It lets short threads grow to content
  instead of reserving 300 px always. Note `.subagent-messages-scroll`
  currently also carries `max-height: 70vh` — drop that in favour of the shared
  var (the resize hook's own ~80 vh clamp remains the hard viewport cap), or
  two competing `max-height` declarations will be left in source-order
  conflict.

### D3 — Reduce the default max-height

Lower the default from 360 px to ~**240 px** (tunable). 360 px is roughly half
a typical VS Code sidebar; 240 px keeps one open pane to about a third of the
viewport while remaining readable, and the user can grow it per-pane (drag) or
globally (the new pref).

### D4 — Open while running (unchanged)

Keep auto-showing the shell body while the command is running. Live execution
visibility stays.

### D5 — Remove the "hold close while turn active" logic

Each shell body closes after a short grace post-completion, **even mid-turn**.
Remove the `turnActive`-gated hold (`canClose = turnActive === undefined ? true
: !turnActive`), so consecutive commands no longer stack open panes — only the
currently-running (or just-finished, in-grace) pane stays open.

- **Why:** the hold is the direct cause of the reported "they stay open." Per-
  command grace-then-close resolves it.
- **Trade-off accepted:** this reverses the deliberate prior decision (the code
  has an explicit comment justifying the hold to avoid collapse→re-expand
  churn). The churn trade is re-accepted because vertical-space domination is
  the worse failure for this usage.
- **Cleanup:** `TurnActiveContext` is consumed **only** in `tool-call-card.tsx`
  for this hold (provided in `virtual-list.tsx` as `busy`, and as `undefined`
  in `transcript-message-list.tsx` for nested transcripts). Once the hold is
  gone, that context read is dead — remove it (and the provider/import if
  nothing else consumes it), or retain the provider for future use. Confirm at
  implementation time. Also drop `turnActive` from the status-transition
  `useEffect` dep array (`[toolCall.status, isShell, turnActive]` →
  `[toolCall.status, isShell]`) or it becomes a stale/unused dep (lint
  violation).

### D6 — Slower, seamless close animation

Lengthen the post-grace collapse transition (currently
`TOOL_CALL_CLOSE_TRANSITION_MS = 180`, CSS `grid-template-rows 180ms` + `opacity
180ms`) to ~**280–320 ms** with tuned easing, so the transcript reflows
smoothly instead of jumping when a pane closes.

- The `grid-template-rows 1fr→0fr` technique already animates the height
  collapse (so below content reflows rather than snaps); a longer duration
  just makes the reflow more gradual.
- Synergy with D5: with the hold removed, closes fire per-command after each
  grace (staggered), so they no longer all fire at once at turn end — which
  itself reduces the compound "jump."
- Keep `[data-streaming="true"] { transition: none }` so per-delta height
  changes during streaming still don't animate; only the post-grace close
  animates (unchanged design).

### D7 — Tuning parameters (deferred to implementation)

Explicitly left open per "we can play around with this to make it seamless":

- Grace duration (`TOOL_CALL_CLOSE_GRACE_MS`, today 1000 ms).
- Close duration + easing (D6).
- **New-command-during-grace edge case:** if command B starts while command A
  is still in its post-completion grace, do we (a) let A finish its slow close
  (brief double-open), or (b) cancel A's close and keep it open? Recommend (a)
  for simplicity and because the slow close makes the double-open brief and
  gentle; revisit if it feels janky.

---

## Implementation outline

Files to touch (exact, for the worker):

**Shared pref + CSS var (D2, D3)**
- `shared/protocol/settings.ts` — add `expandedSectionMaxHeight: number` to
  `ChatPrefs` and `DEFAULT_CHAT_PREFS` (default ~240); thread through
  `resolveChatPrefs`.
- `webview/panel/app-body.tsx` — `root.setProperty('--expanded-section-max-height', '${n}px')` next to the `--expanded-font-size` line (419).
- `webview/panel/composer/settings-menu-subcomponents.tsx` — add a range slider
  (e.g. 120–720 px) under the **Layout** group (alongside `uiMessageWidth`),
  not Typography.
- `webview/panel/styles/highlight.css` — declare `--expanded-section-max-height:
  240px;` default on `:root`, next to `--expanded-font-size` (line 11); both are
  expanded-section theme tokens, so they belong together. (Note:
  `--expanded-font-size` lives in `highlight.css`, not `index.css`.)

**Reasoning bound (D1)**
- `webview/panel/transcript/message-item/reasoning-block.tsx` — do **not** use
  `ResizablePre` (it renders `<pre>`, which breaks rendered markdown). Instead,
  wrap the `.message-body` div in a resizable `<div>` by calling
  `useResizableHeight` directly and rendering top + bottom `ResizeHandle`s
  around it (the same pattern `TerminalOutput` uses for the streaming pane).
  Apply `max-height: var(--expanded-section-max-height)` + `overflow-y: auto` to
  the div so short reasoning grows to content and long reasoning scrolls. Keep
  the generic `Collapsible` for the header/chevron.

**Tool-call CSS unification (D2)**
- `webview/panel/styles/tool-call.css` — `.tool-call-terminal-pre` and
  `.tool-call-pre-resizable`: replace hardcoded `max-height: 360px` with
  `max-height: var(--expanded-section-max-height)`.
- `.subagent-messages-scroll` (`tool-call.css`): replace
  `height: var(--subagent-thread-height)` with
  `max-height: var(--expanded-section-max-height)`; keep `min-height: 120px`;
  **drop the existing `max-height: 70vh`** (otherwise two `max-height`
  declarations conflict by source order; the resize hook's ~80 vh clamp remains
  the hard cap). Drop `--subagent-thread-height` if now unused.

**Open-state + close animation (D4–D6)**
- `webview/panel/transcript/tool-call-card.tsx`:
  - Remove the `turnActive` hold: the close fires after
    `TOOL_CALL_CLOSE_GRACE_MS` regardless of turn activity (D5). Drop the
    `useContext(TurnActiveContext)` read and the `canClose` branch.
  - Bump `TOOL_CALL_CLOSE_TRANSITION_MS` (e.g. 180 → ~300) (D6).
  - Keep auto-show-while-running (`showBody = open || (isShell && isRunning)
    || lingering`) (D4).
- `webview/panel/styles/tool-call.css` — bump the `.tool-call-body-wrap`
  transition duration to match `TOOL_CALL_CLOSE_TRANSITION_MS` (comment
  already flags keeping these in sync).
- `webview/panel/transcript/turn-active-context.ts` + providers in
  `virtual-list.tsx` / `transcript-message-list.tsx` — remove if D5 leaves the
  context with no consumers (confirm first).

**Tests**
- `extension/test/` — add a reducer/projection unit test for the new pref
  round-trip if `ChatPrefs` is exercised there; add a snapshot/contract check
  that `--expanded-section-max-height` is emitted from `app-body.tsx` when the
  pref changes (mirror any existing `expandedSectionFontSize` test).
- No `STATE_CONTRACT.md` invariant changes: the new pref is a plain
  `ChatPrefs` field (host state via `ViewState.prefs`), and per-drag height
  reuses the existing ephemeral resize-height pattern (see D1's consistency
  note — the contract's "drag state" entry is tab-scoped but the codebase
  already extends it to pane resize). No `sync-contract.test.ts` change
  expected unless `ViewState` shape changes (it shouldn't —
  `expandedSectionMaxHeight` is a pref, already part of `ViewState.prefs`).

---

## Secondary findings (deferred — document, do not implement now)

Surfaced during the audit but out of scope for this plan's first pass:

- **ANSI not stripped in the terminal pane.** `textFromToolResult` renders raw
  output; ANSI ESC stripping exists only in `formatErrorExcerpt`
  (`shared/tool-call-analysis/index.ts:167`). Forced-color tools (test runners
  with `--color`, `ls --color=always`) would leak raw `\x1b[...m` codes.
  Non-TTY subprocess output is usually plain, so impact is limited; consider
  stripping (or rendering) ANSI in the terminal pane if reported.
- **`exitCode` not surfaced.** Extracted (`extractExitCode`) and carried on the
  transcript type (`backend/transcript/types.ts:35`) but never shown in the
  terminal UI. A `grep` returning exit 1 (no match) renders as "completed"
  with no signal. Consider showing the exit code in the header or terminal
  footer for non-zero codes.
- **Long-line handling inconsistency.** Command line truncates (`white-space:
  nowrap` + `text-overflow: ellipsis`); output wraps (`white-space: pre-wrap`
  + `overflow-wrap: anywhere`). Wrapping mangles terminal-style output
  (tables, aligned columns, progress). Consider horizontal scroll for output.
- **stderr not distinguished from stdout** — concatenated text, errors not
  highlighted.
- **Truncation "Full log: path" is plain text**, not a clickable path —
  inconsistent with the header's `ClickablePathButton`.
- **Reasoning collapsed summary has no size hint** (tool calls show
  `~543 lines`). Minor consistency gap.
- **Reasoning expanded has no streaming cursor** (throttled re-parse only).
  Polish; the message-level streaming indicator likely suffices.

---

## Out of scope

- Changing the collapsed-header content model (output preview, exit-code
  display) — these were candidate directions during grilling but were
  deprioritized once the real pain (open-state + footprint) was identified.
  Revisit via the secondary findings if space fixes don't satisfy.
- The `expandedSectionFontSize` coupling between code/data and reasoning prose
  (both at 12 px) — reasoning prose readability is a separate concern; the
  grilling reaffirmed consistent behaviour across expanded sections, so
  reasoning stays on the shared expanded-section font for now.
- Per-section height knobs — explicitly rejected in favour of one shared pref.

---

## Decision-record note

The D5 reversal (removing the turn-active hold) is surprising without context
— the code carries an explicit comment justifying the hold. It is captured
here rather than as a standalone decision record because it is easily
reversible (behaviour tuning) and still subject to the D7 tuning pass. If, post-implementation, the tuning settles on a non-obvious policy, promote it
to a short note in `docs/ARCHITECTURE.md § 5` (data-flow) or a dedicated
record at that point.
