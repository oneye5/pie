# pie Webview — UI/UX Engineering Review

**Date:** 2026-06-20
**Reviewer:** UX-engineering pass (parallel deep-dives, synthesized)
**Scope:** the VS Code webview UI under `extension/src/webview/panel/` (58 TSX + 17 CSS files)
**Lenses:** click hitboxes, hover/focus states, hitbox-vs-visible mismatches, animations, performance, readability, layout shift / jank, streaming behavior, accessibility/keyboard

Every finding below was verified against the actual source (file:line references included). A handful of lower-severity items from the raw sub-system passes are summarized in §"Cross-cutting themes" rather than enumerated individually.

---

## How to read this

- **Severity:** High (real user/quality impact, fix soon) → Medium (noticeable, fix when in area) → Low → Nit
- **Category:** the primary UX dimension affected
- **Location:** file:line(s) in `extension/src/webview/panel/`
- Each finding is self-contained with a concrete suggested fix.

### Severity tally

| Severity | Count |
|---|---|
| High | 10 |
| Medium | 27 |
| Low | 4 |
| **Total** | **41** |

---

## Cross-cutting themes (read first)

These patterns recur across subsystems and are the highest-leverage things to fix holistically:

1. **Hover-only affordances.** File-change row actions and the toolbar indicator chips reveal their meaning only on `:hover`. Keyboard and touch users get nothing (no `:focus-within`, no `@media (hover: none)` fallback). This is the single most common a11y defect. → §Global-2, §Composer-4.
2. **Focus-visible ring is blanked in the composer.** The global `:focus-visible { outline: accent }` rule is overridden to `outline: none` in ~3 places in `composer.css`, sometimes with no replacement, sometimes with a background tint indistinguishable from `:hover`. Inconsistent within the same menu. → §Composer-1, §Composer-3.
3. **Animating layout properties instead of transform/opacity.** `max-height` (notice banner), `width: auto→fixed` (file-changes panel), and `left/top` (drag ghost) are animated — these invalidate layout every frame and snap rather than ease. The design system already codifies transform/opacity-only motion; these are violations. → §Overlays-5, §Global-4, §Tabs-3.
4. **Memoization broken by passing fresh containers.** The whole `transcript` array is threaded into every `MessageItem` (breaks `memo()` on every token); `NoticeContext` provider value and session-tab `Map`s are reallocated each render. During streaming this multiplies re-render cost by the number of visible rows. → §Transcript-1, §Virtual-3, §Global-7, §Tabs-3.
5. **Floating UI has no measure/flip/clamp.** Settings menu, context menu, and tooltip are positioned without measuring their own size, so they clip off the viewport top/bottom and don't flip. The tooltip also doesn't dismiss on ancestor scroll — a real problem in an auto-scrolling transcript. → §Composer-2, §Overlays-2, §Overlays-4.
6. **Entrance animations replay on virtualization remount.** `panel-entrance` is bound to every `[data-role]` message; scrolling a row out of overscan and back replays the 280 ms fade-up, reading as flicker. → §Transcript-2.
7. **Hitbox floors violated.** 14 px (keep-chip remove), 22 px (steppers/chips), 24 px (attachment/file-action remove), and a 6 px resize handle. The 6 px scrollbar also has no hover-expand. → §Composer-5, §Overlays-6, §Global-2.
8. **Modal attributes without modal behavior.** `aria-modal="true"` is set on three inline prompts that have no backdrop, focus trap, or `inert` siblings — actively lying to screen readers. → §Overlays-1.
9. **Streaming-jank tax.** Markdown is re-parsed per token for **user** messages and reasoning blocks (assistant text is throttled, these are not), and `innerHTML` rewrites mid-stream destroy text selection up to 10×/s. → §Transcript-3, §Transcript-4.

---

## Composer subsystem

### Composer-1 · [High] Settings-menu selects lose the keyboard focus ring
- **Category:** A11y
- **Location:** `styles/composer.css:359` (`.toolbar-settings-select { outline: none }`)
- **Problem:** The global `:focus-visible { outline: 1px solid var(--panel-accent); outline-offset: 2px }` (`index.css:374`) gives every focusable control an accent ring — except these selects. `.toolbar-settings-select` sets `outline: none` with no `:hover`/`:focus-visible` replacement, so the Mode, Thinking, sans/mono Font, and Always-Keep selects have **zero** visible keyboard focus indicator. This is a WCAG 2.4.7 (Focus Visible) regression and is inconsistent with the adjacent reasoning-level `ToolbarSelectChip` (also a native `<select>`) which *does* get a ring via `.panel-chip:focus-visible`. Every other control in the same menu correctly inherits the global ring.
- **Fix:** Drop `outline: none`, or add `.toolbar-settings-select:focus-visible { outline: 1px solid var(--panel-accent); outline-offset: 2px }` plus `:hover { border-color: var(--panel-border) }`.

### Composer-2 · [Medium] Settings menu can overflow off the top of the viewport
- **Category:** Jank/Layout-shift
- **Location:** `styles/composer.css:187-206` (`.toolbar-settings-menu`)
- **Problem:** The menu opens upward (`bottom: calc(100% + gap)`, `min-width:240px; max-width:300px`) with **no `max-height` and no `overflow-y`**. With several extensions expanded (skill-pruner alone renders Mode + Prepass model + Thinking + two steppers + two `AlwaysKeepPicker`s) plus the Providers list, the menu grows upward unbounded and its top can leave the viewport with no way to scroll to it. The child `UiFlyout` was clamped (`max-height: calc(100vh - 32px); overflow-y: auto` + a JS `fit()`), but the parent menu was not.
- **Fix:** Mirror the flyout: `max-height: calc(100vh - 32px); overflow-y: auto;` on `.toolbar-settings-menu`.

