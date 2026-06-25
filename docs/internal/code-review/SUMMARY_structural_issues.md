# Codebase Review — Structural Issues (Synthesis)

Reviewer: senior-engineer pass. Method: 8 parallel read-only `scout` agents, each owning a
directory subtree, wrote detailed findings to `docs/internal/code-review/01_*.md` … `09_*.md`. This
document is the synthesis: cross-cutting *structural* issues (not exhaustive bug lists)
derived from those reports. Each issue cites the scout report(s) that surfaced it and the
primary file:line references.

The raw scout reports (1.8k lines total) are the evidence base; this is the index of
themes that recur across them and matter most.

> Severity here is **structural impact**, not single-bug severity. "Critical" = a defect
> that is silently wrong today, or a hazard guaranteed to bite on the next routine change.
> "High" = a real maintenance/perf/correctness risk that should be addressed soon.

---

## S1 — Multiple sources of truth for the same contract, with no compile-time coupling  *(Critical)*

The single most pervasive structural problem: the same concept is defined in N places that
must be hand-kept in sync, and they have already drifted.

| Concept | Copies | Already drifted? |
|---|---|---|
| Thinking-level enum | `backend/rpc.ts:77`, `protocol-validation.ts:69` & `:189`, webview `settings-menu-helpers.ts:14-19` vs `toolbar.tsx:14-20` | **Yes** — `xhigh` exists in toolbar picker but not the settings picker; `VALID_PRUNING_MODES` omits `'custom'` that the type permits (`01`) |
| Protocol validator vs union | `protocol/webview.ts` defines `setFileChangesExpanded`; `protocol-validation.ts validateWebviewToHostMessage` has no case for it | **Yes** — falls through to `fail('unknown message type')`, exactly the drift the validator exists to catch (`01`) |
| Pricing logic | `extensions/subagent/pricing.ts` (270), `extension/src/backend/pricing.ts` (~150, CommonJS), `analysis/scripts/pricing.ts` (159) | **Yes** — already diverged in module style; comment says "Keep synchronized" (`08`, `09`) |
| Coercion / failure-kind taxonomy | `run-analytics/coercion-rollups.ts` header says "thin duplicate of `analysis/scripts/source.ts`, Keep synchronized" (~400 LOC) | Not yet, but unguarded (`04`, `09` H1) |
| Pruning-summary math ("kept X/Y") | `projection.ts:88-95`, `pruning.ts:81-96`, `pruning-header.tsx:38-46`, `pruning-inline.tsx:46-56`, `pruning-banner.tsx:75-82` (5 sites) | No shared module (`06`) |
| `CONFIG_ROOT` repo-root resolution | `skill-pruner/config.ts:6`, `logger.ts:8`, `skill-pruner/src/state.ts:54`, `subagent/src/execute.ts:26` (different relative climbs) | Latent — moving a file silently reads the wrong config (`08`) |
| `MAX_DEPTH` default | `subagent/src/helpers.ts:10` vs `runner.ts:137` `DEFAULT_MAX_DEPTH` | Tests assert they match; two sources of truth (`08`) |
| Checkpoint parse/read helpers | `stats-service/helpers.ts` & `run-analytics/query.ts` (`parseCheckpoint`); `readOptionalText` ×3 | (`04`) |
| Path utilities | `tool-call-summary.ts:38-103` vs `file-path.tsx:11-119` (byte-identical bodies) | (`05`) |
| Token formatting | `Intl.NumberFormat` re-instantiated in 5+ files | (`05`, `06`) |
| `BackendEvent`/`HostEvent` sub-unions | Defined in `events.ts` but the top `Event` union flattens them; the labels are documentation, not constraints | Category labels are wrong (SessionOpened is host-built, not wire) (`02` M2) |

**Why this is the headline structural issue:** every one of these is a place where the type
system was *available* to enforce the contract (a single enum, a shared module, a
discriminated union) and the code instead chose duplication with a comment. They are
guaranteed to drift on the next edit, and several already have. This is the recurring
anti-pattern across the whole codebase.

