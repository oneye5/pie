# Handoff — UX & Reliability Remediation, remaining work

> A previous agent executed `docs/UX_RELIABILITY_PLAN.md` through all 4 rounds
> (Briefs A–H). All 8 briefs are implemented, reviewer-gated, and committed.
> This handoff covers the **non-blocking follow-ups + the manual smoke-test**
> that remain. The codebase is green: `cd extension && npm run typecheck` clean,
> `npm run test` 1683 pass / 0 fail, `npm run build` syncs to the installed
> extension. Branch `master`.

## 1. What's already done (read these first, don't redo)

- **Plan**: `docs/UX_RELIABILITY_PLAN.md` (§1 dep graph, §3–§10 the briefs, §11
  cross-cutting invariants, §12 done-definition).
- **Authoritative contract**: `docs/STATE_CONTRACT.md` — esp. "Optimistic
  Reconciliation" (incl. the "Two failure windows for send" + "Timer ownership"
  subsections, now **implemented**), "Reducer Purity", "Snapshot Recovery",
  "Webview-Local State" (the allowlist).
- **Terminology**: `AGENTS.md` § Terminology (`prepass` = the pruning LLM call,
  user-facing; `preflight` = the SDK `before_agent_start` gate, host-internal).
- **4 commits** (newest first):
  - `a2575a9` Round 4 — Brief F (prepass UX chip) + Brief H (error messaging)
  - `135cb52` Round 3 — Brief E (edit/interrupt UX) + Brief D (stale-state fix)
  - `3222af9` Round 2 — Brief B (timeout/correlation/cancel) + Brief C (composer-input lifecycle)
  - `5d8b964` Round 1 — Brief A (decouple message.send from prepass) + Brief G (projection memoization)
- **Deferred follow-ups already logged** in `TODO.md` under
  "In-repo deferred follow-ups (Brief F/H, non-blocking)" + "Cross-repo
  follow-up". Read that section — it's the authoritative list (this doc
  expands it with file:line refs + the smoke-test).

The canonical `Failed to send message: Timed out waiting for response to req-NN`
error is eliminated (Brief A early-ack + Brief H `stripReqIds`).

## 2. Remaining work — three buckets

### Bucket 1 — Brief H finishing (in-repo, mechanical-to-moderate)

The pure error mapper, `ViewState.noticeKind` (projected), the `NoticeBanner`
component, and the 4 webview→host action handlers all exist, but the action
**buttons never render** (notices already name the action in prose → Nielsen #9
is met today). Wiring the buttons is the main remaining H item.

1. **Wire `NoticeBanner` action buttons** — `extension/src/webview/panel/app-body.tsx:615`
   renders `<NoticeBanner notice={viewState.notice} onDismiss={...} />` WITHOUT
   `kind`/`onAction`. Add `kind={viewState.noticeKind}` + an `onAction` handler
   that `postMessage`s the matching `WebviewToHostMessage`. The host handlers
   already exist and are routed in `extension/src/host/core/message-router.ts`
   (lines 194–203 dispatch; 674 `onShowLogs`, 682 `onOpenSettings`,
   698 `onRestartBackend`, 708 `onRetrySend`). Map `NoticeAction → message type`:
   `retry`/`retry-without-pruning` → `retrySend` (with `disablePruning: true` for
   the latter), `show-logs` → `showLogs`, `open-settings` → `openSettings`,
   `restart-backend` → `restartBackend`. Decide dismiss behavior per action
   (Retry dismisses; Show logs / Open settings do not). Add a webview test
   (app-smoke pattern) asserting buttons render + a click posts the right
   message.