### Composer-3 · [Medium] Settings items & UI trigger override the focus ring with a hover-look-alike tint
- **Category:** A11y / Hover
- **Location:** `styles/composer.css:259` (`.toolbar-settings-item:hover, :focus { …; outline: none }`), `:494` (`.toolbar-settings-ui-trigger:hover, :focus-visible { …; outline: none }`)
- **Problem:** These rules disable the accent `:focus-visible` outline and substitute a `--panel-control-hover` background — visually identical to the hover state — so a keyboard user scanning the menu can't tell which row is focused. The item rule also uses bare `:focus` (not `:focus-visible`), so the tint flashes on mouse click-focus too. Adjacent controls in the same surface (gear trigger, ext chevron, keep-chip-remove) use the accent outline at 2px offset — localized inconsistency.
- **Fix:** Keep the background but also emit the ring: `.toolbar-settings-item:focus-visible, .toolbar-settings-ui-trigger:focus-visible { outline: 1px solid var(--panel-accent); outline-offset: 2px }`, and switch the item rule from `:focus` → `:focus-visible`.

### Composer-4 · [Medium] Toolbar indicators are invisible to assistive tech
- **Category:** A11y / Readability
- **Location:** `composer/toolbar.tsx:115-156`, `components/panel-chip.tsx:88-97` (default `<span>` branch), `components/tooltip.tsx`
- **Problem:** `ToolbarIndicatorChip`/`ToolbarRunStatusChip` render a default-`as` `PanelChip`, i.e. a `<span>` with `aria-label` but **no `role`** and **no `tabindex`**. A role-less span is `generic` in the a11y tree, so browsers drop its `aria-label`; the chips are also not in the tab order, so the custom `Tooltip` (which fires `onFocus`/`onBlur` on a single interactive child) never shows for keyboard users. Net effect: token count, cost, context-window severity, tokens/sec, and turn-latency are mouse-hover-only. Values are live-updating with no `aria-live`.
- **Fix:** Give indicators a real role — e.g. `role="status"` + `aria-live="polite"` on the value-bearing chips, or render them presentational (`aria-hidden`) with a visually-hidden live-region mirror. At minimum `role="img"`/`role="text"` so the `aria-label` is exposed.

### Composer-5 · [Medium] Several interactive targets are below the 28 px hitbox floor
- **Category:** Hitbox
- **Location:** `styles/composer.css:714` (`.toolbar-settings-keep-chip-remove { 14×14 }`), `:340-346` (steppers `22×22`), `:155` (gear `26×26`); `styles/panel-chip.css:40` + `styles/model-picker.css:24` (chips `22px` tall); `styles/context-menu.css:174` (attachment remove `24×24`)
- **Problem:** The keep-chip remove `×` is 14×14 px (well below any guideline), steppers 22×22, gear 26×26, toolbar chips 22 px tall, attachment remove 24×24. Only Send/Stop/Run CTAs (32 px) and the icon-only attach button (28 px) reach the floor. The 14 px control sits in a dense submenu with no surrounding padding to enlarge its hit area.
- **Fix:** Bump keep-chip remove to ~22-24 px (use an SVG icon, not a 12 px glyph), steppers to 24 px. For compact chips, extend the hit area with a transparent `::before { position:absolute; inset:-4px }` so the visible size stays compact while the target grows.

### Composer-6 · [Medium] Completion/run CTA insertion shifts the Send button
- **Category:** Jank/Layout-shift
- **Location:** `composer/actions.tsx:35-50` + `styles/composer.css:33-50` (`.composer-run-action`)
- **Problem:** `completionAction && (…)` conditionally inserts a whole `.composer-run-action` button between Attach and Send/Stop. When a run enters a completable state the button appears, sliding Send/Stop rightward ~one button width; when it leaves, they snap back. The row is `flex-wrap items-center justify-end gap-2` with no transition and no reserved space, so the shift is live at the exact moment attention is on the composer.
- **Fix:** Reserve the slot (`visibility:hidden` placeholder or `min-width`) when no action, or animate the insert via `transform/opacity` so Send eases rather than snaps.

### Composer-7 · [Low] Down-opening model picker scales from the wrong corner
- **Category:** Animation
- **Location:** `styles/model-picker.css:78` (`transform-origin: bottom left`) vs `:83-86` (`.model-picker-dropdown-down` overrides only `top`/`bottom`)
- **Problem:** The compact prepass `ModelPicker` opens downward (`dropdownDirection="down"`), but `.model-picker-dropdown-down` doesn't override `transform-origin`, so the `panel-scale-in` entrance still grows from `bottom left`. A menu opening downward should scale from its top edge; the current origin makes it appear to "rise up" into place. The upward toolbar picker correctly uses `bottom left`.
- **Fix:** `.model-picker-dropdown-down { transform-origin: top left; }`.

---

## Transcript / message rendering

