# Changed-files UI plan — minimal-footprint rail, drag-resize, hover-peek

**Status:** Implemented. The code in `webview/panel/file-changes-panel.tsx` is
authoritative; this plan captures the original decisions and rationale. See
**Post-implementation revisions** below for the one change that superseded
D2/D7 after the initial build.

Grilling decisions for the left-side changed-files rail
(`webview/panel/file-changes-panel.tsx`). Scope is the user-reported pain: the
rail **wastes horizontal space, isn't resizable, and gets in the way during
active work** — the user wants it out of the way while an agent works, then
glanceable when the task is done.

The code is the authoritative record once implemented; this plan captures the
decisions and their rationale while the work is in progress.

---

## Post-implementation revisions

**Structural relocation (commit 8548ce0).** The rail was subsequently relocated
from the right side of the panel to the left side, to avoid colliding with the
transcript's right-edge scrollbar. It now docks left: the collapsed sliver and
pinned drawer sit at the panel's left edge, the peek overlay anchors `left: 0`,
and the drag handle is on the right (transcript-facing) edge (`edge="right"`,
so drag-right = wider) — the inverse of the original right-side plan. Positional
descriptors throughout this document have been revised to match; the code in
`file-changes-panel.tsx` / `file-changes.css` is authoritative.

These supersede the original decisions after the first implementation, driven
by a user audit of the rendered rail:

- **Per-row red/green diff bar removed (supersedes D7).** The per-file `+`/`-`
  bar restated the `+N`/`-N` numbers already shown beside it and consumed
  ~40px of horizontal space per row — space reclaimed for the (ellipsized)
  file path so more of the path is visible at rest. The `DiffBar` component,
  the `maxRowTotal` scale field on `DiffTotals`, and the `.file-change-diff-bar`
  CSS were deleted; `computeDiffTotals` now returns only `{ additions, deletions }`.
- **Magnitude moved into the collapsed sliver (extends D2).** The sliver now
  shows total `+N`/`-N` churn (green/red numbers, consistent with the rows and
  header) between the count and the A/M/D kind legend, so "how much changed" is
  visible at a glance without hovering. D2's stacked `+`/`-` *bar* was already
  replaced by the A/M/D legend pre-implementation; the magnitude is now numbers,
  not a bar (the user found red/green bars uninformative).
- **Tooltips carry the detail (progressive disclosure).** A `triggerClass` prop
  was added to `Tooltip` (`components/tooltip.tsx`) so the wrapper span can act
  as a flex child. The row path is wrapped in a `Tooltip` disclosing the full
  un-ellipsized path + kind + description + line stats + a "click to view diff"
  hint; the aggregate header is wrapped in a `Tooltip` disclosing the per-kind
  breakdown with per-kind churn. Row + header stay calm; detail surfaces on hover.
- **"Roughly what file" is served three ways:** more path visible per row at
  rest (reclaimed space), the full path on hover (tooltip), and the full list
  via the existing hover-peek / pin. A filename in the *zero-interaction*
  collapsed sliver was rejected as it would widen the sliver against the
  compact-footprint goal; revisit if the hover-peek proves too passive.

### Iteration 2 — fill the sliver; row hover = act mode; secondary actions to a context menu

A second user audit refined the collapsed sliver and the drawer rows:

- **Collapsed sliver now lists the files (extends D2).** The sliver was widened
  28→48px and, below the summary (count + `+`/`-` magnitude + A/M/D legend),
  now renders a read-only vertical list of the affected files (truncated
  basenames + a kind glyph) filling the full height — the tall sliver no longer
  wastes vertical space. Peek/pin remain the path to the full, interactive
  list; each sliver line carries its full path as a hover `title`.
