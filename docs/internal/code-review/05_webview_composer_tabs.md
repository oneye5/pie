# Webview Panel Review — Composer, Session Tabs, and Supporting Modules

Scope: `extension/src/webview/panel/` top-level files plus subfolders `composer/`,
`context-window/`, `file-drop/`, `hooks/`, `session-tabs/`, `utils/`, and
`file-changes-panel.tsx`. Reviewed from a skeptical senior-engineer lens:
oversized files, prop drilling, duplicated state/logic, re-render risks,
type unsafety, effect-dep bugs, hooks misuse, a11y gaps, inline styles vs CSS,
and STATE_CONTRACT conformance.

Cross-checked against `docs/STATE_CONTRACT.md` (Reducer Purity, Webview-Local
State allowlist, Snapshot Recovery). No reducer purity violations found in
scoped code; the webview-local state used (optimistic overlay, draft-restore,
drag state, scroll) all fall under the contract's allowlist. Notable contract
observations called out inline.

## Files reviewed (paths + line counts)

### Top-level `panel/`
- `extension/src/webview/panel/app-body.tsx` — 656
- `extension/src/webview/panel/file-changes-panel.tsx` — 648
- `extension/src/webview/panel/extension-ui-prompt.tsx` — 440
- `extension/src/webview/panel/tool-call-summary.ts` — 308
- `extension/src/webview/panel/ui.tsx` — 266
- `extension/src/webview/panel/use-app-handlers.ts` — 235
- `extension/src/webview/panel/run-outcome-dialog.tsx` — 195
- `extension/src/webview/panel/file-path.tsx` — 191
- `extension/src/webview/panel/auto-scroll.ts` — 166
- `extension/src/webview/panel/pruning-banner.tsx` — 156
- `extension/src/webview/panel/system-prompts.tsx` — 130
- `extension/src/webview/panel/markdown.ts` — 114
- `extension/src/webview/panel/chat-prefs.ts` — 110
- `extension/src/webview/panel/panel.tsx` — 92
- `extension/src/webview/panel/completion-sound.ts` — 75
- `extension/src/webview/panel/state-validator.ts` — 74
- `extension/src/webview/panel/panel-state.ts` — 52
- `extension/src/webview/panel/use-session-recovery.ts` — 42
- `extension/src/webview/panel/system-prompt-tokens.ts` — 40
- `extension/src/webview/panel/accent-contrast.ts` — 36
- `extension/src/webview/panel/app.tsx` — 17
- `extension/src/webview/panel/collapsible-state.ts` — 7

### `panel/composer/`
- `ui-appearance-settings.tsx` — 471
- `hooks.ts` — 466
- `settings-menu-subcomponents.tsx` — 440
- `use-composer-indicators.ts` — 194
- `settings-menu.tsx` — 191
- `toolbar.tsx` — 169
- `settings-menu-helpers.ts` — 143
- `indicator-signature.ts` — 119
- `model-list.ts` — 116
- `actions.tsx` — 80
- `attachments.tsx` — 74
- `inputs.ts` — 58
- `use-token-rate.ts` — 41
- `affordances.ts` — 38
- `model-state.ts` — 37
- `turn-latency.ts` — 13

### `panel/context-window/`
- `breakdown.ts` — 418
- `indicator.ts` — 65

### `panel/file-drop/`
- `paths.ts` — 284
- `index.ts` — 125
- `files.ts` — 112
- `types.ts` — 30

### `panel/hooks/`
- `use-host-sync.ts` — 441
- `ask-user-context.ts` — 46
- `notice-context.ts` — 27

### `panel/session-tabs/`
- `index.tsx` — 599
- `token-usage.ts` — 442
- `use-drag-and-drop.ts` — 214
- `drag-and-drop/drag-state.ts` — 163
- `drag-and-drop/pointer-handlers.ts` — 151
- `run-state.ts` — 137
- `drag-and-drop/auto-scroll.ts` — 77
- `drag-and-drop/effects.ts` — 76
- `drag-and-drop/context-menu.ts` — 61
- `types.ts` — 55
- `tab-avatar.ts` — 44
- `drag-and-drop/constants.ts` — 4

### `panel/utils/`
- `view-state-stabilize.ts` — 79
- `lru-cache.ts` — 59
- `looks-like-path-token.ts` — 40
- `closest-capable-target.ts` — 25
- `cx.ts` — 3