### Transcript-1 · [High] `transcript` array prop breaks `MessageItem` memo on every token → per-token markdown re-parse of visible user messages
- **Category:** Performance
- **Location:** `transcript/rows/message-row.tsx:47` (`transcript={transcript}`) → `transcript/message-item.tsx:137` (`memo(MessageItemView)`) → `transcript/message-item/content.tsx:99` (`UserParts` calls `renderMarkdown(part.text)` inline)
- **Problem:** Every `MessageItem` receives the *entire* `transcript` array (needed only by `useRecovery` to walk back to the previous user message on error/interrupted turns). The host emits a new `transcript` array reference on each streaming token, so `memo()` shallow-compares fail for **every visible message on every token** — not just the streaming one. `UserParts` then re-runs `renderMarkdown(part.text)` with no `useMemo`, so every visible user prompt is re-parsed through `marked` + `DOMPurify` on every token (~6 snapshots/sec). Assistant text avoids this only because `BufferedTextPart` caches `html` in `useState`; user messages have no such guard.
- **Fix:** Compute recovery once per row in the row builder (it already has `transcript` + `transcriptIndex`) and pass a scalar `previousUserMessageId`/`null` instead of the array. Separately wrap `renderMarkdown(part.text)` in `UserParts` in `useMemo([part.text])`.

### Transcript-2 · [High] Entrance animation replays on every virtualized remount during scroll
- **Category:** Jank/Layout-shift
- **Location:** `styles/transcript.css:977-986`
- **Problem:** `[data-role="assistant"], [data-role="user"], [data-role="system"] { animation: panel-entrance … both; animation-delay: 30ms }` matches any mounted message shell; only `[data-streaming="true"]` is suppressed. The virtual list (`overscan: 10`) unmounts/remounts rows as they leave the overscan window, so scrolling more than ~10 rows remounts messages and replays the 280 ms fade-up — with a 30 ms `opacity:0` pre-delay via `both` fill. On a long transcript this produces a stream of fade-up animations the user didn't ask for, reading as flicker during normal scroll navigation.
- **Fix:** Scope the entrance to genuinely new messages only — set a `data-entered` attribute on first append (cleared after one frame/`animationend`) and select `[data-role][data-entered]`. At minimum drop the 30 ms delay so remounts don't start at `opacity:0`.

### Transcript-3 · [Medium] `ReasoningBlock` re-parses markdown on every reasoning token with no throttle
- **Category:** Performance
- **Location:** `transcript/message-item/reasoning-block.tsx:21` (`const html = useMemo(() => (open ? renderMarkdown(text) : ''), [open, text])`)
- **Problem:** Recomputes whenever `text` changes — and reasoning streams token-by-token, so `part.text` is a new string each delta. Unlike `BufferedTextPart` (which throttles to `MARKDOWN_PARSE_THROTTLE_MS = 100` and only re-parses the last part), an auto-expanded reasoning block runs the full `marked + DOMPurify` pass on the *entire* reasoning text on every token. With `prefs.autoExpandReasoning` on (the default), this is the dominant per-token markdown cost for thinking-heavy turns.
- **Fix:** Route streaming reasoning through the same throttled buffered-parse path as `BufferedTextPart`, or gate the re-parse on a time ref so it runs at most every ~100 ms while `text` is still changing, with a final immediate parse when streaming ends.

### Transcript-4 · [Medium] `dangerouslySetInnerHTML` rewrite mid-stream destroys text selection every ~100 ms
- **Category:** Interaction
- **Location:** `transcript/buffered-text-part.tsx:89-95`
- **Problem:** During streaming, `html` updates at most every 100 ms and is applied via `dangerouslySetInnerHTML`. Each distinct string causes Preact to re-set `innerHTML`, recreating the body's DOM nodes and clearing any `Selection` the user made inside the streaming message (e.g. selecting a half-streamed code snippet to copy). The selection silently vanishes up to 10×/second.
- **Fix:** Render completed leading text into a stable node and only mutate the trailing streaming fragment; or detect an active selection within the body (`document.getSelection().anchorNode` contained in the body) and skip `setHtml` until it clears. Cheaper mitigation: lengthen the throttle to 200-250 ms.

### Transcript-5 · [Medium] Assistant bubble width snaps from 88% to content-width when streaming ends (short completions)
- **Category:** Jank/Layout-shift
- **Location:** `transcript/message-item/inner.tsx:49`; tokens `styles/index.css:234-235`
- **Problem:** While streaming the shell forces `w-[min(var(--message-assistant-width),100%)]` (88%); when `isCurrentlyStreaming` flips false the class is removed and the shell reverts to `w-fit max-w-[88%]`. Width is deliberately not in the transition list, so for any reply narrower than 88% ("Done.", short confirmations) the bubble instantly snaps narrower on completion, and the virtualizer then re-measures the row (nudging auto-follow).
- **Fix:** Keep `min-w-[var(--message-assistant-width)]` (or a smaller min) on completed assistant messages so the bubble doesn't shrink on completion, or accept a one-time `transition-[width]` only on the streaming→false edge. A min-width is the lower-risk option given the no-horizontal-jitter goal.

### Transcript-6 · [Medium] Tool-call card `aria-label` overrides all inner content; nested interactive children inside `role="button"`
- **Category:** A11y
- **Location:** `transcript/tool-call-card.tsx` (root `<div role="button" aria-label="Toggle tool call details">`); `transcript/tool-call-item.tsx` (`SubagentSingleBlock` root `aria-label="Toggle subagent details"`)
- **Problem:** `aria-label` on a `role="button"` replaces the accessible name, so a screen-reader user landing on a tool card hears only "Toggle tool call details" — the tool name, command preview, status (Running/Failed), duration, and size hint are all suppressed. The card also contains live interactive descendants (the copy-on-click "Failed" `StatusChip` with `role="button"`, resize handles, the terminal `<pre>`), nested inside a button role — questionable semantics and unpredictable reachability depending on SR form-mode heuristics.
- **Fix:** Drop the `aria-label` and let the name compose from the visible header (or `aria-labelledby` the tool-name span). Make only the header row the button (`role="button"` + `onClick` on `ToolCallHeader`, not the whole card) so the body's selectable/copyable content is no longer nested inside a button.