- **Row hover = act mode (supersedes D7's always-visible row buttons).** The
  per-row action buttons no longer reserve space at rest: `.file-change-actions`
  is `max-width:0; overflow:hidden; opacity:0` by default so the full file path
  fills the row ("read" mode, mouse elsewhere). On row hover/focus-within the
  two primary buttons (View diff, View in editor) slide in from the left
  (`max-width` 0→64) and the path collapses to its basename (`.file-change-dir`
  hides) — content shifts right, buttons appear ("act" mode). Touch
  (`@media (hover: none)`) keeps the buttons always visible.
- **Buttons pared to the two primary actions.** Copy path + Revert were
  removed from the row and moved to a self-contained right-click
  `FileChangeContextMenu` (Copy path; Revert with a two-step confirm), rendered
  at the rail level (position: fixed, z-index 400) so it clears the peek overlay
  and escapes the drawer's overflow clipping. The per-row `CopyPathButton` and
  `RevertButton` components were deleted.

---

## Context: what was audited

One render surface + its host state:

1. **Rail component** — `extension/src/webview/panel/file-changes-panel.tsx`,
   mounted at `app-body.tsx:254–255` as a flex sibling of `.panel-content`
   (which wraps `TranscriptHost`) inside `.panel-main` (`styles/layout.css:3`,
   `display: flex`, default `flex-direction: row`). Styled by
   `styles/file-changes.css`.
2. **Collapsed state** — a 30px top-aligned chip
   (`--file-changes-handle-width: 30px`): file icon + count badge + chevron. The
   rail is `pointer-events: none` except the chip, so the empty gutter below
   the chip doesn't swallow clicks.
3. **Expanded state** — a fixed **250px** drawer
   (`--file-changes-drawer-width: 250px`), `align-self: stretch` (full height),
   carrying a header (title + close) + a scrollable file list. It animates
   `width 0 → 250px` and **reserves** that 250px, shrinking the transcript.
4. **Per-file rows** — `StatusLabel` (A/M/D glyph) + `FilePath` (dir ellipsized,
   name visible) + `LineStats` (`+N`/`-N` numbers). Actions (open / copy /
   revert) reveal on hover. Ordered by transcript (edit) chronology.
5. **Host state** (`host/core/arch-state.ts:354`):
   ```ts
   fileChanges: {
     bySession: Record<string, FileChangeEntry[]>;          // derived from transcript
     expandedBySession: Record<string, boolean>;            // persisted per session
     autoExpandedBySession: Record<string, boolean>;        // "opened this turn" flag
   }
   ```
   - `expandedBySession` is projected to `ViewState.fileChangesExpanded`
     (`projection.ts:162,199`) and is the only piece of expand state that
     crosses the host↔webview boundary.
   - `autoExpandedBySession` is set when file changes arrive
     (`reducer/file-handlers.ts`) and reset to `false` on the next `send`
     (all three branches of `handleSend`, `reducer/command-misc-handlers.ts:39,71,109`).
   - Gated by `ChatPrefs.autoOpenFileChangesRail` (default **`true`**,
     `shared/protocol/settings.ts:145,193`).
6. **`FileChangeEntry`** (`shared/protocol/sessions.ts:224`) — `path`,
   `kind: created|modified|deleted`, `additions?`, `deletions?`,
   `description`, `toolCallId`, `messageId`, `timestamp`.
7. **Existing resize infra** — `webview/panel/components/use-resizable-height.ts`
   + `resize-handle.tsx` — but **vertical only** (top/bottom edges, `clientY`,
   `edge: 'top' | 'bottom'`). No horizontal resize exists anywhere in the
   webview yet.
8. **`hasNewChanges`** — already webview-local `useState` in
   `file-changes-panel.tsx` (sets true when count grows while collapsed, clears
   on expand). Today the CSS accent on the count pill is *static — no
   animation* (per a comment in `file-changes.css`).

### Why "it wastes space and gets in the way" happens (root cause)

This is **by design**, not a bug — which is why the fix is a policy + interaction
change, not a defect patch:

- `autoOpenFileChangesRail` defaults `true`, so **the first file change of every
  turn pops the rail to a fixed 250px and it stays the whole turn** (reset only
  on the next send). During an active turn that 250px is permanently shaved off
  the transcript — exactly the "getting in the way."
- The drawer width is a hardcoded CSS var with no drag handle, so even a user
  who wants it narrower can't make it so.
- The collapsed chip is 30px with margin even when nothing is happening — wider
  than necessary for a pure "something changed" indicator.
- There is no peek affordance: the only options are "collapsed chip" or
  "full 250px drawer." Nothing in between, and nothing transient.

---

## Decisions (from grilling)

### D1 — Peek-vs-pin split (open-state policy)

The rail reserves horizontal space **only on explicit user pin**. During an
active turn it takes **zero reserved space** — just a minimal indicator (D2).
Auto-open-on-arrival no longer reserves layout.

- **Peek** (hover, desktop / tap, touch) — an **ephemeral overlay** that floats
  *over* the transcript edge (D3), webview-local, dismissed on mouse-leave /
  tap-outside. Does not shrink the transcript.
- **Pin** (click) — the only thing that durably shrinks the transcript. This
  is the existing `fileChangesExpanded` per-session host state, now meaning
  *"user deliberately opened it,"* not *"a file changed."*
- **Mid-turn** — collapsed sliver + (D6) a `hasNewChanges` pulse. No reserved
  space, ever, unless pinned.

**Why:** this delivers "out of the way during work" as the default (zero
reserved space mid-turn) while keeping the persisted expand state meaningful.
The existing `autoExpandedBySession` / `autoOpenFileChangesRail` machinery that
caused the pain is removed (D6).

**Contract:** drag width (D5) is webview-local — `drag state` is explicitly
allowlisted by `STATE_CONTRACT.md § Webview-Local State`. **However**, the
hover/tap peek's `peeking` visibility flag is transient overlay state that is
**not** currently on that allowlist (the list enumerates `contextMenu`, `drag
state`, `animation/transition`, etc., but not hover/peek overlays). It is the
moral equivalent of `contextMenu` (a transient overlay dismissed by an external
gesture) and must be **added** to the allowlist — the one small
`STATE_CONTRACT.md` change this plan requires, with a matching
`sync-contract.test.ts` entry. Only `expandedBySession` (pin) crosses the
boundary, unchanged in shape.

### D2 — Collapsed floor: thin count + diff-bar sliver

When unpinned and un-hovered, the persistent footprint is a **thin vertical
sliver (~8–12px)** showing the count **and a stacked `+`/`-` diff bar**
(aggregate additions/deletions magnitude). Not the current 30px chip.

- **Why:** resolves the tension between "as little horizontal space as
  possible" and "glanceable how-much-changed at a glance." The count answers
  *how many*, the diff bar answers *how much* — both visible without expanding,
  at near-zero width.
- **Consistency:** the diff-bar visual is reused per-row inside the drawer (D7),
  so the collapsed and expanded states share one magnitude language.

### D3 — Hover-peek is an overlay, not a push

Peek floats **over** the transcript edge (absolutely positioned, above content),
dismissed on mouse-leave. It does **not** temporarily reserve space or reflow
the transcript.

- **Why:** D1 promised zero reserved space mid-turn; a push-on-hover would
  reflow the transcript on every hover-enter/leave — jank you'd feel while an
  agent is streaming. An overlay honors D1 literally.
- **Cost accepted:** the overlay covers the leftmost slice of transcript while
  peeking. Mitigated by: peek dismisses instantly on mouse-leave, and **pin**
  (reserved space) exists when you want to read both side by side.
- **Hover region = sliver ∪ overlay:** peek must stay open while the pointer
  moves into the overlay (so the user can click rows / actions); it dismisses
  only when the pointer leaves both. A small hover-intent delay (~150–250 ms)
  avoids twitchy accidental peeks (tuning param — defer, see D9).

### D4 — Peek renders the full file list (one content model)

The peek overlay renders **the same file list** as a pinned drawer. There is one
content model; the only peek-vs-pin difference is overlay-vs-reserved.

- **Why:** D2's collapsed sliver already carries the aggregate summary
  (count + diff bar), so "at a glance" is served without expanding. Peek is the
  first place you see *which* files changed. Collapsed = summary, peek/pin =
  browse. One content surface to build and maintain.
- **Rejected alternative:** a compact peek summary (top-N by magnitude) +
  full-list pin — rejected as two content surfaces to keep in sync for little
  gain, given D2 already covers the summary need.

### D5 — Drag-resize width is ephemeral per-session (v1)

The pinned drawer's width is drag-resizable via a **right-edge handle** (the
drawer is on the left, so drag-right = wider). Width is **ephemeral
webview-local state** — not persisted — exactly mirroring the precedent set by
`EXPANDED-SECTION-UI-PLAN.md` D1 for resizable *height*.