## Notable issues

### Critical

**C1. Rules-of-Hooks violation — `system-prompts.tsx:84-86,88,105`.**
`SystemPromptMessage` calls `if (prompts.length === 0) return null;` (lines 84-85)
**before** invoking `useState` (line 88) and `useMemo` (line 105). Hook order
changes between renders when `prompts.length` crosses 0 — a textbook
Rules-of-Hooks violation. In React this throws; in Preact it can silently
desync hook slots. Verified directly. The `SystemPromptCard` sibling (line 33)
calls hooks unconditionally — that pattern should be mirrored here (move the
early return after the hooks, or gate the whole subtree via the parent).

### High

**H1. Composer memoization defeated every snapshot — `ui.tsx:167-178`, `app-body.tsx`.**
`ui.tsx` builds inline object props for `ComposerToolbar`:
`contextIndicator={contextIndicator ? { label, ariaLabel, severity } : null}` and
`sessionTokenIndicator={{ label, ariaLabel, tooltip }}` — new object identities each
render, defeating any child `memo`. Separately, `Composer = memo(ComposerView)`
(ui.tsx:266) is fed `transcript={viewState.transcript}` (fresh ref each host
snapshot), `transcriptWindow`, and `pendingComposerInputs` (also fresh). During
streaming (~7 snapshots/sec) the memo barrier is effectively a no-op. Why it
matters: the headline `memo()` is wasted work and gives false confidence.

**H2. `useAppBodyDerivedState` stale-state risk — `app-body.tsx:69-97`.**
The composer-model `useMemo` lists only `settingsDefaultModel`,
`settingsDefaultThinkingLevel`, `modelCount` as deps while the factory closure
reads the full `modelSettings` and `availableModels` objects. If `availableModels`
content changes without changing its length (model swap same count), the memo
will **not** recompute → stale `pendingAssistantModelId`. Worth verifying
against actual host mutation behavior; the dep set does not capture the
closure's real reads.