### Transcript-7 · [Medium] Tool-call header hit area is ~26 px and the body swallows clicks
- **Category:** Hitbox
- **Location:** `transcript/tool-call-card.tsx`, `transcript/tool-call-item.tsx`
- **Problem:** The clickable header row is ~26 px tall and the whole card body is the toggle target, so clicks meant to select/copy output instead collapse the card. The visible affordance (chevron) is smaller than the header and off to one side.
- **Fix:** Restrict the toggle to the header row, enlarge the header's hit height to ~32 px, and make the body non-interactive for collapse (let text selection work).

---

## Virtualization & scroll

### Virtual-1 · [High] `measureRowElement` guard leaks detached DOM + ResizeObserver entries per virtualized-out row
- **Category:** Performance / memory
- **Location:** `transcript/virtual-list.tsx:357-360`
- **Problem:** The stable ref callback guards on `if (element)`, so when a row virtualizes out of the overscan window Preact calls `measureRowElement(null)` and the guard silently drops it. In `@tanstack/virtual-core`, `measureElement(null)` is the *only* path that iterates `elementsCache` and unobserves disconnected nodes. The ResizeObserver self-clean only fires when an entry is *delivered*, and a detached node never delivers; the per-key replace only cleans if the *same key* later re-mounts. So every row key the user scrolls past and never returns to stays in `elementsCache` and is still observed by the shared `ResizeObserver`, retaining its entire detached DOM subtree (heavy markdown / code blocks / tables). In a long streaming chat — the common case, where the user sits at the bottom while history scrolls up — this leaks essentially every historical message for the life of the transcript. The code comment correctly justifies the *stable* callback; the `if (element)` guard is an independent bug.
- **Fix:** Drop the guard and pass `null` through so tanstack runs its disconnect cleanup:
  ```ts
  const measureRowElement = useCallback(
    (element: HTMLDivElement | null) => { virtualizer.measureElement(element); },
    [virtualizer],
  );
  ```
  This matches tanstack's documented `ref={virtualizer.measureElement}` usage and preserves the stable-callback benefit.

### Virtual-2 · [High] `scroll-behavior: smooth` is actually active on `.transcript` — contradicting the code comment; restore paths animate instead of snapping
- **Category:** Scroll / Jank
- **Location:** `styles/transcript.css:10-14` (comment claiming "No CSS smooth-scroll") vs `styles/index.css:414` (`.transcript { scroll-behavior: smooth }` inside `@layer base`); unguarded restore writes at `transcript/use-transcript-scroll-anchor.ts:102` and `transcript/scroll-anchor.ts:49`
- **Problem:** `transcript.css` deliberately does **not** redeclare `scroll-behavior`, but `index.css:414` sets `scroll-behavior: smooth` on `.transcript` (in `@layer base`) and that rule wins the cascade — `transcript.css`'s `.transcript` rule never sets `scroll-behavior`, so there is nothing to override it. (The `scroll-behavior: auto !important` rules at `index.css:106`/`:116` apply only under `prefers-reduced-motion` / `data-reduce-motion`.) So smooth-scroll is active — directly contradicting the comment at `transcript.css:13`. `scrollToBottom` and `useSmoothAutoFollow` defend by toggling inline `scroll-behavior='auto'`, but two restore paths write `scrollTop` without the guard: `useTranscriptScrollAnchor`'s `el.scrollTop += delta` (runs when a tool body above the viewport resizes while reading) and `restoreMessageScrollAnchor`'s `container.scrollTop += delta` (runs when loading older messages). Under `smooth` these animate over ~300 ms instead of pinning instantly, producing a visible slide/jump and re-firing scroll events that perturb the anchor capture.
- **Fix:** Prefer keeping smooth for manual scroll but guarding the two restore writes the same way `scrollToBottom` does: save `el.style.scrollBehavior`, set `'auto'`, assign `scrollTop`, restore. (Alternatively make the comment true by adding `scroll-behavior: auto` to the `.transcript` rule, sacrificing the manual-smooth nicety.) Verify in DevTools that `getComputedStyle(.transcript).scrollBehavior` is `smooth` today.

### Virtual-3 · [Medium] Always-on rAF loop in `useSmoothAutoFollow` ticks at 60 fps even when idle
- **Category:** Performance
- **Location:** `transcript/use-transcript-scroll.ts:310-366`
- **Problem:** The effect's deps are all stable refs/`setState`, so it mounts once and the `requestAnimationFrame(tick)` loop runs for the entire lifetime of the transcript — including when nothing is streaming and the user is not at the bottom. Each idle frame does a cheap check plus a `style.scrollBehavior` read, but it still wakes the webview main thread 60×/s and prevents idle, which matters in a VS Code webview that should sit quiet between turns.
- **Fix:** Gate the loop on activity: start it when `busy` becomes true (or when `autoFollowRef.current`/`isInitialPositioning` flips true) and cancel it when idle. `scrollToBottom`/`jumpToLatest` already do their own synchronous snaps and don't need the persistent loop.

---

## Session tabs