- **Why:** zero `STATE_CONTRACT` risk and a small first pass; matches the
  established height precedent. Per-drag width is lost on reload/reopen.
- **Default + bounds (tuning — defer to implementation, like the other plan's
  D7):** default ~**200px** (down from 250); drag range ~**160–480px**.
- **Promote later:** if the non-stickiness is felt in practice, promote to a
  global `ChatPrefs.fileChangesDrawerWidth` + settings slider (the same posture
  the other plan took for its tuning params).

### D6 — Remove auto-open; pulse is the mid-turn signal

Remove the auto-open-on-arrival behavior entirely. Mid-turn the rail stays
collapsed (sliver + `hasNewChanges` pulse); the user peeks (hover/tap) or pins
(click) on demand.

- **Why:** the user's workflow is *"interact without it getting in the way
  [mid-turn], then once done with THE TASK, look at changed files."* Only the
  user knows when a task is done, so auto-pinning at every turn-end (the closest
  system signal) would be over-eager. The `hasNewChanges` pulse already signals
  "something changed, review me" without reserving space — that is the nudge.
- **Cleanup:** the now-dead machinery is removed, not left dormant (the codebase
  frowns on dead state — see how `EXPANDED-SECTION-UI-PLAN.md` D5 plans to remove
  the dead `TurnActiveContext`):
  - `shared/protocol/settings.ts` — drop `autoOpenFileChangesRail` from
    `ChatPrefs` + `DEFAULT_CHAT_PREFS` + `resolveChatPrefs`.
  - `host/core/arch-state.ts` — drop `autoExpandedBySession` from `FileChangesState`
    + initial state.
  - `host/core/reducer/file-handlers.ts` — remove the `shouldAutoOpen` block.
  - `host/core/reducer/command-misc-handlers.ts:39,71,109` — remove the three
    `autoExpandedBySession = false` resets (all in `handleSend` branches; note
    `handleEdit`/`handleInterrupt`/`handleTruncateAfter` do **not** touch it).
  - `host/core/reducer/helpers.ts:90,153` — remove `autoExpandedBySession` from
    the `clearSessionState` cleanup spread. (`session-handlers.ts:357,447`
    only cleans `bySession` — it does not reference `autoExpandedBySession`, so
    no change there.)
  - Settings UI — find and remove the toggle bound to `autoOpenFileChangesRail`
    (check `webview/panel/composer/settings-menu-subcomponents.tsx`).