**H3. `use-composer-indicators.ts:40-49,87` — memo chain recomputes every snapshot.**
`pricingByModelId` is memoized on `[availableModels]`, but `availableModels` is a
fresh structured-cloned ref on every host snapshot (`use-host-sync.ts`
stabilizes `prefs`/`pruningSettings`/`pruningCatalog` only — not
`availableModels`). So `pricingByModelId` → `resolvePricing` (line 90, dep
`[pricingByModelId]`) → `completedCostSummary` (line 102) →
`sessionCostIndicator` (line 110) all recompute every snapshot. The comment at
line 87 ("Stable pricing resolver so the completed-cost memo doesn't see a fresh
function ref every snapshot") is directly contradicted by the actual dep. Real
perf regression under streaming.

**H4. `use-host-sync.ts:30-33` module-level mutable stable caches survive HMR.**
`stablePrefs`/`stablePruningSettings`/`stablePruningCatalog` are module-scoped
`let`s; on hot-reload a new view instance can receive a stale ref handoff. The
comment acknowledges "module lifetime" but does not guard HMR. Cross-instance
contamination risk during development.

**H5. `use-host-sync.ts:69-73,264-266` — dead no-op + effect calling it.**
`resetPerSessionState` is a literal no-op (`// no-op: per-session revision
tracking removed`) and there is a `useEffect(() => () => resetPerSessionState(),
[resetPerSessionState])` that exists only to invoke a no-op. Delete both. The
`HostMessageContext.resetPerSessionState` plumbing is now dead surface.

**H6. `use-host-sync.ts:339` cross-origin message hardening is weak.**
`dispatchHostMessage(event.data as HostToWebviewMessage, …)` runs after only a
`typeof event.data.type === 'string'` guard. A foreign `MessageEvent` with
`type: 'state'` and a malformed body flows into `handleStateMessage`, which
dereferences `m.protocolVersion`, `m.state.activeSession?.path`,
`m.state.transcript.map(…)` without per-field validation; `validateViewState`
only logs. No origin check on `event`. The webview accepts arbitrary
`window.postMessage` from devtools/extensions.

**H7. SessionTabs DropGap memo claim is wrong — `session-tabs/index.tsx:43-48,539,559`.**
Every `DropGap` receives the same `dropIndex={activeDropIndex}` prop (lines 539,
559). The memo compares all props including `dropIndex`, so when `activeDropIndex`
changes **all N+1 DropGaps re-render** (each cheaply returns null). The comment
(lines 43-47) claiming "only the (at most two) DropGaps whose `dropIndex` matches
re-render" is incorrect — passing the raw `dropIndex` defeats the optimization.
Should pass `isDropTarget={activeDropIndex===index}` (a boolean that is stable
for non-targets) to make the claim hold. Verified directly.

**H8. `activeSession`/`activeRunSummary` passed to every SessionTab — `index.tsx:553-555`.**
Only the active tab consumes `activeRunSummary` (badge IIFE), yet it is passed to
all tabs. Any `activeSession` identity change (tab switch) re-renders every
memoized `SessionTab`, defeating the memo. Pass `isActive` boolean + scope
`activeRunSummary` to the active tab only.

**H9. Path utilities fully duplicated — `tool-call-summary.ts:38-103` vs `file-path.tsx:11-119`.**
`normalizePathSeparators`, `trimTrailingPathSeparators`, `normalizeComparablePath`,
`relativePathFromBase`, `truncatePathParentFromLeft`, `truncatePathText`,
`truncateText` are duplicated with identical bodies (different max-length
constant). Real maintenance hazard — a shared `path-utils.ts` is overdue.
`escapeHtml`/`truncateString` are also re-implemented in `markdown.ts:13`,
`file-path.tsx:8`, `panel.tsx:50`.

**H10. `token-usage.ts:360` structural-typing footgun.**
`addCompletedUsageCost(completed, usageSummary, fallbackPricing, undefined)`
passes a `SessionTokenUsageSummary` where `AssistantUsage` is expected. Compiles
only because `SessionTokenUsageSummary` is a superset of the `AssistantUsage`
fields the function reads; if `AssistantUsage` gains a required field this
silently breaks. Should cast/assert or share an interface. Verified signature at
`token-usage.ts:317`.

**H11. `file-changes-panel.tsx:570` — `inert={!showDrawer}` boolean attribute.**
`inert` is a presence (boolean) attribute. Preact's boolean-attribute set may
not include `inert`, so `false` can render as `inert="false"` which browsers
treat as inert-present → the panel is wrongly inertsed when the drawer is shown.
Verify Preact omits the attribute on `false`, else this disables interaction on
the open drawer.

**H12. Dead countdown feature — `extension-ui-prompt.tsx:48-79,73,113,209`.**
`ConfirmPrompt`/`SelectPrompt`/`InputPrompt` declare a `timeout?` prop and call
`useCountdown(timeout)`, but `ExtensionUIPrompt` (lines 48-79) never passes
`timeout` from `request`. So `useCountdown(undefined)` → `remaining` always
`null` → countdown UI never renders and the cancel-on-zero effects
(`extension-ui-prompt.tsx:84-87,138-141,223-225`, also duplicated 3×) never fire.
Either wire `request.timeout` through or remove the feature and the three
duplicated cancel-on-zero effects.

**H13. `THINKING_LEVEL_OPTIONS` vs `THINKING_LEVEL_LABELS` mismatch — `settings-menu-helpers.ts:14-19` vs `toolbar.tsx:14-20`.**
`THINKING_LEVEL_OPTIONS` (pruning thinking picker) stops at `high`, while
`toolbar.tsx` `THINKING_LEVEL_LABELS` includes `xhigh: 'Max'`. Both cast
`as ThinkingLevel` and render the union's options; the pruning/settings picker
cannot select `xhigh`. Likely a real UX gap (the toolbar reasoning picker
exposes `xhigh` but the settings picker does not). Caveat: confirm these two
pickers are meant to expose the same level set before treating as a bug.

### Medium

**M1. Oversized god-files.**
- `composer/hooks.ts` (466): `useComposerInput` is ~280 lines (lines 51-330) with
  8 `useEffect`s, 4 refs, and a `use-undo` store — seed, debounce-post, restore,
  resize, focus, submit-latch ×2, checkpoint-clear. Split candidate
  (`useComposerDraftPersistence`, `useComposerUndo`, `useComposerSubmitLatch`).
- `composer/ui-appearance-settings.tsx` (471): `UiFlyout` (~lines 150-471) is one
  component rendering ~15 inline control rows; only `ColorRow`/`FontSelect`/
  `ThemeSelect` extracted, all slider/range rows inline.
- `composer/settings-menu-subcomponents.tsx` (440): 8 components in one file;
  `ExtensionItem` (250-305) and `ExtensionsSection` (308-340) carry 10-prop
  interfaces — heavy prop drilling of `pruningSettings`/`modelEntries`/
  `availableModels`/`skillCatalog`/`toolCatalog`/`onSetPruningSettings`.
- `app-body.tsx` (656): `useAppBodyDerivedState`, `PanelMain`, `BottomSection`,
  `AppBody` + a ~130-line single CSS-vars effect (lines 287-419) with 16 deps.
- `file-changes-panel.tsx` (648): `FileChangeContextMenu` (153-263) interleaved
  with peek/pin/resize/read-state grouping — should be its own file.
- `session-tabs/index.tsx` (599), `token-usage.ts` (442), `breakdown.ts` (418):
  all single-responsibility-overloaded split candidates.

**M2. Duplicated SVG toggle row — `settings-menu-subcomponents.tsx` (~5×).**
Identical 7-line `<svg><polyline points="2.5,6.5 5,9 10.5,3.5" /></svg>` checkbox
markup in `ChatPrefItem` (~line 20), `SkillPrunerSettings` (~102),
`SubagentSettings` (~195), `ExtensionItem` (~260), `ProviderItem` (~355). One
`ToggleRow`/`CheckIcon` component would replace all.

**M3. Duplicated "cap height to transcript space" layout-fit effect.**
`settings-menu.tsx:46-60` and `ui-appearance-settings.tsx:155-180` implement the
same `useLayoutEffect` (`getBoundingClientRect()` → `style.maxHeight` +
`setTimeout(fit,320)` + `resize` listener). A third "measure and cap" mechanism
exists in `useComposerHeightSync` (`hooks.ts:441-466`) via ResizeObserver —
three mechanisms for one concern.

**M4. `composer/hooks.ts:155` `[sessionPath]` seed effect — stale `draftText`.**
The effect reads `draftText`, `clearCheckpointTimer`, `resetHistory` inside but
only declares `[sessionPath]` as dep. Documented (comment) but `draftText` is
captured stale: if host-persisted draft for the same `sessionPath` updates
(e.g. another tab wrote it), this effect will not re-seed. Latent if host ever
mutates `draftText` for a live sessionPath.

**M5. `composer/hooks.ts:232` `[draftRestore?.nonce]` effect accesses `text`.**
The effect reads `draftRestore.text` but depends only on `nonce`. Safe only if
`text` is stable per `nonce` — not enforced by the type `{ text, nonce }`. A
future caller reusing a nonce with different text would silently apply stale
text.

**M6. `composer/hooks.ts:457` — `(window as any).ResizeObserver` unsafe `any`.**
Unsafe cast; should use a typed global or feature-detect with a proper type.

**M7. `settings-menu.tsx:107` — `providers` unmemoized in render body.**
`const providers = [...new Set(availableModels.map(...))].sort(...)` recomputed
every render of `ComposerSettingsMenu` (re-renders on every prefs/typing change
while open). Should be `useMemo`. `toolbar.tsx:65-66` similarly computes
`selectedModelEntry`/`fallbackModelLabel` via `.find`/indexing unmemoized —
inconsistent with the `useMemo` used for `filteredModels`/`modelEntries` adjacent.

**M8. `attachments.tsx:16` — `imagePreviewSrc` rebuilds `data:` URLs each render.**
Template-literal base64 URLs re-allocated every render while the attachments
strip is visible; no memo. Large strings rebuilt per snapshot.

**M9. `ui-appearance-settings.tsx` — ~15 inline `onInput`/`onChange` arrow closures**
(lines 218, 240, 262, 285, 310, 333, 356, 380, 405) recreated each render. Leaf
inputs, low cost, but inconsistent with the codebase's `useCallback` discipline.
Inline `style={{ fontFamily: ... }}` objects at lines 78, 85.

**M10. SessionTabs `role="tablist"` ARIA break — `index.tsx:534-537`.**
Direct children of `role="tablist"` are wrapper `<div class="session-tab">`, not
`role="tab"` elements (the tab button is nested inside). ARIA tablist expects
`tab` children to be directly owned; the wrapper breaks the tablist→tab
relationship for AT. Either drop the wrapper or use `role="presentation"`.

**M11. Pinned tabs lose accessible name — `index.tsx:143-152`.**
The `role="tab"` button's accessible name becomes just the avatar letter (e.g.
"A") since the label text is replaced by the avatar; `title` provides a tooltip
but **not** an accessible name. Add `aria-label={label}` so pinned tabs announce
the session name.