### Tabs-1 · [High] Active tab is never scrolled into view on activation
- **Category:** Interaction / Overflow
- **Location:** `session-tabs/index.tsx` (no effect watching `activeSession`; no `scrollIntoView` anywhere in `session-tabs/`)
- **Problem:** When the active session changes (host-driven selection, closing an adjacent tab, or a DnD commit near an edge), nothing calls `scrollIntoView`/`scrollLeft` on the strip. Combined with the hidden scrollbar (Tabs-3), a user can end up looking at a strip where the active tab is scrolled entirely off-screen with no visual cue that it exists elsewhere. The drag auto-scroll in `drag-and-drop/auto-scroll.ts` only runs during an active drag.
- **Fix:** Add a `useEffect` keyed on `activeSession?.path` that finds the matching `[data-drop-target-tab]` in `stripRef.current` and calls `el.scrollIntoView({ behavior:'smooth', block:'nearest', inline:'nearest' })` — or manually nudges `strip.scrollLeft` so the active tab is fully visible without forcing center-scroll.

### Tabs-2 · [High] `+` new-tab button and connecting spinner scroll away inside the overflow strip
- **Category:** Interaction / Overflow
- **Location:** `session-tabs/index.tsx:411-425` (button + spinner are children of `.session-tabs-strip`); `styles/tabs.css:42-54` (`.session-tabs-strip { overflow-x: auto }`)
- **Problem:** The new-tab affordance and the connecting indicator live inside the scroll container, so once enough tabs overflow and the user scrolls left to reach an earlier tab, the `+` is scrolled out of view. The user must scroll all the way back to create a new session — a dead-end for the primary "new session" action precisely when many sessions exist.
- **Fix:** Move the `+` (and spinner) out of `.session-tabs-strip` into a sibling flex item (e.g. `.session-tabs-actions`) that doesn't scroll, so it stays pinned at the trailing edge. (This also fixes Tabs-6.)

### Tabs-3 · [Medium] Floating drag ghost uses `left`/`top` and re-renders the whole strip every `pointermove`
- **Category:** Performance / Jank
- **Location:** `session-tabs/index.tsx:215-225` (ghost inline `left`/`top`); `session-tabs/drag-and-drop/pointer-handlers.ts:42-56` (`setDragState` per move); `use-drag-and-drop.ts:139`
- **Problem:** Each `pointermove` calls `setDragState`, re-rendering the entire `SessionTabs` component (all `SessionTab` children re-run; they aren't `memo`'d, and props include freshly-allocated `Map`s like `sessionByPath`/`openIndexByPath`, so memoization would fail shallow checks anyway). The ghost is then positioned with `left`/`top`, which invalidate layout per frame instead of compositing. With 15-25 tabs the per-frame reconciliation + layout cost produces visible drag jank, and the auto-scroll tick re-arms the same path at rAF cadence.
- **Fix:** Drive the ghost imperatively: keep `dragState` only for `dropIndex` (low-frequency) and update the floating element via a `ref` + rAF loop setting `el.style.transform = translate3d(x,y,0)` (no React state). `memo(SessionTab)` and pass stable primitive props (compare by `tabPath`) so non-source tabs skip re-render during drag.

### Tabs-4 · [Medium] No overflow affordance: scrollbar hidden, no edge fade, no overflow menu
- **Category:** Overflow / Readability
- **Location:** `styles/tabs.css:50-52` (`scrollbar-width: none`) and `:56-58` (`::-webkit-scrollbar { display: none }`)
- **Problem:** The strip scrolls horizontally (good, no wrap) but the scrollbar is suppressed in both engines and there is no gradient fade, chevron, or overflow menu. A user with 15+ tabs has no signal that tabs are clipped off either edge, and mouse users without a horizontal-scroll gesture may not discover the hidden tabs at all. The only way to reveal them is to start a drag (edge auto-scroll) — not an obvious affordance.
- **Fix:** Surface a thin custom scrollbar, or add edge gradient masks toggled when `scrollWidth > clientWidth` (via a `useLayoutEffect` measuring `strip.scrollWidth`), or add a trailing `⋯` overflow menu listing elided tabs.

### Tabs-5 · [Medium] A11y: no roving tabindex, no keyboard reorder, no Delete-to-close
- **Category:** A11y
- **Location:** `session-tabs/index.tsx:124-130` (plain `<button type="button">`, no `tabIndex`); `:389` (`role="tablist"`); no arrow-key handler anywhere
- **Problem:** Every tab button is in the natural Tab order, so with N open tabs the keyboard user must press Tab N times to escape the strip. The WAI-ARIA tabs pattern expects roving tabindex (only the selected tab is `tabindex 0`, siblings `-1`) with Left/Right to move, Home/End for first/last, and Delete to close. None is implemented; the `role="tab"`/`aria-selected` markup is correct in isolation but the interaction model is just a row of plain buttons.
- **Fix:** `tabIndex={isActive ? 0 : -1}` on the main button, add a `keydown` on the tablist for ArrowLeft/Right (move focus + select), Home/End, and Delete (`onClose`). Optionally add `aria-controls` pointing at the panel region.

### Tabs-6 · [Medium] A11y: `+` button and connecting indicator sit inside `role="tablist"` with no `role="tab"`
- **Category:** A11y
- **Location:** `session-tabs/index.tsx:389` (tablist), `:412` (`+`), `:422` (connecting `<span>`); `DropGap` correctly carries `aria-hidden`
- **Problem:** The ARIA `tablist` content model permits only `tab`/`group` children. The new-session `<button>` and connecting spinner are direct children without `role="tab"`, so AT traversing the tablist announces a non-tab control mid-list, breaking the "N tabs" mental model.
- **Fix:** Relocate the `+` and connecting indicator to a sibling of `.session-tabs-strip` (outside the `tablist`). Fixed by Tabs-2.