---

## S2 — God modules and oversized files concentrated in the hot paths  *(High)*

Oversize is not uniformly distributed; it clusters in the files that change most often.

| File | LOC | Concern |
|---|---|---|
| `analysis/site/app.ts` | **4,467** | entire dashboard in one browser-bundle entry; no test covers it directly (`09` M1) |
| `extension/src/host/core/effect-runner.ts` | 843 | `run()` is a ~430-line method with ~30 copy-pasted `try/catch` blocks, one per effect kind (`02` H2) |
| `extension/src/webview/panel/transcript/tool-call-card.tsx` | 822 | shell tokenizer + summary model + `TerminalOutput` + `ToolCallBody` + 5-state lifecycle (`06`) |
| `analysis/scripts/source.ts` | 1,075 | includes the duplicated coercion block (`09`) |
| `analysis/scripts/duckdb.ts` | 961 | schema + query registry (`09`) |
| `analysis/scripts/contracts.ts` | 940 | (`09`) |
| `extension/src/host/core/message-router.ts` | 663 | cohesive but leaks past the reducer (see S4) (`02` H3) |
| `extension/src/webview/panel/app-body.tsx` | 656 | `useAppBodyDerivedState` + `PanelMain` + `BottomSection` + 130-line CSS-vars effect (`05`, `06`) |
| `extension/src/host/core/events.ts` | 610 | type file; categorization muddy (`02` M2) |
| `extensions/subagent/src/modes.ts` | 654 | chain/parallel/single modes with positional 11-arg tuples (`08`) |
| `extension/src/webview/panel/transcript/use-transcript-scroll.ts` | 668 | hooks with 17/14/10 positional params (`06`) |
| `extension/src/host/core/reducer/session-handlers.ts` | 638 | `handleSessionScopeCleared` 115 lines / 18 discard-destructures (`02` C1, M1) |
| `extensions/subagent/runner.ts` | 550 | SDK surface hand-re-declared as `any` (`08`) |
| `extension/src/host/stats-service/tracker.ts` | 576 | `SessionRunTracker` flat event→mutation switchboard, ~20 handlers (`04` H5) |
| `extensions/subagent/src/execute.ts` | 519 | (`08`) |
| `extension/src/webview/panel/transcript/tool-call-item.tsx` | 550 | registry dispatch *and* subagent renderer mixed (`06`) |
| `extension/src/webview/panel/styles/transcript.css` | 1,133 | ~10 concerns, 6 orphaned selectors (`06`) |
| `extension/src/webview/panel/styles/composer.css` | 1,009 | duplicate `.context-window-indicator-anchor` (`06`) |

Two structural sub-points:
- **The reducer split is mostly right** (`command-*-handlers` by domain) **except**
  `command-misc-handlers.ts`, which holds the two most critical handlers (`handleSend`,
  `handleEdit`) behind a "misc" name (`02` M5).