**M12. SessionTab array children missing Fragment key — `index.tsx:538-557`.**
`.map` returns bare `[<DropGap/>, <SessionTab/>]` arrays with no keyed Fragment on
the outer array; Preact warns about missing keys on array children and
reconciliation is fragile. Use `<Fragment key={tabPath}>`.

**M13. `FloatingSessionTab` not memoized — `index.tsx:195-256`.**
Re-renders on every `dropIndex` change even though the ghost transform is driven
imperatively (`use-drag-and-drop.ts:99-106`). Wasted renders during drag.

**M14. `paths.ts:208-213` — `extractPathsFromPlainText` inconsistent failure mode.**
Aborts the **entire** extraction (`return []`) on the first line that isn't a
recognized path/URI. Every other extractor
(`extractPathsFromUriPayload`, `extractPathsFromCodeFiles`,
`extractPathsFromResourceUrls`) filters/skips bad entries. One stray line in a
pasted block silently drops all paths — likely a bug.

**M15. `paths.ts:233` — `decodeURIComponent` not wrapped in try/catch.**
`decodeURIComponent(url.hostname)` / `url.pathname` can throw on malformed
percent-encoding even when URL parse succeeded. `safeGetData` elsewhere is
defensive; this path is not.

**M16. `paths.ts:91-100` — Windows-biased normalization.**
`normalizeAbsolutePath` hardcodes backslash normalization for `C:\` and UNC while
returning unix-absolute unchanged. On a mac/linux VS Code host this still
backslash-ifies Windows-style tokens. Intent unclear vs host OS.

**M17. `closest-capable-target.ts:19-21` — walks only one level up.**
A text node whose `parentElement` also lacks `closest` returns null prematurely.
Limited depth; the cast to `ClosestCapableEventTarget` asserts a
`parentElement?` shape it does not verify (erasure cast at line 18/22).

**M18. `paths.ts:155` unchecked `entry as Record<string, unknown>`.**
Structural cast of arbitrary JSON in `extractPathFromEditorEntry` with no
runtime validation. `paths.ts:178` redundant cast
`files[index] as (FileLike & { path?: string })` — `FileLike` union already
includes `{ path?: string }`. `files.ts:103` `file.type!.trim()` non-null
assertion across a function boundary; a local `const type = file.type` would
avoid the `!`.

**M19. Token formatting duplicated across the codebase.**
`Intl.NumberFormat('en-US')` re-instantiated in `context-window/indicator.ts:3`
**and** `context-window/breakdown.ts:9` (parallel `formatCompactTokens`/
`formatReadableTokens` vs `formatTokenCount`/`formatTokenValue` APIs for the same
domain), plus `session-tabs/token-usage.ts:53,152`,
`system-prompt-tokens.ts:10`. No shared `format-tokens.ts`. `breakdown.ts` also
duplicates remaining-tokens computation between `buildPartialBreakdown`
(206-212) and `buildFullBreakdown` (311-318) instead of calling the existing
`computeRemainingKind`.

**M20. `run-state.ts:30-55,57-77,79-137` — non-exhaustive `switch`.**
`switch (runSummary.status)` with `default: return []/null/{...}` — no
exhaustiveness check. A new `ActiveRunSummary.status` variant silently falls
through to empty menu/badge/controls.

**M21. `use-host-sync.ts:30-33` stable-cache set does not cover `availableModels`.**
Already noted as H3 root cause, but separately: the stabilization allowlist
(`prefs`/`pruningSettings`/`pruningCatalog`) omits `availableModels`,
`modelSettings`, `contextUsage`, etc., all of which feed memo chains downstream.
The contract comment at lines 24-33 explains the *intent* but the coverage is
incomplete relative to that intent.

**M22. `panel.tsx:60-78` — error-overlay `any` casts.**
`(options as any).__e`, `(options as any).__e = (error, vnode, oldVNode) => {...}`,
and error payload `as any` with a `renderError` field not in the `stateApplied`
type. Error-path escape hatch — acceptable but untyped.

### STATE_CONTRACT observations

- The webview-local state used in scope (optimistic overlay, draft-restore,
  drag state, scroll/focus) all falls under the contract's "Webview-Local State"
  allowlist. No contract violations detected.
- `use-host-sync.ts` `handleStateMessage` correctly clears transient UI on
  host-instance or active-session change (lines ~165-180) per "Snapshot
  Recovery". The optimistic reconcile (`reconcileWithHostIds`) and
  `sendRejected` draft restore match the "Optimistic Reconciliation" +
  "Optimistic user message overlay" clauses.
- The module-level stable-cache pattern (H4/H21) is a webview-local
  "protocol-sync bookkeeping" concern and is allowed, but the HMR-survival + the
  incomplete coverage of `availableModels` are concrete defects within an
  allowed category.

## Smaller nits

- `composer/use-token-rate.ts:24` — `useTokenRateIndicator` has the `use` prefix
  but contains zero hook calls (pure lookup). Misleading naming per the
  STATE_CONTRACT note that token-rate now runs host-side; rename or document.
- `composer/model-list.ts` — dead `index` field on model entries.
- `composer/affordances.ts:13` — redundant `candidate.closest!(...)` non-null
  assertion; `resolveClosestCapableTarget` already returns a non-optional
  `closest`.
- `settings-menu-subcomponents.tsx:110,136,160` — double casts
  `(e.target as HTMLSelectElement).value as PruningMode` / `as ThinkingLevel`
  with no runtime validation that the string is a valid union member.
- `session-tabs/drag-state.ts:118-120` — `runCommitDrag` `onMove` param narrower
  than the option type `(sessionPath: string | undefined, …)`; bivariance hides
  that the host expects `undefined` handling (commit path never passes
  undefined — type friction only).
- `session-tabs/types.ts` / `context-menu.ts` / `index.tsx:201` —
  `{ x: number; y: number; tabPath: string }` literal duplicated across three
  sites; should be a single named type.
- `use-drag-and-drop.ts:60-61,120-150` — render-time ref writes
  (`openTabPathsRef.current = …`, `pointerMoveHandlerRef.current = …`). Standard
  "latest ref" pattern but technically render side-effects; an early `return`
  above those assignments (none currently) would leave stale handlers.
- `context-menu.ts:24-37` — global `mousedown`+`keydown` listeners + per-click
  `document.querySelector('.session-tab-context-menu')` while menu open; heavier
  than scoping to a menu ref. `index.tsx:286` `onMouseDown stopPropagation` makes
  the document "inside menu" guard redundant double-protection.

- `use-app-handlers.ts:228-258` — returns a fresh object literal each render;
  callbacks stable but the bag is not. Harmless only because consumers aren't
  memoized.
- `file-changes-panel.tsx:282-305` — unmount/pin-clear/hasNewChanges effects
  mutate timers/state with implicit ordering.
- `app-body.tsx:106-115` `isAskUserHandledInline` memo depends on `transcript`
  (fresh ref each snapshot) so `transcript.some()` runs ~7/sec; acknowledged in
  comment but recurring O(n) per snapshot.
- `PanelMain`/`BottomSection` (`app-body.tsx:128-330`) are plain function
  components, not memoized; `AppBody` re-renders both fully each snapshot.
- `composer/hooks.ts:208-216` debounce-post effect deps include `postMessage`
  (a prop) — if parent doesn't memoize it, the effect tears down/rebuilds the
  timeout every parent render. Worth verifying caller stability.
- `extension-ui-prompt.tsx` — three near-duplicate prompt components repeat the
  same focus-on-mount + countdown-cancel-on-zero + container-scoped
  Escape/Enter pattern; unify.
- `run-outcome-dialog.tsx:30-65,67-103` — focus-trap effect `[]` deps + keydown
  effect re-binding on every `resolution`/`satisfaction` change; acceptable but
  worth a comment.
- `context-window/breakdown.ts:284` uses `contextUsage?.tokens ?? null` while
  `indicator.ts` uses `usedTokens !== null` checks — minor null-handling drift.
- `utils/lru-cache.ts` Map-backed LRU is fine; flag for an eventual eviction
  upper-bound audit if caches grow.
- `session-tabs/drag-and-drop/effects.ts:13-19` — mount-once cleanup that
  re-registers if `endTracking` changes identity; semantically odd but harmless.