### Tabs-7 · [Medium] Hover feedback persists on inactive tabs during drag
- **Category:** Hover / Drag-drop
- **Location:** `styles/tabs.css:67-69` (`.session-tab:hover { --session-tab-surface: hover }`); `:14-16` (`body.session-tab-dragging { user-select: none }` — only user-select neutralized)
- **Problem:** During a drag `:hover` still applies to whatever tab the pointer passes over, so inactive tabs light up even though the user is reordering, not selecting — competing with the accent drop indicator and reading as "this tab is being targeted."
- **Fix:** Scope hover to non-dragging tabs: `.session-tabs:not(.dragging) .session-tab:hover { … }` or `.session-tab:not(.dragging-source):hover { … }`.

---

## Overlays & transient UI

### Overlays-1 · [High] `aria-modal="true"` on non-modal inline prompts lies to screen readers
- **Category:** A11y
- **Location:** `extension-ui-prompt.tsx:102, 183, 285`
- **Problem:** `ConfirmPrompt` (`role="alertdialog" aria-modal="true"`), `SelectPrompt` (`role="dialog" aria-modal="true"`), and `InputPrompt` (`role="dialog" aria-modal="true"`) are inline strips above the composer — no backdrop, the rest of the page is **not** inert. `aria-modal="true"` tells AT to treat all content outside the dialog as inert, so screen-reader users are told the transcript/composer are unavailable when they are fully interactive. There's also no focus trap (key handling is container-scoped via `onKeyDown` on the focused `containerRef`, lost the moment focus leaves), so the modal promise is broken both ways.
- **Fix:** Drop `aria-modal="true"` from all three. For a non-modal inline prompt use `role="alertdialog"`/`role="dialog"` alone (or `role="group" aria-label={title}` if no dialog semantics are intended). If modal behavior is actually desired, render the backdrop + trap + `inert` on siblings as `RunOutcomeDialog` does.

### Overlays-2 · [Medium] Tooltip doesn't track or dismiss on ancestor scroll
- **Category:** Overlay-positioning
- **Location:** `components/tooltip.tsx:125` (positioning effect deps), `:148` (resize listener, no scroll listener)
- **Problem:** The host is `position:fixed` and positioned once from `trigger.getBoundingClientRect()`. Resize dismisses it, but transcript scroll does not — and this is a chat UI where the transcript auto-scrolls constantly during a run. While the pointer rests on a live chip (tokens/sec, context window), the trigger scrolls under the viewport but the tooltip stays pinned to its original fixed coordinates, ending up visually detached from its trigger (and potentially overlapping unrelated content). This is the exact live-indicator use case the component was built for.
- **Fix:** Add a scroll listener while visible that re-runs positioning or hides the tooltip. Cheapest: `window.addEventListener('scroll', () => setIsVisible(false), true)` (capture so it catches scroll within scrollable containers), torn down in the same effect as the resize listener.

### Overlays-3 · [Medium] Context menu has no ARIA roles, arrow-key nav, or focus management
- **Category:** A11y
- **Location:** `components/context-menu.tsx:78` (container no `role`), `:81`/`:88` (items no `role="menuitem"`)
- **Problem:** The menu opens on `contextmenu`/Shift+F10 but focus is never moved into it, the container has no `role="menu"`, items have no `role="menuitem"`, and there's no Arrow-Up/Down nav — only Escape dismisses. Keyboard users land on the trigger and must Tab around to discover items; no `aria-expanded`/`aria-haspopup` on the trigger side either. Click-outside and Escape are correctly handled, but the menu is effectively mouse-only for navigation.
- **Fix:** `role="menu"` on `.block-context-menu`, `role="menuitem"` on each item; on open move focus to the first item; implement Arrow/End/Home cycling; restore focus to the trigger on close.

### Overlays-4 · [Medium] Context menu viewport clamp uses magic numbers and never flips
- **Category:** Overlay-positioning
- **Location:** `components/context-menu.tsx:56`
- **Problem:** Clamping is `Math.min(menu.y, innerHeight - 120)` and `Math.min(menu.x, innerWidth - 220)`. The `120`/`220` are hardcoded to the current 2-item, `min-width:220px` menu. A third item breaks the height reserve and the menu overflows the bottom; a long pref label pushes width past 220 and the left clamp no longer keeps the right edge on-screen. There's also no flip-to-above: a right-click near the bottom-left clamps the top, so the menu still grows downward from a point visually disconnected from the cursor.
- **Fix:** Measure the rendered menu (`ref.current.getBoundingClientRect()`) after mount and clamp by actual size; if `menu.y + height > innerHeight`, flip `top` to `menu.y - height` (above the cursor) instead of clamping down.

### Overlays-5 · [Medium] Notice banner animates `max-height` (layout) and caps at 80 px; no exit animation
- **Category:** Jank/Layout-shift
- **Location:** `styles/tabs.css:23` (`@keyframes notice-enter` animates `max-height: 0 → 80px`)
- **Problem:** Animating `max-height` forces reflow every frame (the textbook janky-animation case), and the 80 px end value is a magic number — a long notice (or one expanded via "More") exceeds it and is clipped during the entrance then snaps when the animation ends. There's also no exit animation: `onDismiss` removes the node instantly, so everything below jumps up with no transition, while the entrance was animated — inconsistent feel.
- **Fix:** Animate `transform: translateY(-4px)` + `opacity` only (the keyframe already does) and drop the `max-height` interpolation; if a height transition is required, use `grid-template-rows: 0fr → 1fr` on a wrapper. Add a symmetric exit animation on dismiss.