- **The host service layer is *not* redundant** — `stats-service` (write side) and
  `run-analytics` (read side) are two halves of one analytics pipeline sharing one schema
  with a strictly one-directional dependency. The problem is internal duplication, not
  redundancy (`04` finding #4).

---

## S3 — Silent error swallowing and non-atomic persistence  *(High)*

Three independent failure modes that each make data loss invisible:

1. **Analytics persistence queue drops errors and still advances the sequence.**
   `stats-service/storage.ts:94-122` chains `.catch(() => undefined)` so any
   `fs.mkdir`/`appendFile`/`writeCheckpoint` failure is discarded, while `++this.seq`
   increments regardless — the checkpoint sequence advances past never-written snapshots,
   and no tracker method ever propagates a write failure (`04` Critical #1).

2. **Checkpoint writes are non-atomic with no rollback.**
   `stats-service/persistence.ts:38-48` does two sequential `fs.writeFile` (slot, then
   pointer) with no try/catch, no temp+rename. A failure mid-pair leaves an orphaned slot
   with no pointer; recoverable via higher-seq fallback but never rolled back (`04`
   Critical #2). `run-analytics/query.ts:184-185` `exportRunAnalyticsStore` writes
   non-atomically too.

3. **Schema versioning is exact-match-or-drop with no migration path.**
   `parseCheckpoint` returns `null` when `schemaVersion !== RUN_ANALYTICS_SCHEMA_VERSION`
   (`stats-service/helpers.ts:79-122`, `run-analytics/query.ts:48-79`); corrupt JSONL lines
   are silently skipped. There is a *legacy-format* migration but no *versioned* migration —
   the next schema bump silently discards all existing user data (`04` High #13).

4. **All backend errors collapse to one code.** `server-io.ts:12-17` returns
   `{ code: 'BACKEND_ERROR' }` for every failure; the structured `error.code` envelope field
   is never populated per-failure, so the client can't distinguish invalid-params from
   streaming-busy from model-unavailable (`01` Medium).

5. **Fire-and-forget persistence with swallowed rejections.** `session-service/service.ts:213-218`
   `setPrefs` does `void globalState.update(...)` (no `.catch`) and `void
   backend.request(...).catch(() => {})`; `startup.ts:99-107` fires four uncaught
   `globalState.update`s (`04` Medium #15). `handleMessageInterrupt` returns
   `{interrupted:true}` optimistically regardless of abort success (`01` nits).

These compound: a future schema bump OR a persistent disk failure can silently lose all user
analytics with no signal anywhere.

---

## S4 — Leaky abstractions at the CQRS boundaries  *(High)*

The architecture is a clean CQRS spine (`dispatch → reducer (pure) → Effect[] → EffectRunner
(only side-effect site) → *Result → reducer`), and the `never`-exhaustiveness pattern is
consistently applied. The leaks are at the *callback boundaries*, not the spine:

1. **`message-router.ts` reaches past the reducer.** `onRevertFile` (`:558-566`) dispatches a
   `RevertFile` Command **and** a `FileChangeRemoved` Event directly, then calls
   `scheduleRender()` manually — the `FileRevertResult` reducer handler is a no-op, so
   file-change removal lives in the router, not the reducer/runner. Render triggering is
   inconsistent: some handlers call `scheduleRender()`, most call
   `sidebarProvider.postState()` — a different codepath with no documented rule (`02` H3).

2. **`EffectRunner` re-enters the reducer via three channels.** `EffectRunnerDeps` exposes
   `dispatch` (Result), `dispatchCommand`, and `dispatchEvent`. The runner uses
   `dispatchCommand` for queue re-dispatch and `dispatchEvent` for the watchdog. So the
   "thin side-effect executor" is actually a second dispatcher that can re-enter the reducer
   with any event kind, with re-entrancy ordering managed only by `void (async()=>…)` IIFEs
   and no guard against synchronous re-entry mid-loop (`02` M7).

3. **The router's `SidebarProviderLike.postImperative(msg: any)`** widens back to `any` the
   exact type the `PostImperativeEffect` machinery was tightened to enforce (`02` H4). Same
   pattern at `transcript-host.tsx:115` `postMessage: (msg: any) => void` (`06`) and
   `panel.tsx:60-78` error-overlay `any` casts (`06`).

4. **`extension_ui.response` backend handler bypasses the RPC validation layer.**
   `request-handler.ts:371-389` uses a raw `as` cast + ad-hoc checks; every other handler
   delegates to a `validate*` function in `rpc.ts` (`01` High). Validation is split across
   two files and two styles.

5. **`handleSessionTruncateAfter` bypasses the SDK.** `request-handler.ts:173-204` does raw
   `fs.readFile`/`fs.writeFile` + hand-rolled JSONL parsing, duplicating the SDK's session
   format with no concurrency guard or atomicity (`01` High).

**Structural read:** the spine is genuinely sound (pure reducer, single side-effect site,
exhaustiveness). The fragility is concentrated where the impure layers *call back into* the
spine — that seam needs to be one-way and typed, and it currently is neither.

---

## S5 — Re-render hot path: memoization defeated by fresh refs every snapshot  *(High)*

During streaming the host posts a fresh `ViewState` ~7/sec, and the new `transcript` /
`ViewState` ref pierces every memo:

- `ui.tsx:266` `Composer = memo(ComposerView)` is fed `transcript={viewState.transcript}`
  (fresh ref every snapshot) + inline object props → the memo is near-useless (`05` H1, `06`).
- `app-body.tsx:218-248` `PanelMain` and `BottomSection` are plain (un-memoized) function
  components → the whole panel subtree re-renders on every streaming delta (`06`).
- `virtual-list.tsx:195-260` `VirtualRow` is not memoized and receives a large prop bag
  whose identities change every snapshot (`06`).
- `use-composer-indicators.ts:40-49,87` memo chain recomputes every snapshot because
  `availableModels` is a fresh structured-cloned ref each snapshot —
  `use-host-sync.ts` stabilizes `prefs`/`pruningSettings`/`pruningCatalog` but **not**
  `availableModels`. The comment at line 87 directly contradicts the actual dependency
  (`05` H3, H21).
- `use-host-sync.ts:30-33` module-level mutable stable caches (`stablePrefs` etc.) survive
  HMR — a new view instance can receive a stale ref handoff in development (`05` H4).
- SessionTabs: every `DropGap` receives the same `dropIndex` prop, so all N+1 re-render on
  drag (the comment claiming otherwise is wrong); `activeRunSummary` passed to all tabs
  (`05` H7, H8).

This is the **single biggest perf issue in the webview** and the highest-leverage fix:
stabilize `availableModels` in `use-host-sync`, memoize the render boundary (`VirtualRow`,
`PanelMain`, `BottomSection`), and fix `Composer`'s `transcript` prop identity.

---

## S6 — Type unsafety concentrated exactly where it matters most  *(High)*

The type system is used well inside pure modules and abandoned at every inter-process /
inter-context boundary — the boundaries most likely to break on version skew:

- **Backend stdio boundary:** `backend/client.ts:230` `JSON.parse(line)`;
  `attach.ts:284,287` `handleBackendEvent: (event: any)`. Envelope shape is checked; payload
  is cast unchecked into the event-handler chain (`04` Critical #3).
- **Runtime factory:** `runtime-factory.ts:10` factory callback typed `any`, results cast
  `as Record<string, unknown>`; `authStorage: unknown` end-to-end through the backend — the
  SDK pluggable hook has zero static checking (`01` Medium).
- **`session-event-handler.ts:261`** `event.message as any` on the hot assistant path (`01`).
- **Subagent render/session:** `render.ts` `Theme/Ctx/RenderResult = any`,
  `renderSubagentCall(args: any)`; `runner.ts` erases SDK event/Message types to `any` and
  hand-re-declares the SDK surface as a local `SubagentSdk` interface — drift is uncaught at
  compile time (`08` #7).
- **Registry:** `virtual-list-row.tsx:9` `return renderer(props) as any` defeats return-type
  checking of all registered renderers; `registry.ts` uses bare `string` keys (no union),
  silent override with no diagnostic (`06`).
- **Double-casts:** `session-metadata.ts:172` `as unknown as`; tool-call renderers
  `e as unknown as MouseEvent` ×5 (`06`); `command-composer-handlers.ts:9`
  `{...cmd.input, id} as ComposerInput` bypasses the draft/materialized union distinction
  (`02` H5).
- **Subagent details:** `file-change-derivation.ts:222` `result.details as SubagentDetails |
  undefined` unchecked; locally-defined interfaces mirror the pi-ai protocol by hand (`02`
  M10).
- **Coercion:** `coercion-snapshots.ts:164` `const c = candidate as RunSnapshot` after a
  partial predicate — any field added to `RunSnapshot` without a matching `validateX`
  becomes silently unvalidated on read (`04` High #7).

**Structural shape:** "validate at the boundary, trust the type inside" is the right
pattern, but the boundary validators are shallow/incomplete (envelope shape only) and the
internal types then *lie* about what was actually validated. The `any` leaks are not random
— they form a ring around every process/context seam.

---

## S7 — Stale documentation contradicting the authoritative contract  *(High)*

Documentation drift is extensive and lands on the onboarding entry points:

- **`docs/internal/ARCH-OVERVIEW.md` is wrong on the load-bearing contract.** It describes a
  `Patch{sessionPath, ops}` per-session-revision transport; `STATE_CONTRACT.md` (the
  authoritative doc) and `ARCHITECTURE.md §3` both say snapshots-only. It references a
  non-existent `backend-event-parser.ts` and lists the wrong file as the ArchState source
  (`09` H3).
- **`docs/ARCHITECTURE.md`** names `backend-client.ts` (real: `host/backend/client.ts`),
  points to `extension-host.ts` for webview→Command conversion (real: `message-router.ts`),
  uses `Notification` effect namespace (real: `PostImperative`), omits the `ask-user`
  extension (`09` H2).
- **`extensions/subagent/README.md:60-78`** documents a `taskScores` input field and
  score-based model override that **does not exist** in the subagent extension (zero refs in
  `extensions/subagent/`); the field only lives in the *host* extension, which reads it
  independently. Users will pass it expecting behavior the extension silently drops (`08`
  Critical #1).
- **`transcript-host.tsx:1-6`** describes a per-tab-mounting / virtualizer-preservation design
  that the implementation does not have — it renders only the active surface (`06` High).
- **`docs/EXPANDED-SECTION-UI-PLAN.md`** marked "Not yet implemented" but is implemented
  (`09` H4).
- **`docs/INSTALLATION_INFRA_PLAN.md`** referenced from `package.json:4`, `install.sh:13,160`
  but does not exist (`09` C4).
- **Dead skill instructions:** `skills/diagnose/SKILL.md:29` refs nonexistent
  `scripts/hitl-loop.template.sh`; `:117` refs nonexistent `improve-codebase-architecture`
  skill (`09` C3). `grill-with-docs/DOC-FORMAT.md` cites nonexistent example files (`09` M9).
- **`docs/internal/copilot-model-pricing.md`** self-superseded, lists models not in the
  current ledger (`09` M3).
- **`analysis/README.md`** silent on the stratified leaderboard and complexity scoring —
  half the pipeline (`09` M2).

`docs/STATE_CONTRACT.md` was verified consistent with code (`09`) — it is the one doc that's
right. The others drift from it.

---

## S8 — Refactor-hostile test architecture  *(Medium-High)*

The pure-logic core is genuinely well-tested as **behavior** with deterministic fake
timers. The weaknesses are structural (`07`):

1. **Source-text / regex structural tests pin implementation text, not behavior.** ~19 test
   files `readFileSync` source and assert on it: `webview-style-contract.test.ts` asserts
   regexes against CSS/TSX *source*; `arch-boundary-guards.test.ts` regex-scans for
   `Date.now()`/`new Date()`/import strings; `tool-call-heading-css.test.ts` asserts on
   rendered Tailwind class strings. A formatter pass or var rename trips red with zero
   behavior change — trains the team to ignore failures (`07` H2).
2. **UI tests assert rendered HTML strings, not DOM behavior.** 14 files use
   `preact-render-to-string` + `assert.match` (`webview-render.test.ts` alone has 150
   matches). `@testing-library/preact` is a devDep used by **0** files. Click/focus/keyboard
   interactions are effectively untested (`07` H3).
3. **No dedicated test for `message-router.ts`** — the riskiest impure-plumbing layer (SDK
   event → arch Event translation, ordering, error paths) has only incidental coverage
   (`07` H1).
4. **`EffectRunnerDeps` mocks hand-built with `as any` in 7 files** — the type checker can't
   catch drift, so a new required method compiles fine while silently missing it (`07` M1).
5. **Transcript virtualization has no real behavior coverage** — the perf harness admits
   happy-dom has no layout engine, so virtualization regressions that only manifest with
   real layout slip through (`07` M2).
6. **41 files import `core/*` internals directly** — tests are coupled to module layout, so
   moving a handler between files breaks dozens of imports even when behavior is identical
   (`07` M3).

The test suite's *strength* (pure-core behavior tests) and *weakness* (UI/plumbing layer)
are inversely correlated with where the codebase is most fragile.

---

## S9 — Cross-tree coupling that defeats package boundaries  *(Medium)*

Several pi extensions/import sites reach across package/tree boundaries into another
package's internal `src/` rather than a published/shared surface:

- **`extensions/ask-user/src/types.ts:1`** imports `CUSTOM_SENTINEL` from
  `../../../extension/src/shared/ask-user-sentinel.js` — an extension imports the host VS Code
  extension's internal source (`08` #9).
- **`extensions/subagent/bridge.ts:18-29`** does
  `await import("../../analysis/scripts/stratified-ranker.js")` — an extension depends on
  repo-local analytics scripts (not a package); failure is fail-open via swallowed catch,
  masking a broken contract (`08` #3).
- **Pricing duplicated across 3 packages** (subagent, backend, analysis) instead of a shared
  module (`08` #2).
- **Bidirectional `src/` ↔ top-level imports in `subagent` and `skill-pruner`** — the `src/`
  layer boundary is decorative; `runner.ts` imports down into `./src/...` while
  `src/execute.ts` imports up to top-level. `ask-user`, `cwd-skills`, `safeguard` each use a
  different convention; there is no documented rule for what lives where (`08` #6).
- **`ParentExtensionUIBridgeProxy` implements ~20 no-op TUI methods** to satisfy the full
  `ExtensionUIContext` interface when subagents only need 5 — an interface-segregation smell
  where any new TUI method silently becomes a no-op instead of a compile error (`08` #8).

The extensions layer is the area with the least consistent internal structure.

---

## S10 — Left-in-tree destructive one-shot codemods & install-script hazards  *(Medium)*

- **`scripts/split-protocol.mjs:156-159`** overwrites `protocol.ts` with a 1-line barrel on
  every run, no backup, no idempotency — a missed export is silently dropped and the original
  is gone (only VCS recovers) (`09` C1).
- **`scripts/replace-isrecord.mjs:34-50`** brace-counts without ignoring braces in
  strings/regex/template/comments — silent source corruption on edge cases (`09` C2).
- **`scripts/extract-reducer-handlers.mjs`** uses whitespace-sensitive `src.includes(block)`
  and prints "Done" even when it no-ops; all three codemods are CWD-relative with no
  `repoRoot` resolution (`09` H8). All three are dated one-shots with no archival marker
  (`09` L6).
- **`install.sh` vs `install.ps1` feature asymmetry** — Linux/macOS get an incomplete install
  (no session migration, no settings patch, no extension build) vs Windows (`09` H5).
- **`install.sh:108-109`** uses `shasum` (BSD/macOS-only) with no `sha256sum` fallback; under
  `set -euo pipefail` the auth-relocation aborts mid-flight on Linux (`09` H6).
- **`install.ps1`** reports the entire extension-build+vsix block as a `Write-Warning`, so
  the script exits 0 even when the extension the user wants failed to install (`09` H7).
  Settings.json rewrite via JSON round-trip loses key order/formatting (`09` M4); VS Code
  path probe only checks the User install (`09` M5); ACL applied after source deletion (`09`
  M6).

---

## S11 — Notable non-issues (verified, to avoid re-litigating)

The scout reports corrected several reasonable-but-wrong suspicions:

- **`analysis/site/dist/app.js` (2 MB) + `.map` (4.8 MB) + `data/*.json` are NOT tracked** —
  properly gitignored (`.gitignore:37,67`). (`09`)
- **`auth.json` is NOT tracked** — gitignored (`.gitignore:2`). (`09`)
- **`models.json` + `model-profiles.yaml` are complementary, not duplicated** — yaml carries
  eligibility/thinking-level/fallback-cost; json is the pricing authority. (`09` L1)
- **`stats-service` vs `run-analytics` are NOT redundant** — write/read halves of one
  pipeline, strictly one-directional dependency, no cycles. The real problem is internal
  helper duplication (S1), not architectural redundancy. (`04`)
- **Backend-vs-webview *pruning-logic* duplication is mostly false** — actual skill pruning
  lives in `extensions/skill-pruner/`; message compaction is done upstream by the SDK; the
  webview only *displays* payloads. The real duplication is pruning-**summary math** (S1).
  (`06`)
- **`stratified-ranker.ts`/`leaderboard.ts` are NOT oversized** — 458/424 LOC, well-factored.
  The real oversize is `app.ts` 4,467 + `source.ts` 1,075 + `duckdb.ts` 961. (`09`)
- **SQL queries have no correctness bugs** — all referenced columns/tables/views exist;
  `model_leaderboard.sql` correctly defers the composite to TS. (`09`)
- **`TODO.md` is large (260 LOC) but current** — latest commit 2026-06-25, not aged. (`09` L2)
- **The reducer spine is genuinely pure** with consistent `never`-exhaustiveness; the
  mutate-without-emit hazard is structurally prevented (session-service holds no ArchState).
  (`02`, `04`)

---

## Recommended structural work, ordered by leverage

1. **Stabilize `availableModels` + memoize the render boundary** (`VirtualRow`, `PanelMain`,
   `BottomSection`, fix `Composer`'s `transcript` prop). Highest perf leverage, smallest
   blast radius. (S5)
2. **Consolidate the duplicated contracts into shared modules with compile-time coupling:**
   thinking-level enum, pricing, coercion taxonomy, checkpoint parse/read helpers, path
   utils, token formatting, pruning-summary math. Each is a small, self-contained win that
   removes a guaranteed-future-drift hazard. (S1)
3. **Decompose `EffectRunner.run()`** into a dispatch table mapping kind → (dep call, result
   kind, extra fields) + a single wrapper; remove the dead `SendRpc`/`EditRpc` switch arms.
   (S2, `02` H1/H2)
4. **Tighten the boundary typing ring:** validate backend RPC payloads at the stdio seam;
   re-rout `extension_ui.response` through `rpc.ts` validation; replace `runtime-factory`'s
   `any` and `authStorage: unknown`; stop hand-re-declaring the SDK surface in `runner.ts`.
   (S6)
5. **Fix silent error swallowing:** surface analytics persistence failures (and stop
   incrementing seq on failure); make checkpoint writes atomic (temp+rename); define a
   versioned migration path before the next schema bump. (S3)
6. **Reconcile docs with `STATE_CONTRACT.md`** (ARCH-OVERVIEW transport model,
   ARCHITECTURE file refs + effect namespace + missing `ask-user`, subagent README
   `taskScores`, `transcript-host.tsx` comment, EXPANDED-SECTION status, missing
   INSTALLATION_INFRA_PLAN). (S7)
7. **Replace source-text/regex structural tests with behavior tests**; add a dedicated
   `message-router` test; centralize `EffectRunnerDeps` mocks behind a typed factory. (S8)
8. **Extract `evictSession(state, sp, {removeSummary, removeTabs})`** to collapse the two
   drifted eviction paths (and fix the `expandedBySession` leak on tab close). (S1, `02` C1)
9. **Archive/delete the one-shot codemods** and fix `install.sh` Linux/portability + the
   `install.ps1` silent-failure reporting. (S10)

---

## Source reports

- `01_backend_shared.md` — backend + shared/protocol
- `02_host_core.md` — host/core incl reducer/
- `04_host_services.md` — session-service, stats-service, run-analytics, sidebar
- `05_webview_composer_tabs.md` — panel composer/tabs/utils
- `06_webview_transcript.md` — transcript rendering + CSS
- `07_extension_tests.md` — extension/test suite
- `08_extensions.md` — extensions/ (ask-user, cwd-skills, safeguard, skill-pruner, subagent)
- `09_analysis_docs_config.md` — analysis/, scripts/, docs/, skills/, root config