- **`expandedBySession` stays** — it now means "pinned by user," projected and
  toggled exactly as today (`handleSetFileChangesExpanded`).

### D7 — Glanceable content: aggregate header + per-file diff bar

Inside the drawer (peek and pin share this), add:

1. **Aggregate header** — e.g. `12 files · +340 / −128` — replacing/augmenting
   the current `File changes · N` title. The single most glanceable summary.
2. **Per-file thin `+`/`-` diff bar** on each row, alongside the existing
   `+N`/`-N` numbers — bars scan instantly where numbers require reading.

Order stays **edit-chronology** (transcript order). No sort control in v1.

- **Why:** directly serves "how much they were changed at a glance." The per-file
  bar reuses D2's diff-bar visual language, so collapsed and expanded states are
  consistent.
- **Rejected:** sort-by-magnitude — opens a sort-UX can of worms (stable order
  vs magnitude vs status) and breaks edit-chronology. Deferred (see Secondary
  findings).

### D8 — Touch / no-hover fallback: tap = peek, pin button = pin

On `@media (hover: none)` devices, hover-peek is unreachable, so:

- **Tap the sliver → peek** (overlay, dismiss on tap-outside / Escape) — mirrors
  desktop hover.
- **A pin button in the peek header → pin** (reserved).

- **Why:** keeps parity with desktop (peek-then-pin) and reuses the overlay
  dismiss machinery. Touch is secondary but stays coherent without a second
  content surface (D4) or a second interaction model.