### Overlays-6 · [Medium] Resize handle has a 6 px hit area and is keyboard-inaccessible
- **Category:** Hitbox / A11y
- **Location:** `styles/highlight.css:177` (`.resize-handle { height: 6px }`), `components/resize-handle.tsx:24` (`role="separator"`), `:27` (`tabIndex={-1}`)
- **Problem:** The visible handle is 6 px tall — usable with a precise mouse but well below a comfortable grab target, with no expanded pseudo-element hit area. It's `tabIndex={-1}` with no arrow-key handling and no `aria-valuenow/min/max`, so keyboard users cannot resize at all even though `role="separator"` implies an adjustable separator. `useResizableHeight` exposes `reset()` but no double-click reset is wired, so the affordance is mouse-drag-only.
- **Fix:** Add an invisible hit area `::before { content:''; position:absolute; inset:-5px 0 }` (keep the 6 px visual). Add `tabIndex={0}`, `aria-valuenow/min/max`, Arrow-Up/Down handlers (10 px steps); wire `onDoubleClick={() => reset()}`.

### Overlays-7 · [Low] Run-outcome dialog initial focus lands on the container, not a control
- **Category:** Interaction
- **Location:** `run-outcome-dialog.tsx:30` (`node.focus()`)
- **Problem:** On open, focus moves to the dialog `div` itself (`tabIndex={-1}`), not to the first meaningful control. The first Tab goes to the first rating button (fine), but the initial focus ring sits on a non-interactive node. The focus trap and restore are otherwise correct.
- **Fix:** After mount, focus the first rating button or Cancel (`dialogRef.current.querySelector('button')?.focus()`).

### Overlays-8 · [Low] Run-outcome dialog relies on focus trap instead of body scroll-lock
- **Category:** Interaction
- **Location:** `run-outcome-dialog.tsx`
- **Problem:** Background scroll isn't locked (`body` overflow); the focus trap keeps keyboard inside but a mouse user can wheel the transcript behind the modal, which can re-anchor scroll in confusing ways.
- **Fix:** Toggle `document.body.style.overflow = 'hidden'` on mount/restore (or `inert` the transcript + composer), consistent with the modal styling already present.

---

## Global / layout / file-changes

### Global-1 · [High] Revert is a one-click destructive action with no confirmation
- **Category:** Interaction
- **Location:** `file-changes-panel.tsx:163-167` (revert button → `onRevertFile(change.path)`)
- **Problem:** The per-row revert button fires `onRevertFile` immediately on click. Reverting an agent's edits to a file is destructive and not obviously undoable from the webview. The button is 24×24, sits in a row that only reveals its actions on hover, and has no confirm dialog, no undo toast, and no disabled-while-running guard. A misclick (or an errant click while aiming for the adjacent "open in editor" button ~4 px away) silently discards work. This is the single highest-risk interaction in the panel.
- **Fix:** Add a lightweight inline confirm (two-state button that swaps to "Revert?" / "Confirm" for ~3 s, or a small popover) before calling `onRevertFile`, and/or surface an undoable toast via the host. At minimum gate the click when `busy` is true.

### Global-2 · [High] Row action buttons are invisible to keyboard and touch users
- **Category:** A11y
- **Location:** `styles/file-changes.css:214`/`:249` (`opacity: 0.3`), reveal only at `:258-261` via `.file-change-item:hover`; no `:focus-within`, no `@media (hover: none)`
- **Problem:** Open / copy / revert buttons default to `opacity: 0.3` and only reach `0.85` on `:hover`. A keyboard user tabbing into a row sees the accent `:focus-visible` outline (good) but the icon glyph stays at 0.3 opacity — effectively invisible against the dark surface. On touch devices the actions never become discoverable. Fails WCAG 2.1 SC 1.4.11 (non-text contrast 3:1) and 2.5.1.
- **Fix:** Add `.file-change-item:focus-within .file-change-open, .file-change-copy, .file-change-revert { opacity: 0.85 }`, and a `@media (hover: none) { .file-change-open, … { opacity: 0.85 } }` block so touch users always see the actions.

### Global-3 · [Medium] `backdrop-filter: blur(16px)` paints an invisible blur over an opaque background
- **Category:** Performance
- **Location:** `styles/file-changes.css:11-12`
- **Problem:** `.file-changes-panel` sets `backdrop-filter: blur(16px)` but its background is `--panel-overlay-surface` → `#0d1014`, fully opaque — so the backdrop is completely covered and the blur has zero visual effect, yet the compositor still samples and blurs the entire backdrop region (the scrolling transcript underneath) on every frame the panel is visible. Pure wasted GPU work on a frequently-visible overlay, in both collapsed and expanded states.
- **Fix:** Remove both `backdrop-filter` lines. If a translucent panel is ever desired, switch the background to an `rgba()` and scope the blur to `.expanded` only.

### Global-4 · [Medium] Expand/collapse width transition animates `auto → fixed` (snaps instead of easing)
- **Category:** Jank/Layout-shift
- **Location:** `styles/file-changes.css:15-21` (transition includes `width`), `:27-29` (`.expanded { width: min(420px, …) }`), collapsed width `auto` (`:49`)
- **Problem:** The collapsed panel is `width: auto` (content-sized badge). On expand, `width` transitions to `min(420px, …)`, but CSS cannot interpolate from `auto`, so width jumps in one frame while the `panel-entrance` opacity/transform animation plays on the list — a snap-pop rather than a smooth grow. Animating `width` also forces layout reflow per frame, compounding with the `backdrop-filter` cost.
- **Fix:** Drop the `width` transition (let the list entrance animation carry the reveal) or animate `max-width`/`grid-template-columns` from a concrete collapsed pixel width. Don't transition `width` between `auto` and a fixed value.