2. **`disablePruning` never restores the prior mode** —
   `extension/src/host/core/message-router.ts:708` (`onRetrySend`) sets
   `mode:'off'` and never restores. There's a `TODO(Brief H follow-up)` comment
   at line 710. Fix: capture the prior pruning mode before disabling, restore it
   after the retry send commits (the send's `MessageFinished`/commit point).
   This becomes user-facing once (1) lands.
3. **`PREPASS_TIMEOUT_PATTERN` rejects decimal-second budgets** —
   `extension/src/shared/error-mapping.ts:84`: `\((\d+)s\)$` won't match e.g.
   `12.5s` → misclassifies as `prepass-failed`. Change to
   `\((\d+(?:\.\d+)?)s\)$`. Add a unit test.
4. **`onShowLogs` opens an empty `pie` OutputChannel** —
   `extension/src/host/core/message-router.ts:674` creates a fresh channel but
   `bootLog` writes to `console.warn` (`audit.ts`), not the channel. Either
   route boot logs to the channel, or point `showLogs` at the existing log
   surface. Low priority (dormant until (1) lands).

### Bucket 2 — Test coverage gaps (reviewer-noted, lock in the logic)

1. **Brief F host-side `succeeded`/`idle` transition tests** —
   `extension/test/arch-reducer.test.ts:1926` has the `running→failed` test +
   projected `prepassPhase`. Add: `running→succeeded` (a pruning-result
   `CustomMessage` → `pending.prepassBySession[sp].phase === 'succeeded'`;
   see `ui-handlers.ts` `handleCustomMessage` ~line 17–34) and
   `running→idle` (commit-point `MessageStarted` clears `prepassBySession[sp]`;
   see `streaming-handlers.ts:67`; mirror the transcript/window setup in the
   existing `commit-point first MessageStarted drops the promoted snapshot`
   test). Assert the projected `prepassPhase` each step.
2. **Brief D `resnapshot bumps revision` lock-in test** — the revision guard
   (`use-host-sync.ts`) discards `revision <= lastRevisionRef`. The watchdog's
   resnapshot self-heals only because `buildStateEnvelope` (`sync.ts`) always
   does `globalRevision + 1`. Add a test in
   `extension/test/sidebar-sync.test.ts` (or `state-applied-watchdog.test.ts`)
   asserting a resnapshot (`onResnapshot` → `flushDirtyState`) produces a
   strictly-higher revision, so a future change that re-posts the same revision
   doesn't silently break self-healing. (The existing `state-applied-watchdog.test.ts`
   uses `onResnapshot: () => undefined` + `getRunningSessionCount: () => 0` and
   doesn't exercise the resnapshot branch — extend it.)
3. **Brief D `missed-ack-while-streaming` end-to-end** — the revision-discard
   test (`extension/test/app-smoke.test.ts:532`) + host-change rebase (`:572`)
   cover the mechanism. Add an app-smoke test simulating a wedged webview
   (delayed acks) during streaming and asserting convergence without old+new
   overlap. If a full streaming-wedge harness is too heavy, document it as a
   §12 manual smoke-test item (see Bucket 3) — the mechanism is code-read-verified.

### Bucket 3 — §12 manual smoke-test matrix (plan step 4)

The plan's `§12 step 4` lists 7 manual scenarios. A previous agent **could not
drive the VS Code UI**, so these were not run live. Your job:

- **Automate what's automatable** via the `extension/test/app-smoke.test.ts`
  pattern (mount `App`, post `state`/imperative messages, assert DOM). Already
  covered there: paste-image clear/restore (Brief C), second-send rejection
  (Brief E), prepass chip render (Brief F), revision-discard (Brief D).
  Consider adding app-smoke tests for: edit no-truncate-flash (assert the
  optimistic edit message survives a mid-edit `session.opened` snapshot while
  `hostRunning`), and interrupt one-frame feedback (assert the `interrupting`
  flag renders "Stopping…" before the host round-trip).
- **The scenarios that need a real backend / human** (can't be app-smoke'd
  without a fake backend): send a turn with an **artificially slow prepass** →
  confirm no `req-NN` timeout + the live prepass chip + cancel works; **wedge
  the webview** (delay acks) during streaming → converges without old+new
  overlap; **force a backend stderr/parse failure** → actionable plain-language
  error, no `req-NN`. Write these as a **smoke-test checklist doc**
  (e.g. `docs/UX_RELIABILITY_SMOKE_TEST.md`) with exact repro steps + expected
  results, so a human can execute them. If feasible, build a fake-backend
  integration test harness to automate the slow-prepass + stderr cases.

## 3. Constraints & process

- **Preserve all `STATE_CONTRACT.md` invariants** (§11 of the plan): reducer
  purity (no `Date.now()`/I/O/randomness in the reducer — the error mapper +
  `prepassStartedAt` are pure; keep them so), optimistic reconciliation,
  execution ordering, snapshot recovery (the watchdog force-reload suppression
  while streaming is a **correct invariant — do not touch it**), the webview-
  local-state allowlist. Any relaxation must update the contract in the same
  change.
- **Always rebuild after editing `extension/src/`**: `cd extension && npm run
  build` (auto-syncs to the installed VS Code extension). Verify with
  `npm run typecheck && npm run test && npm run build` before considering work
  done.
- **Reviewer-gate** non-trivial changes with the `reviewer` subagent against
  the brief's acceptance criteria + the contract invariants.
- **Commit scoped changes only** — there are unrelated pre-existing local
  changes in `APPEND_SYSTEM.md` + `analysis/site/*`; do NOT commit those. One
  commit per logical unit (e.g. "wire NoticeBanner action buttons", "add F/D
  transition tests").
- **Subagent dispatch was abort-prone in the prior session** (5 `Request was
  aborted` failures on worker dispatches, ~50% rate). Prefer doing mechanical
  work directly; if delegating, run workers **sequentially** (parallel
  dispatches aborted together) and verify against a stable tree. If a worker
  aborts leaving partial work, assess it (typecheck + test) and salvage/
  complete it rather than discarding — three briefs were recovered this way.
- **Cross-repo (out of scope)**: the SDK `preflightStarted` event in
  `@earendil-works/pi-coding-agent` / `skill-pruner` would give Brief F's chip a
  precise start signal (today it's host-inferred at send dispatch). Coordinated
  PR to the other repo; not executable in-repo. Already in `TODO.md`.

## 4. Done-definition for this handoff

- Bucket 1 items 1–3 done (action buttons wired + tested; `disablePruning`
  restores; decimal-budget pattern fixed + tested). Item 4 optional.
- Bucket 2 tests added + green.
- Bucket 3: automatable scenarios have app-smoke tests; the rest are a
  written smoke-test checklist a human can execute.
- `cd extension && npm run typecheck && npm run test && npm run build` green.
- `reviewer` accepts the non-trivial changes.
- `TODO.md` follow-up entries closed as they land.