- **Consistency:** the existing CSS already special-cases `@media (hover: none)`
  to always-reveal row actions (`file-changes.css`); this extends that posture.

### D9 — Tuning parameters (deferred to implementation)

Explicitly left open, mirroring the other plan's D7:

- Hover-intent delay before peek opens (~150–250 ms) — avoids twitchy peeks.
- Peek dismiss delay (instant vs small grace) — avoids flicker when the pointer
  briefly exits.
- Default drawer width + drag bounds (D5 defaults are placeholders).
- Whether `hasNewChanges` should **animate** now that it's the primary mid-turn
  signal (today it's deliberately static). Recommend a subtle, accessible
  (respects `prefers-reduced-motion`) pulse; revisit if it feels noisy.

---

## Implementation outline

Files to touch (exact, for the worker):

**Sliver + peek/pin markup (D1–D4, D7)**
- `webview/panel/file-changes-panel.tsx` — largest change:
  - Replace the 30px chip markup with the thin **sliver** (count + stacked
    `+`/`-` diff bar, D2).
  - Add **webview-local `peeking` state** (hover/tap) + a single hover region
    covering sliver ∪ overlay (D3).
  - Render the drawer in two modes: **peek** (absolutely positioned overlay,
    `pointer-events` only while peeking, above transcript) and **pin**
    (in-flow, `flex`-reserved as today, driven by `expanded` prop).
  - Add the **aggregate header** (D7) and a per-row **diff bar** (reuse the
    sliver's bar component).
  - Add a **pin button** to the peek header for touch (D8).
  - Keep `onToggleExpanded` (pin) + the existing `hasNewChanges` logic (D6).
- `webview/panel/styles/file-changes.css` — rework:
  - `.file-changes-rail` collapsed = thin sliver (~8–12px), top-aligned, full
    pointer-events only on the sliver.
  - `.file-changes-drawer.is-peek` = `position: absolute`, high `z-index`,
    `width: var(--file-changes-drawer-width)`, floats over transcript edge.
  - `.file-changes-drawer.is-pinned` = in-flow `flex: 0 0 auto` (today's
    reserved behavior).
  - `.file-changes-handle` (the 30px chip) → replaced by `.file-changes-sliver`.
  - New `.file-changes-aggregate` header + `.file-change-diff-bar` row element.
  - `--file-changes-drawer-width: 200px` default (D5), plus a
    `--file-changes-drawer-width-dragged` inline override set by the resize hook.
  - `@media (hover: none)` — tap-to-peek behavior (D8).

**Drag-resize width (D5)**
- `webview/panel/components/use-resizable-width.ts` — **new**, mirroring
  `use-resizable-height.ts` but tracking `clientX` and a single `'right'` edge
  (drag-right = wider). Ephemeral `useState<number|null>` width, clamped to
  `[minWidth, maxWidth]`.
- `webview/panel/components/resize-handle.tsx` — extend `edge` to accept
  `'right'` (horizontal handle), or add a parallel `ResizeHandleH`. Keep a11y
  parity (`role="separator"`, arrow-key nudge, double-click reset).
- `file-changes-panel.tsx` — render the right-edge `ResizeHandle` only when
  **pinned** (peek overlay is transient; resizing peek is out of scope — see
  Out of scope).

**Auto-open removal (D6)**
- `shared/protocol/settings.ts` — remove `autoOpenFileChangesRail` from
  `ChatPrefs`, `DEFAULT_CHAT_PREFS`, `resolveChatPrefs`.
- `host/core/arch-state.ts` — remove `autoExpandedBySession` from
  `FileChangesState` + initial state literal.
- `host/core/reducer/file-handlers.ts` — remove the `shouldAutoOpen` block.
- `host/core/reducer/command-misc-handlers.ts` — remove the three
  `autoExpandedBySession[...] = false` resets (lines 39, 71, 109).
- `host/core/reducer/helpers.ts` + `host/core/reducer/session-handlers.ts` —
  remove `autoExpandedBySession` from the session-cleanup spreads
  (`helpers.ts:90,153`; `session-handlers.ts:357,447`).
- `webview/panel/composer/settings-menu-subcomponents.tsx` — remove the toggle
  bound to `autoOpenFileChangesRail` (confirm it exists there first).

**Tests**
- `extension/test/` — update any reducer/projection tests referencing
  `autoExpandedBySession` or `autoOpenFileChangesRail` (expect breakage in
  `sidebar-sync.test.ts` / `sync-contract.test.ts` if `ViewState` shape or
  default prefs change — `ViewState` shape does **not** change
  (`fileChangesExpanded` stays), but `DEFAULT_CHAT_PREFS` does, so pref
  round-trip tests may need updating).
- **One `STATE_CONTRACT.md` change** (D1): add transient peek/hover-overlay
  visibility to the `§ Webview-Local State` allowlist (analogous to
  `contextMenu`), with a matching `sync-contract.test.ts` entry. Drag width
  needs no change (`drag state` is already allowlisted). `expandedBySession`
  shape is unchanged. No new host state.

---

## Secondary findings (deferred — document, do not implement now)

Surfaced during the audit but out of scope for this plan's first pass:

- **Sort by magnitude / status** — would surface biggest changes first, but
  opens a sort-UX question (default order, toggle control, stable vs magnitude
  vs status grouping). Revisit if the aggregate header + diff bar (D7) don't
  satisfy the "at a glance" need.
- **Group by status** (Created / Modified / Deleted sections) — alternative
  glanceability aid. Deferred alongside sort.
- **`hasNewChanges` is per-component and resets on expand** — fine for the
  pulse, but it doesn't survive tab-switch (the component is keyed by
  `activeSessionPath`, `app-body.tsx:255`, so state is remounted per session).
  If the pulse should persist across tab-away/back, it would need to move to
  host state — defer unless reported.
- **Peek overlay stacking** — must clear the transcript's sticky headers and
  any composer popovers. Confirm `z-index` / stacking context at
  implementation; `.panel-main` already sets `isolation: isolate`
  (`layout.css:8`) which helps.
- **Resize-handle on peek** — out of scope (peek is transient; resizing it would
  imply persistence). If desired, a peek could "pin on drag" — defer.

---

## Out of scope

- **Changing `FileChangeEntry` derivation** (`host/core/file-change-derivation.ts`)
  — the data model is unchanged; only its presentation changes.
- **A separate "summary" surface** (D4 rejected it in favor of one content
  model).
- **Persisted drawer width** (D5 v1 is ephemeral; promote to a pref only if the
  non-stickiness is felt).
- **The other expanded-section surfaces** (terminal / reasoning / subagent
  thread) — those are owned by `EXPANDED-SECTION-UI-PLAN.md`. This plan touches
  only the changed-files rail. The shared `expandedSectionMaxHeight` work in
  that plan is orthogonal and does not conflict.

---

## Decision-record note

D1 (peek-vs-pin) + D6 (remove auto-open) together reverse a deliberate prior
design: the `autoOpenFileChangesRail` pref + `autoExpandedBySession` machinery
exist *specifically* to surface file changes proactively. Reversing them is
surprising without context. It is captured here rather than as a standalone
decision record because it is easily reversible (behaviour/policy tuning) and
is the direct consequence of the user's "out of the way during work" requirement.
If, post-implementation, the on-demand posture proves too passive (users miss
changes), the natural reversal is D6-alternative: auto-pin at turn-end when a
turn produced file changes (reusing the reset-on-send semantics, just moving
the trigger from "file change arrived" to "turn idle") — captured in the D6
rationale so the option isn't lost.

---

## Iteration 3 — color-encoded kinds, left-truncated paths, native affordance titles

A third user audit refined the rail's compactness, discoverability, and styling
(both the collapsed sliver and the pinned/peek drawer). It went through two
passes: the first tried colored dots, a 2px accent bar, and dot+count legend
chips; the user rejected those as ugly, noisy ad-hoc indicators ("they serve no
purpose other than to portray what happened"), so the final design encodes kind
by coloring the file-name TEXT itself.

- **Kind is encoded by coloring the file-name TEXT, not by dots/bars.** The
  `A`/`M`/`D` text glyphs are gone, and so are the accent bars, kind chips, and
  per-file dots tried in the first pass. Change type is now signaled by the
  **color of the file name**: **created→green** (`--panel-success`),
  **modified→orange** (`--panel-warning`), **deleted→red** (`--panel-danger`).
  A single `--kind-color` custom property — set by the bare `kind-*` classes —
  is the one source of truth, consumed by the drawer's `.file-change-name` and
  the sliver's `.sliver-file-name` text color (custom properties inherit to the
  name, which is a descendant of the `.kind-*` carrier). Non-color redundancy
  remains: deleted rows are line-through + disabled + carry only `-N`; created
  rows carry only `+N`; modified rows carry both — and the sliver summary
  `title` spells out the kind breakdown in words for hover/AT users. (Residual
  WCAG 1.4.1 exposure on the color-only *visible* encoding is the accepted cost
  of this user-requested design; in forced-colors the name color collapses to
  `ButtonText` and deleted is still cued by line-through + disabled.)
- **The collapsed-sliver kind legend was removed.** It was redundant with the
  per-file list (each file's name is already colored by kind). The sliver now
  shows only count + aggregate `+N`/`-N` magnitude + the per-file preview
  (colored truncated basenames + per-file `+N`/`-N`). Per-kind counts survive in
  the sliver hover `title` (the `kindBreakdown` computation is retained).
- **Drawer paths left-truncate (supersedes the right-ellipsized dir).**
  `.file-change-dir` uses `direction: rtl; unicode-bidi: isolate;
  text-overflow: ellipsis` (mirroring `.transcript-header-path-prefix`), so the
  directory prefix truncates from the **left** — preserving the end nearest the
  basename, the part that matters most — while the basename
  (`.file-change-name`, `flex: 0 0 auto`) is always fully visible.
  "Relative to workdir" is served by the left-truncation itself: any long
  workdir prefix is the part ellipsised away.
- **Native `title` affordances on both row actions (not the custom Tooltip).**
  The file-name button carries `title="Open <path> in the editor"` (or
  `Deleted — <path>` when disabled) and the diff-stats button carries
  `title="Open diff: <path>"`, so each click target is discoverable on hover.
  This deliberately uses native HTML `title`s, **not** the `pie-tooltip-trigger`
  `Tooltip` component — that was added to the drawer in a prior
  post-implementation revision and reverted for obscuring the list (the
  pinned-drawer test still asserts its absence). Native titles give the hover
  affordance without the floating host that covered the list.
- **Compact restyle.** Single-line drawer rows; the diff-stats button reads as
  a discrete rounded hover pill (rest padding + border-radius so it doesn't
  jump on hover); the sliver per-file preview is a colored truncated basename
  + indented per-file `+N`/`-N`. The `hasNewChanges` pulse and the
  `prefers-reduced-motion` / `forced-colors` guards were carried over.
- **Scan-aligned `+N`/`-N` columns.** The diff stats use a fixed two-column grid
  (`5ch 5ch`, right-aligned) that always renders both cells (empty when a value
  is absent), so additions and deletions land in stable columns across all rows
  — a no-deletions row no longer shifts `+N` right, for clean vertical
  eye-scanning. (Counts >4 digits overflow their cell — rare, accepted.)
- **Peek panel refresh.** The hover overlay reads as a floating panel: an
  accent-tinted right edge, a larger right radius, an explicit card surface, and a
  softer/deeper layered right-casting shadow that eases in (`box-shadow` added to
  the transition). The shared header gets a blended control/card surface with a
  clean bottom separator. The pinned (in-flow) drawer stays a clean divider
  with no shadow.

**Tests:** `extension/test/file-changes-panel.test.ts` updated —
`sliver-kind*` / `sliver-kind-dot` / `sliver-file-dot` now asserted *absent*
(legend + dots removed); the per-file list renders one colored entry per kind
(`sliver-file kind-created/modified/deleted`); `sliver-file-name` still
asserted; the sliver title stays `N changed files · N modified · +X / -Y`;
native `title`s asserted on the name and stats buttons (collapsed + pinned); a
deleted-row case asserts the disabled `Deleted — <path>` title.
