# UX & Reliability Remediation Plan

> Orchestrator playbook for a wave of parallel/sequential subagents.
> Goal: eliminate the `Failed to send message: Timed out waiting for response to req-45`
> errors and fix the clunky editing/interrupting, stale-state ("old + new message at once"),
> pasted-image stickiness, pruning-prepass slowness, and general fragility — judged against
> **Nielsen's 10 Usability Heuristics**.

---

## 0. How to run this plan (orchestrator instructions)

This plan is a set of self-contained **task briefs**. Each brief is scoped so a single
`worker` subagent can execute it end-to-end with a `reviewer` gate afterwards. The
orchestrator should:

1. **Resolve the dependency graph first (§1).** Tasks A and B are root-cause fixes and
   unblock several others. Spawn them in the **first wave**.
2. **Run independent tasks in parallel.** Use `subagent` in `parallel` mode for briefs that
   touch disjoint file regions (see §1's waves).
3. **Gate each task with `reviewer`.** After every task, spawn `reviewer` to verify
   acceptance criteria, check for regressions against the `STATE_CONTRACT.md` invariants,
   and confirm the build passes (`cd extension && npm run typecheck && npm run test`).
4. **Rebuild after each wave.** `cd extension && npm run build` (build auto-syncs to the
   installed VS Code extension). Manually smoke-test the chat flow before the next wave.
5. **Update TODO.md.** Track each brief as a TODO entry; close it only when `reviewer`
   accepts. Do not commit unrelated local changes.
6. **Bucket hints** are specified per brief. Default `medium` (Sonnet-class); use `frontier`
   for the two architecturally invasive briefs (A, D) and `small` for isolated mechanical
   work.

The briefs deliberately **do not** prescribe exact line edits — workers read the cited files,
confirm current line numbers, and implement against the stated invariants. Each brief lists
**Files in scope** so parallel tasks don't collide.

---

## 1. Dependency graph & waves

```
Wave 1 (parallel, root causes):
  A  Decouple message.send RPC from the pruning prepass      [frontier]
  B  Request timeout strategy & correlation hardening        [frontier]

Wave 2 (parallel, depend on A/B outcomes):
  C  Optimistic lifecycle for composer inputs (image stick)   [medium]   depends on A
  F  Pruning prepass UX: visibility of system status          [medium]   depends on A
  E  Edit / interrupt UX clunkiness                           [medium]   depends on B
  G  Projection memoization & render-path perf                [medium]   independent

Wave 3 (parallel, stability):
  D  Stale-state / "old + new message at once"                [frontier] depends on G
  H  Error prevention, messaging & graceful degradation       [medium]   depends on B
```

Wave 1 is the critical path. A and B are `frontier` because they touch the host↔backend RPC
boundary and the effect-runner's two racing timers — the highest-blast-radius changes. C, E,
F all become simpler/safer once A and B land, so they wait for Wave 1's `reviewer` sign-off.

---

## 2. Nielsen heuristics → issue mapping

| Heuristic | Where it's violated today | Brief(s) |
|---|---|---|
| **#1 Visibility of system status** | No progress/cancelable indicator while the prepass runs; images silently stick; "Timed out…" error is the *only* feedback after 30s. | A, C, F, H |
| **#2 Match between system and real world** | Error string `Timed out waiting for response to req-45` leaks an internal RPC id. | H |
| **#3 User control & freedom** | Interrupt is serialized behind the send lifecycle queue; images can't be detached while prepass runs; no cancel for prepass. | E, A, C |
| **#4 Consistency & standards** | Two independent timers (30s `req-XX` + 60s optimistic-op TTL) race a single send → inconsistent rollback paths. | B, H |
| **#5 Error prevention** | `message.send` 30s default is too tight given it gates on the prepass; missed acks mid-stream never self-heal (watchdog reload suppressed while running). | A, B, D |
| **#6 Recognition rather than recall** | Edit/interrupt share a truncate-then-send pipeline; stale-snapshot hazards are invisible to the user. | E, D |
| **#7 Flexibility & efficiency** | Prepass slowness has no skip/bypass/short-circuit for small turns. | F |
| **#8 Aesthetic & minimalist design** | Pasted images linger as full attachment cards instead of compacting once accepted. | C |
| **#9 Recognize, diagnose, recover from errors** | One opaque timeout string; dropped stdout lines (`client.ts:240-260`) leave requests to time out with no cause. | H, B |
| **#10 Help & docs** | Settings expose `prepassTimeoutSec` but the user can't tell it's the cause of send latency. | F |

---

## 3. Brief A — Decouple `message.send` RPC from the pruning prepass  *(frontier)*

### Problem
`Failed to send message: Timed out waiting for response to req-45` is the canonical symptom.
The `message.send` JSON-RPC to the backend child process does not resolve until the SDK's
`before_agent_start` extensions (the **skill-pruner pruning prepass**) finish. That prepass
is an LLM call that can exceed the 30s default RPC timeout. When it does, `RequestTracker`
rejects `req-NN`, `runSendRpc` catches it and dispatches `SendResult{ok:false}`, and
`handleSendResult` shows `"Failed to send message: Timed out waiting for response to req-45"`.

### Root-cause map (verified)
- `extension/src/shared/request-tracker.ts:13-15` — fixed `setTimeout` rejects with
  `Timed out waiting for response to ${id}`.
- `extension/src/host/backend/client.ts:28` — `DEFAULT_RPC_TIMEOUT_MS = 30_000`;
  `message.send` is **absent** from `RPC_TIMEOUTS_MS` (`client.ts:34-46`), so it inherits
  the 30s default. `message.send` mints `req-${++requestCounter}` (`client.ts:192`).
- `extension/src/backend/request-handler.ts:215-249, 275-345` — `handleMessageSend` awaits
  `startPromptBackground`, whose `accepted` promise resolves inside
  `applyPreflightResult` — i.e. **after the prepass completes**. So the RPC reply is gated
  on the prepass.
- `extension/src/host/core/effect-runner.ts:525-547` (`startOptimisticOpTimer`) and
  `596-635` (`runSendRpc`) — `runSendRpc` catches the rejection → `SendResult{ok:false}`.
- `extension/src/host/core/reducer/result-handlers.ts:37-95` — `handleSendResult` turns the
  error into the notice and rolls back the optimistic message.

### Researched context
- **Optimistic UI for chat** (ai-tldr.dev, ably.com): the user message is trivially correct
  to echo optimistically; the model's answer is the only thing you must placeholder. The
  send RPC should *never* block the UI on the preflight — it should ack the **acceptance**
  of the prompt and let streaming carry the rest. Heuristic #1 (visibility) and #3 (control).
- **Request/response correlation** (VS Code webview docs, vscode-hexeditor DeepWiki): the
  standard pattern is to resolve the RPC as soon as the request is *accepted/queued*, then
  deliver results via a separate event stream. Our architecture already has the event
  stream (`MessageStarted`/`Delta`/`Finished`) — we just shouldn't also gate the RPC on
  preflight.

### Design direction (worker decides exact shape)
Make `message.send` resolve as soon as the prompt is **accepted** (queued into the SDK
session), **before** the preflight/prepass. The prepass then runs concurrently and surfaces
progress via the existing custom-event channel (`session-event-handler.ts:210-235` already
forwards prepass `message.custom` events). Options to evaluate (pick the least invasive that
preserves the `STATE_CONTRACT` invariants):

1. **Backend-side early ack:** `handleMessageSend` resolves `{requestId}` immediately after
   `session.prompt` is *called* (queued), and emits a `preflightStarted`/`preflightFinished`
   custom event for the prepass window. This is the cleanest and matches the event-stream
   pattern.
2. **Move `message.send` into `RPC_TIMEOUTS_MS` with a much larger budget** (e.g. 120s) as a
   *stopgap only* — does not fix the UX, just the false-positive timeout. Not acceptable as
   the sole fix; pair with (1).

The chosen approach **must** preserve:
- `STATE_CONTRACT.md` "Optimistic Reconciliation": `SendResult` success promotes pending →
  authoritative and finalizes the backend-assigned id. If the id is now assigned at queue
  time, ensure the correlation (`requestId → localId`) still works and that a prepass
  **failure** after an early ack still produces a user-visible error + rollback (via a new
  `preflightFailed` event → a `SendResult{ok:false}`-equivalent or a dedicated effect).
- "Execution Ordering": session ops stay serialized per session path; the early ack must not
  let a second send leapfrog an in-flight one's prepass.

### Scope
**In:** `request-handler.ts` (handleMessageSend / preflight gating), `client.ts` (timeout
table if needed), `effect-runner.ts` (`runSendRpc` error path if semantics change),
`result-handlers.ts` (handle a post-ack prepass-failure path), and the streaming/custom
event plumbing so the prepass window is visible.
**Out:** the prepass *execution* itself (lives in the pi-coding-agent SDK / skill-pruner
extension — out of repo). We only configure & render it.

### Acceptance criteria
- A prepass taking 45s no longer produces `Failed to send message: Timed out waiting for
  response to req-NN`.
- The user message is accepted and shown optimistically within ~100ms of send, regardless of
  prepass duration.
- A prepass that genuinely fails surfaces a clear, recoverable error (see Brief H) and
  rolls back the optimistic message.
- `npm run typecheck && npm run test` pass; `STATE_CONTRACT` invariants unchanged.
- Manual smoke test: send a turn with the prepass enabled and slow; confirm no timeout and
  the transcript shows a prepass status indicator (coordinated with Brief F).

### Bucket: `frontier` · depends on: none · unblocks: C, E, F

---

## 4. Brief B — Request timeout strategy & correlation hardening  *(frontier)*

### Problem
Two independent timers race a single send, the default 30s is too tight for prepass-gated
methods, and dropped/malformed backend stdout lines (`client.ts:240-260`) leave a
`RequestTracker` entry to time out with no diagnostic cause. Heuristics #4, #5, #9.

### Root-cause map (verified)
- `client.ts:38-46` — `RPC_TIMEOUTS_MS` table; `message.send`, `session.truncateAfter`,
  `session.preload` (preload present, others not) inherit `DEFAULT_RPC_TIMEOUT_MS = 30_000`.
- `effect-runner.ts:205, 525-538` (`startOptimisticOpTimer`) — `OPTIMISTIC_OP_TIMEOUT_MS
  = 60_000`, a *separate* host-side TTL that dispatches `SendResult{ok:false}` with error
  `"Timed out waiting for backend response (60s)"`. So a slow send can trigger *both* the
  30s `req-XX` rejection *and* the 60s optimistic revert — overlapping rollback paths.
- `client.ts:226-247` (`handleLine`) parses `ResponseEnvelope`; parse failures are
  logged but the line is dropped, orphaning the pending request. (Lines 107/116/159/184
  are exit/error listeners in `start()`, not `handleLine`.)
- `request-tracker.ts` — fixed timeout per request, no per-request override hook, no
  cancellation/abort signal.

### Researched context
- **VS Code webview RPC patterns** (vscode-hexeditor, vscode-webview-network-bridge,
  eliostruyf): correlation by `requestId` is the norm; timeouts are *delegated to calling
  code* and should be configurable per-call, with a single source of truth. Multiple
  overlapping timers for one logical operation is an acknowledged anti-pattern.
- **Error prevention (#5):** timeouts should be *long enough to be real* (distinguish slow
  from dead) and *accompanied by diagnostics* (was the backend still alive? did a line parse
  fail? was stderr non-empty?).

### Design direction
1. **Single timer per logical op.** Make the optimistic-op TTL the *only* failure timer for
   send/edit, and have the backend RPC timeout feed into it rather than race it. Concretely:
   the `req-XX` rejection should cancel/clear the optimistic timer and be the single rollback
   trigger (or vice-versa), never both independently. Pick one owner.
2. **Right-size timeouts.** Add `message.send` (and any prepass-gated method) to
   `RPC_TIMEOUTS_MS` with a budget sized to the *worst legitimate* prepass + send accept
   (coordinate with Brief A: if A makes `message.send` resolve at queue time, the timeout can
   stay short; if not, it must grow). Make timeouts **per-call overridable** so callers that
   know they're long-lived (prepass) can pass a budget.
3. **Correlation diagnostics.** When `handleLine` drops a line, attempt to correlate it to a
   pending `req-XX` and reject that request with a *descriptive* error (`Backend sent an
   unparseable response for req-NN: <snippet>`) instead of letting it time out
   opaquely. Surface stderr tail in the rejection when present.
4. **Cancellation.** Add an `AbortSignal`/cancel hook to `RequestTracker.create` so an
   interrupt or session close can cancel an in-flight request cleanly (used by Brief E).

### Scope
**In:** `request-tracker.ts`, `client.ts` (timeout table, `handleLine` diagnostics, abort),
`effect-runner.ts` (de-duplicate the two timers).
**Out:** the optimistic rollback *policy* (stays in `result-handlers.ts`, only the trigger
path changes).

### Acceptance criteria
- Exactly one timer owns the send/edit failure path; no double-rollback.
- Dropped backend lines reject the matching pending request with a diagnostic message, not a
  silent 30s timeout.
- `message.send` timeout budget matches its real worst-case (post-A).
- In-flight requests can be cancelled by the caller (used by interrupt/session-close).
- Tests cover: timeout path, dropped-line path, cancel path, double-rollback absence.
- `npm run typecheck && npm run test` pass.

### Bucket: `frontier` · depends on: none (coordinate outcome with A) · unblocks: E, H

---

## 5. Brief C — Optimistic lifecycle for composer inputs (pasted-image stickiness)  *(medium)*

### Problem
Pasted images stay visible as attachment cards in the composer until the pruning prepass
finishes, because `pendingComposerInputsBySession[sessionPath]` is cleared **only** in
`handleSendResult` on success — which fires only after `message.send` returns, which waits on
the prepass (Brief A). Heuristics #1, #8.

### Root-cause map (verified)
- `extension/src/host/core/reducer/result-handlers.ts:48` — inputs cleared on `SendResult`
  success only.
- `extension/src/host/core/reducer/command-misc-handlers.ts:101` — `handleSend` marks
  `runningSessionPaths` *immediately* (the activity indicator already gets early treatment;
  the input clear did not).
- `extension/src/webview/panel/composer/attachments.tsx` — renders
  `pendingComposerInputs` as full attachment cards with image previews.
- `extension/src/host/core/reducer/command-file-handlers.ts:90-130` — `AddComposerInput`
  appends to host-side `pendingComposerInputsBySession`.

### Researched context
- **Image paste UX** (web.dev, uploadcare, claude-command-center commit): the modern pattern
  is *instant local preview* (`URL.createObjectURL(blob)`) → *compact/transition to accepted
  state* once the attachment is acknowledged, not lingering as a pending card until the whole
  downstream operation completes. Heuristic #8 (minimalist) + #1 (status).
- **Optimistic UI reconciliation** (ably.com): once the optimistic prediction is accepted,
  collapse the pending affordance into its final compact form immediately.

### Design direction
- Clear/compact `pendingComposerInputs` **at send time** (when `handleSend` already marks the
  session running), not at `SendResult` time. The inputs have already been folded into the
  `composedText`/`userParts` by `MessageRouter.onSend`; keeping them as pending cards past
  that point is pure visual debt.
- If a rollback occurs (`sendRejected`), restore the inputs to the composer (the webview
  already restores the draft text in `use-host-sync.ts:225-238`; extend that to inputs).
- Visually transition accepted attachments from "pending" to a compact, non-interactive
  "attached to last sent turn" state (or simply remove them from the composer and show them
  inline in the now-sent user message), so the composer is immediately clean for the next
  turn.

### Scope
**In:** `command-misc-handlers.ts` (`handleSend` early clear), `result-handlers.ts` (remove
the now-redundant success clear; handle restore-on-rollback), `use-host-sync.ts`
(sendRejected input restore), `attachments.tsx` / `composer/hooks.ts` (compact/transition).
**Out:** the prepass decoupling itself (Brief A); this brief assumes send-accept is prompt.

### Acceptance criteria
- Pasted images disappear from the composer **immediately** on send, regardless of prepass
  duration.
- On send rejection, the images are restored to the composer (no data loss).
- No regression in the existing "close/invalidate clears pending inputs" contract
  (`STATE_CONTRACT.md` Session Cleanup).
- `npm run typecheck && npm run test` pass.

### Bucket: `medium` · depends on: A · unblocks: none

---

## 6. Brief D — Stale-state / "old + new message at once"  *(frontier)*

### Problem
Users see the old message and the new message at the same time (stale overlay) during
editing/interrupting/multi-prompt flows. Root cause is the host↔webview **snapshots-only**
transport combined with the `StateAppliedWatchdog` **suppressing force-reload while any
session is running** — a wedged/missed-ack webview mid-stream won't self-heal until the run
finishes, and 150ms streaming debounce can leave the webview a snapshot behind. Heuristics
#5, #6.

### Root-cause map (verified)
- `extension/src/host/sidebar/sync.ts:33-90` — `buildStateEnvelope`, full snapshots only,
  monotonic `revision` + `hostInstanceId`.
- `extension/src/host/sidebar/provider.ts:27,29` (`SCHEDULE_DEBOUNCE_MS=50`,
  `STREAMING_SCHEDULE_DEBOUNCE_MS=150`) and `247-300, 360-410` — `globalDirty` on failed
  post / hidden view; `postImperative` for `sendRejected`.
- `extension/src/host/sidebar/state-applied-watchdog.ts:5` (`STATE_APPLIED_TIMEOUT_MS=
  2500`); reload **suppressed when `runningCount > 0`** (lines 153-160). This is the prime
  suspect for stale-state-during-streaming.
- `extension/src/host/session-service/handlers/attach.ts:116` &
  `extension/src/host/core/reducer/session-handlers.ts:81-115` — the
  `busy || hostRunning` preserve-decision that keeps newer optimistic/streaming transcript
  over a backend snapshot during an edit's truncate window.
- `extension/src/webview/panel/hooks/use-host-sync.ts:130-200, 245-290, 360-450` —
  `hydrateViewState` reference-stabilizes prefs/models/pruning; `useMergedTranscript`
  overlays optimistic user messages; `handleStateMessage` clears transient UI only on
  host-instance or active-session change.
- `extension/src/host/core/projection.ts:118-210` — `selectViewState` is O(transcript)
  (e.g. `derivePruningResult` iterates the transcript at line 72) and un-memoized
  (see Brief G).

### Researched context
- **Stale state in streaming React chat** (stackoverflow q.79831606, claudecodeui #461):
  the canonical failure is React batching overwriting the just-sent message with stale server
  data. The fix pattern is **length/identity guards** (only accept server data when it
  actually grew / ids are newer) and **last-loaded-id tracking** to skip redundant reloads.
- **Cross-context state sync** (TanStack query #10130): isolated JS contexts (webview ↔
  host) cannot rely on cache invalidation propagation; **authoritative full snapshots + ack
  reconciliation** is the robust pattern — which we already have, but the watchdog's
  reload-suppression breaks the self-healing leg.
- **Deduplication** (manas_31 dev.to): maintain a `Set` of processed revision/ids; discard
  stale envelopes whose revision ≤ last-applied.

### Design direction
1. **Re-enable safe self-healing while streaming.** Replace the blanket
   `runningCount > 0` reload-suppression with a **revision-gated** strategy: if the webview
   acks *some* revision during streaming, it's alive — only force-reload when acks are
   absent across a sliding window *and* a fresh snapshot won't clobber in-flight optimistic
   state (respect the `busy || hostRunning` preserve-decision on the *host* projection side
   so a reload re-sends the authoritative-with-optimistic snapshot, not a stale backend one).
   The watchdog should resnapshot (cheap, debounced) rather than full-reload wherever
   possible.
2. **Revision guards in the webview.** In `handleStateMessage`, discard envelopes with
   `revision <= lastRevisionRef` (already partially present — make it explicit and total).
   Apply the **length/identity guard** pattern to transcript reconciliation: never let an
   incoming snapshot shrink/overwrite the optimistic overlay unless the host-instance or
   session changed (which already triggers a clear).
3. **Tune streaming debounce.** Evaluate lowering `STREAMING_SCHEDULE_DEBOUNCE_MS` from 150
   toward 50-80 once Brief G memoizes projection (so cheaper snapshots can post more often
   without O(transcript) cost). Coordinate with G.
4. **Make `sendRejected`/imperatives robust when view not ready.** Confirm
   `globalDirty` flush on visibility return covers stale imperatives (provider.ts:340-348,
   380-410).

### Scope
**In:** `state-applied-watchdog.ts`, `provider.ts` (debounce + dirty flush), `use-host-sync.ts`
(revision + length/identity guards, transient-clear policy), `sync.ts` (envelope revisions),
`session-handlers.ts`/`attach.ts` (preserve-decision stays, but verify a reload path honors it).
**Out:** projection memoization (Brief G — D depends on G for the debounce change).

### Acceptance criteria
- During a streaming run with an artificially wedged webview (delayed acks), the view
  converges to the authoritative state without showing old+new simultaneously and without
  waiting for the run to finish.
- An out-of-order or duplicate envelope is discarded (no flicker, no regression).
- Editing/interrupting mid-stream no longer flashes stale content.
- `STATE_CONTRACT.md` "Snapshot Recovery" invariants hold (full snapshot authoritative;
  busy refresh must not discard newer optimistic/streaming state).
- `npm run typecheck && npm run test` pass; add a test for revision-discard and
  missed-ack-while-streaming.

### Bucket: `frontier` · depends on: G · unblocks: none

---

## 7. Brief E — Edit / interrupt UX clunkiness  *(medium)*

### Problem
Editing, interrupting, and rapid multi-prompt conversations feel clunky: optimistic-op 60s
TTL, truncate-then-send serialization on the shared lifecycle queue, and the
preserve-decision interplay. Heuristics #3, #6.

### Root-cause map (verified)
- `extension/src/host/core/effect-runner.ts:637-674` — `runEditRpc` does
  **truncate-then-send** in one session-op (`session.truncateAfter` then `message.send`).
- `extension/src/host/core/effect-runner.ts:563-583` — `runRpc` enqueues
  `message.interrupt` (15s timeout, `client.ts:45`).
- `extension/src/backend/request-handler.ts:352-372` — `handleMessageInterrupt` aborts the
  SDK session + UI bridge and does **not await abort completion**.
- `extension/src/host/core/reducer/result-handlers.ts:94-123` — `handleEditResult` rollback.
- `extension/src/webview/panel/use-app-handlers.ts:56-72, 100-115, 165-178` — webview
  send/interrupt/edit handlers.
- `extension/src/webview/panel/transcript/inline-editor.tsx` & `inner.tsx:165-180` — inline
  edit UX.

### Researched context
- **User control & freedom (#3):** interrupt must feel instantaneous. Best practice
  (jsguide.dev chat design, ably optimistic-updates): cancel signals should propagate
  immediately and the UI should reflect cancellation *before* the backend confirms, with
  rollback if the cancel itself fails.
- **Recognition over recall (#6):** the edit affordance should make the truncate-then-send
  pipeline's intermediate state invisible (no flash of the truncated transcript before the
  new send lands).

### Design direction
1. **Interrupt responsiveness:** give the webview immediate visual "stopping…" feedback on
   `handleInterrupt` (already sets `interruptInFlightBySession`); ensure the optimistic
   overlay/typing indicator clears instantly. Use Brief B's cancel hook to cancel the
   in-flight `message.send` RPC when interrupt fires, so a slow prepass-gated send can be
   aborted without waiting for its timeout. Confirm `handleMessageInterrupt` not awaiting
   abort doesn't leak (verify the session-op queue releases).
2. **Edit pipeline invisibility:** ensure the truncate snapshot never reaches the webview as
   a visible "messages disappeared" frame — the `busy || hostRunning` preserve-decision
   (Brief D) should keep the pre-truncate view stable until the new send's first delta. Add
   an explicit guard if the snapshot still leaks.
3. **Rapid multi-prompt:** verify that a second send while the first's prepass runs (post-
   Brief-A early-ack) queues cleanly per the session FIFO contract and shows an honest
   "queued" status rather than appearing to do nothing.

### Scope
**In:** `effect-runner.ts` (edit/interrupt paths, cancel-hook usage), `use-app-handlers.ts`
(visual feedback), `inline-editor.tsx`/`inner.tsx` (edit stability), `result-handlers.ts`
(edit rollback clarity).
**Out:** the RPC timer de-duplication (Brief B) and prepass decoupling (Brief A) — E builds
on both.

### Acceptance criteria
- Interrupt reflects in the UI within one frame; a slow send is abortable without waiting on
  its timeout.
- Edit never flashes a truncated transcript; the view stays stable until new content streams.
- A second prompt during an in-flight prepass shows a clear queued state and runs after the
  first per FIFO.
- `STATE_CONTRACT.md` "Execution Ordering" holds.
- `npm run typecheck && npm run test` pass.

### Bucket: `medium` · depends on: A, B · unblocks: none

---

## 8. Brief F — Pruning prepass UX: visibility of system status  *(medium)*

### Problem
The prepass can be slow and the user has no live, cancelable indicator that it's running,
why send is delayed, or how to bypass it. Settings expose `prepassTimeoutSec` but the cause-
and-effect is invisible. Heuristics #1, #7, #10.

### Root-cause map (verified)
- `extension/src/backend/session-event-handler.ts:210-235` — prepass surfaces as
  `message_end`/`custom` events forwarded live as `message.custom` (the plumbing already
  exists).
- `extension/src/shared/protocol/settings.ts:29-82` — `PruningDetails` shape
  (`prepassModel`, `prepassLatencyMs`, `prepassError`, `prepassTimeoutSec`).
- `extension/src/host/session-service/pruning-settings.ts:95-102, 175-181` —
  `prepassTimeoutSec` normalization/persistence.
- `extension/src/webview/panel/transcript/pruning-inline.tsx`, `pruning-header.tsx`,
  `pruning-details.tsx`, `pruning-banner.tsx` (105-130) — render the *result*, not the
  in-progress state.

### Researched context
- **Visibility of system status (#1)** (nngroup, midrocket): "appropriate feedback within a
  reasonable time" — a progress indicator with elapsed time + cancel for any operation
  exceeding ~1s. Google Drive's upload progress bar is the canonical example.
- **Flexibility & efficiency (#7):** offer a skip/bypass for the prepass on small or
  trivial turns (e.g. a setting, a per-send toggle, or an auto-skip heuristic).

### Design direction
- Add a **live prepass status chip** in the transcript/composer area while the prepass runs:
  "Pruning context… {elapsed}s" with a **Cancel** affordance that fires interrupt (Brief E's
  cancel hook). Drive it from the existing `message.custom` prepass events.
- Show a **post-hoc summary** with `prepassLatencyMs` and a hint when latency exceeds a
  threshold ("This turn spent Xs pruning context — you can lower `prepassTimeoutSec` or skip
  pruning in settings").
- Evaluate an **auto-skip** heuristic: skip the prepass when the transcript is below a size
  threshold or the turn is a trivial follow-up (coordinate with the SDK skill-pruner — out
  of repo, but expose the toggle here).

### Scope
**In:** `pruning-inline.tsx`/`pruning-header.tsx`/`pruning-banner.tsx` (live state),
`session-event-handler.ts` (ensure prepass-start/finish events carry timing),
`pruning-settings.ts` (skip/bypass toggle if feasible), `ViewState` projection of in-progress
prepass.
**Out:** the prepass execution (SDK).

### Acceptance criteria
- While the prepass runs, the user sees a live, cancelable status indicator.
- After completion, latency is visible with actionable guidance when high.
- Cancel actually aborts the prepass (via Brief E's interrupt/cancel path).
- `npm run typecheck && npm run test` pass.

### Bucket: `medium` · depends on: A, E · unblocks: none

---

## 9. Brief G — Projection memoization & render-path performance  *(medium)*

### Problem
General app fragility/slowdowns: `selectViewState` is O(transcript) and un-memoized, and
`scheduleRender` fires once per backend event. During streaming the 150ms debounce limits
frequency, but each post still pays the full projection cost. Heuristic #5 (error
prevention via performance headroom).

### Root-cause map (verified)
- `extension/src/host/core/projection.ts:120-180` — `selectViewState` O(transcript),
  un-memoized.
- `extension/src/host/extension-host.ts:403-421` — `scheduleRender` →
  `sidebarProvider.scheduleState()`.
- `extension/src/host/sidebar/provider.ts:289-300` — debounced post.

### Researched context
- **Virtualization & memoization for large chat** (jsguide.dev): memoize derived view state,
  structural-share unchanged subtrees, and keep projection cost sub-linear in transcript
  size via incremental derivation keyed by revision.
- **React memo barriers** (already used in `hydrateViewState` via `pickStable`): reference
  stabilization makes `memo()` effective; the host projection should do the same so the
  envelope only changes the slices that actually changed.

### Design direction
- Memoize `selectViewState` with structural sharing: cache the previous projection keyed by
  a cheap transcript/session revision signature; return the same references for unchanged
  slices. This makes snapshots cheap and enables Brief D to lower the streaming debounce.
- Profile a long-streaming run before/after; target sub-millisecond projection for unchanged-
  delta posts.

### Scope
**In:** `projection.ts`, `extension-host.ts` (scheduleRender interaction), `sync.ts`
(envelope building benefits).
**Out:** webview rendering (already virtualized + memo'd).

### Acceptance criteria
- Projection cost for an unchanged-delta post is O(1) amortized.
- A 1000-message transcript streams without per-delta jank.
- Brief D's debounce reduction is enabled by this.
- `npm run typecheck && npm run test` pass; add a projection-memoization unit test.

### Bucket: `medium` · depends on: none · unblocks: D (debounce reduction)

---

## 10. Brief H — Error prevention, messaging & graceful degradation  *(medium)*

### Problem
Errors are opaque (`Timed out waiting for response to req-45` leaks internal ids), give no
recovery path, and dropped backend lines leave no diagnostic cause. Heuristics #2, #9, #4.

### Root-cause map (verified)
- `result-handlers.ts:79` — notice string `"Failed to send message: ${event.error}"` where
  `event.error` is the raw `req-XX` timeout string.
- `effect-runner.ts:525-538` — `"Timed out waiting for backend response (60s)"`.
- `client.ts:240-260` — dropped stdout lines logged but not correlated to pending requests
  (Brief B addresses the correlation; this brief owns the *user-facing* message + recovery).

### Researched context
- **Match the real world (#2)** + **recognize/diagnose/recover (#9)** (nngroup): error
  messages should be in plain language, name the problem, and offer a concrete next action.
  "Timed out waiting for response to req-45" fails all three.
- **Consistency (#4):** one error vocabulary across send/edit/interrupt/prepass failures.

### Design direction
- Introduce a **user-facing error mapper**: map internal RPC errors to plain-language
  messages + recovery actions. E.g. `req-XX` timeout → "The model took too long to start
  this turn. [Retry] [Cancel] [Open settings → pruning]". Never surface `req-NN`.
- For prepass failures (post-Brief-A), offer "Retry without pruning" / "Retry".
- For backend-exit/stderr-correlated errors, surface a short, actionable summary with a
  "Show logs" affordance.
- Ensure every failure path rolls back optimistic state cleanly (no orphaned optimistic
  messages) and restores composer inputs (Brief C).

### Scope
**In:** `result-handlers.ts` (notice construction), a new error-mapping module, webview
error/toast presentation for send/edit/interrupt/prepass failures.
**Out:** the correlation diagnostics (Brief B) — H consumes B's descriptive errors.

### Acceptance criteria
- No internal `req-NN` id ever reaches the user.
- Every error message names the problem and offers a concrete action.
- All failure paths roll back optimistic state and restore inputs.
- `npm run typecheck && npm run test` pass; add tests for the error mapper.

### Bucket: `medium` · depends on: B (descriptive errors), A (prepass-failure path) · unblocks: none

---

## 11. Cross-cutting invariants every brief must preserve

From `docs/STATE_CONTRACT.md` — reviewers must check these for every task:

- **Reducer purity:** no I/O / `Date.now()` / randomness in the reducer; side effects only in
  `EffectRunner`.
- **Optimistic reconciliation:** `corrId` correlates command ↔ pending ↔ `EffectResult`;
  success promotes, failure reverts via `pending[corrId].snapshot`.
- **Execution ordering:** lifecycle serialized through the host lifecycle queue; session
  mutations serialized per `sessionPath`; FIFO preserved.
- **Snapshot recovery:** full snapshots authoritative; busy `session.opened` must not
  discard newer in-memory optimistic/streaming state; webview clears transient UI on
  host-instance or active-session change.
- **Webview-local state allowlist:** no logic state in webview `useState`/`useReducer`
  beyond the enumerated ephemeral concerns (contextMenu, peek, scroll, focus, drag,
  animation, protocol-sync bookkeeping, telemetry, per-keystroke draft, optimistic overlay).
- **Session routing & cleanup:** mutating requests require explicit `sessionPath`;
  close/invalidate clears transcript/alias/turn/busy/inputs/ops for that session.

Any brief that would relax one of these must call it out explicitly and update
`STATE_CONTRACT.md` in the same change.

---

## 12. Verification & done-definition (per wave)

1. `cd extension && npm run typecheck` — clean.
2. `cd extension && npm run test` — green, with new tests for each brief's acceptance
   criteria.
3. `cd extension && npm run build` — builds + syncs to installed extension.
4. Manual smoke test matrix (after each wave):
   - Send a turn with prepass enabled & artificially slow → no `req-NN` timeout; live
     prepass indicator; cancel works.
   - Paste an image and send → image clears from composer instantly; restores on reject.
   - Edit a mid-transcript message → no truncated-frame flash; stable until new delta.
   - Interrupt a streaming turn → UI stops within one frame; slow send abortable.
   - Send a second prompt while the first prepass runs → queued state shown; FIFO honored.
   - Wedge the webview (delay acks) during streaming → converges without old+new overlap.
   - Force a backend stderr/parse failure → actionable plain-language error, no `req-NN`.
5. `reviewer` subagent accepts each brief against its acceptance criteria + §11 invariants.
6. Update `TODO.md`: close completed briefs; commit scoped changes only.