### Global-5 · [Medium] File-change status is conveyed by color alone (colorblind risk)
- **Category:** Readability
- **Location:** `styles/file-changes.css:141-160` (`.kind-created/modified/deleted` use only an inset `box-shadow` ring in success/warning/danger)
- **Problem:** The only per-row signal distinguishing created (`#51d88a`) / modified (`#e4b84f`) / deleted (`#ff6677`) is a 1.5 px colored ring around the file-type icon. For deuteranopia/protanopia, green↔red and green↔amber are confusable. Deleted gets an extra opacity/grayscale cue, but created-vs-modified is color-only. A created file with no line stats, or a modified file with only additions, collapses to color alone. Fails WCAG SC 1.4.1 (Use of Color).
- **Fix:** Add a one-letter status glyph (A/M/D) or a shape variant (`+`/`~`/`✕`) inside/beside the icon, or a 2-char status chip, so kind is legible without color.

### Global-6 · [Medium] `text-muted/60` token label and composer placeholder fail WCAG AA
- **Category:** Readability
- **Location:** `system-prompts.tsx:118` (`text-[10px] text-muted/60`); `ui.tsx` composer `placeholder:text-muted/60`
- **Problem:** `--panel-muted` is `#958f82`, ~6.3:1 on `#020203` (passes AA). But at `/60` opacity over near-black the effective color is ~`#5a564f` (~2.7:1 contrast). For 10 px mono text that's well below AA's 4.5:1 and even below the 3:1 large-text/non-text threshold. The token label and the composer placeholder are both unreadable for low-vision users.
- **Fix:** Use `text-muted` (full strength) for the token label, or `/80` at minimum; for the placeholder use `text-muted/70` (~4:1, borderline) or full `text-muted`. Bumping the token label to 11 px also helps.

### Global-7 · [Medium] `SystemPromptCard` key includes mutable `summary` → remount loses open state
- **Category:** Jank/Layout-shift
- **Location:** `system-prompts.tsx:125` (`key={`${prompt.source}:${prompt.title}:${prompt.summary}:${index}`}`)
- **Problem:** `prompt.summary` is not immutable — for the `provider` entry it updates when the provider resolves, and summaries can be re-derived. Including it in the key means a summary update causes Preact to unmount the old card and mount a new one, discarding local `open` state (and the `useMemo`'d markdown, forcing a re-render). An expanded card can collapse unexpectedly when the backend updates a summary mid-session.
- **Fix:** Drop `summary` from the key; use `${prompt.source}:${prompt.title}` (or a stable `prompt.id` if one exists). Index-only is acceptable here since the list is stable per session.

### Global-8 · [Medium] `NoticeContext` provider value is recreated every render
- **Category:** Performance
- **Location:** `app-body.tsx:416` (`value={{ notice: viewState.notice, dismiss: () => postMessage({ type: 'dismissNotice' }) }}`)
- **Problem:** The `NoticeContext.Provider` value object (and its inline `dismiss` arrow) is recreated on every `AppBody` render, so every consumer re-renders even when `notice` is unchanged. The consumer is `transcript/message-item/error-detail.tsx` (per error message), rendered per error — so each error detail re-renders on every host state tick. `viewState` updates frequently during streaming, a steady source of unnecessary work. (Note the sibling `AskUserContext` at `:417` uses `derived.askUserContextValue`, which is presumably already memoized — `NoticeContext` should match it.)
- **Fix:** `const noticeValue = useMemo(() => ({ notice: viewState.notice, dismiss }), [viewState.notice, dismiss])` with a stable `dismiss` via `useCallback`.

### Global-9 · [Low] `#app` uses `height: 100vh` instead of a dynamic viewport unit
- **Category:** Layout
- **Location:** `styles/index.css:374` (`#app { height: 100vh }`)
- **Problem:** In a VS Code webview the iframe is sized by the host, so `100vh` is usually fine — but on platforms where the webview overlays transient browser chrome (or in `dev.html` browser testing) `100vh` can include the area behind the URL bar, producing a slight vertical overflow/clip of the composer footer. The modern equivalents (`100dvh`/`100svh`) are safer and equally supported in current Chromium.
- **Fix:** `height: 100dvh` (with `100vh` fallback first for older engines).

---

## Suggested fix order (rough ROI)

1. **Virtual-1** (detached-DOM leak) — one-line fix, prevents unbounded memory growth in the core use case (long streaming chats).
2. **Transcript-1** (transcript-array memo break) — removes per-token markdown re-parse of every visible user message.
3. **Global-1** (revert no-confirm) — highest-risk interaction; cheap guard.
4. **Overlays-1** (aria-modal lie) — one-line removal each; fixes a screen-reader correctness bug.
5. **Global-2** (file-change actions invisible to keyboard/touch) — small CSS addition, broad a11y win.
6. **Virtual-2** (smooth-scroll contradiction) — verify with DevTools, then guard two restore writes.
7. **Transcript-2** (entrance animation remount) — scope the animation to new messages.
8. **Tabs-1 / Tabs-2** (active-tab scroll-into-view, `+` pinned) — core tab UX.
9. The remaining Mediums (hitboxes, overflow affordances, color-only status, contrast, NoticeContext memo, width-snap) as a batch.
