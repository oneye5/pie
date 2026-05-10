# PI Assistant Behavioural And State Audit Plan

## Scope

This document audits the current extension state model and outlines a plan to remove subtle behavioural bugs that arise from ambiguous ownership, optimistic transitions, and under-specified synchronization.

The audit focuses on these surfaces:

- `src/backend/index.ts`
- `src/host/session-service.ts`
- `src/host/store.ts`
- `src/host/extension-host.ts`
- `src/host/sidebar-provider.ts`
- `src/shared/protocol.ts`
- `src/shared/tab-behavior.ts`
- `src/webview/panel/panel.tsx`
- `src/webview/panel/overlay.ts`
- `src/webview/panel/transcript.tsx`
- `test/*.test.ts`

## Verified Baseline

This audit is based on direct code-path review plus the current automated baseline.

- `npm run build` passes.
- `npm test` passes (`89/89`).
- The current test suite covers many happy-path transitions and some protocol semantics.

That means the main risk is not obvious breakage. The main risk is structural: race windows, stale pointers, missed cleanup, and sync semantics that are correct only when events arrive in the expected order.

## Current State Model

The app currently has four distinct state layers:

1. Backend runtime state in `src/backend/index.ts`
2. Host Redux state in `src/host/store.ts`
3. Webview snapshot state in `src/webview/panel/panel.tsx`
4. Webview transient overlay and composer state in `src/webview/panel/overlay.ts` and `src/webview/panel/ui.tsx`

That layering is reasonable in principle, but the contracts between layers are still too implicit.

The most important examples are:

- session identity can be inferred from multiple places (`viewedSessionPath`, `viewRequestedPath`, `activeSession`, payload fallbacks)
- some transitions are optimistic but not serialized (`create`, `open`, `close`, `send`, `interrupt`)
- some derived structures have no teardown path (`messageIdAlias`, `busySeqMap`, pending tabs)
- the host assumes dropped patches will be repaired by a later snapshot, but that recovery contract is not explicit

## Main Findings

### 1. Session identity is not singular

The current code uses several notions of "the session we mean":

- backend `viewedSessionPath`
- host `viewRequestedPath`
- store `activeSession`
- payload `sessionPath`

This makes edge cases difficult to reason about:

- rapid tab switching can produce stale `session.opened` responses
- `message.send` and `message.interrupt` can fall back to the wrong session when a path is omitted
- `message.interrupt` can currently report success even when no session was actually interrupted
- closing one tab while another is opening relies on timing rather than a single authoritative operation token

### 2. Cleanup is incomplete and not centralized

Several per-session structures are created incrementally but do not have a corresponding teardown path:

- transcript aliases in `messageIdAlias`
- busy-event dedup state in `busySeqMap`
- pending session placeholders
- optimistic local transcript entries

At least one of these gaps is concrete today: `messageIdAlias` grows globally and does not have a session-scoped cleanup path.

This creates long-tail bugs: stale lookups, memory growth, and state that survives past the lifecycle it belongs to.

### 3. Snapshot and patch semantics are lossy

The host/webview protocol uses:

- full snapshots for baseline state
- incremental patches for streaming deltas and tool updates

That is the right shape, but the recovery path is still fragile:

- patches can be skipped when the webview is unavailable
- the webview detects gaps, but only after it receives another message
- host restart and webview re-resolution still rely on local reset logic instead of an explicit replay contract

### 4. Multiple mutable layers own related state

The host owns transcript truth, while the webview also owns:

- streaming overlay bytes
- pending file attachments
- inline editing state
- context-menu state

Not all of that is problematic, but the current split makes it easy for the UI to momentarily represent a state that the host cannot reconstruct after a reload, focus change, or missed patch.

### 5. Optimistic UI transitions are not serialized

The current UX correctly favors responsiveness, but operations like these can interleave:

- `newSession` twice in a row
- `closeSession` while `openSession` is still in flight
- `send` against a session that was just closed or replaced
- `truncateAfter` followed immediately by `message.send`

There is also a narrower creation bug to account for: pending session IDs are derived from `Date.now()`, so two rapid creates can collide if they land in the same millisecond.

The implementation relies on stale-response guards in a few places, but those guards are local and not modeled as a system.

### 6. The test suite is still biased toward ordered success paths

The current tests do a good job of proving that the designed path works. They do not yet prove that the system behaves correctly when:

- events arrive late
- two transitions overlap
- the webview is hidden during streaming
- the host restarts mid-session
- cleanup should occur after close, abort, or failure

## Root Causes

The nuanced bugs are most likely coming from five structural issues:

1. Too many fallback paths for session resolution.
2. State is stored as mutable objects rather than normalized identities where it matters.
3. No single lifecycle cleanup routine exists for "session is no longer active/open/relevant".
4. Protocol guarantees are informal and encoded in comments rather than invariants.
5. Tests do not currently stress the interleavings that the architecture allows.

## Non-Negotiable Target Invariants

The fix plan should converge on these invariants.

### Session invariants

- Every command that mutates or queries a session uses an explicit `sessionPath`.
- The host stores `activeSessionPath`, not an authoritative `activeSession` object.
- Session summaries are derived from normalized session records, not treated as mutable truth.
- A late response can never re-activate a tab unless it matches the current operation token.

### Lifecycle invariants

- Every per-session auxiliary map has a teardown path.
- Closing or replacing a session removes all state that is scoped to that session.
- Pending session placeholders are removed from both session records and open-tab records on failure.
- Restarting the backend cannot cause old dedup counters or alias state to be interpreted as current state.

### Sync invariants

- The webview can miss any number of patches and recover deterministically.
- Host restarts, webview re-resolution, focus regain, and visibility regain all have an explicit re-sync path.
- Overlay state is invalidated whenever the snapshot base changes.

### Execution invariants

- Only one lifecycle transition may own a session-selection change at a time.
- Only one send/edit/truncate/interrupt operation may mutate a given session at a time.
- Missing `sessionPath` in backend or host events is treated as a protocol defect, not silently routed to the active session.

## Remediation Plan

### Phase 0: Make The Invariants Executable

Goal: stop relying on implicit assumptions before changing architecture.

- Write a short state contract doc for session selection, request lifecycle, and snapshot/patch ordering.
- Add debug-only assertions around session resolution, active-tab reconciliation, and patch revision handling.
- Add structured logging for `create`, `open`, `close`, `send`, `interrupt`, `session.opened`, `busy.changed`, and snapshot/patch posts.
- Introduce a small helper for "assert session exists and is open" instead of ad hoc checks.

Exit criteria:

- Core invariants are written down.
- Logs clearly show the ordering of state transitions.
- Violations fail loudly in development.

### Phase 1: Normalize Host State Ownership

Goal: reduce ambiguity in the host store.

- Refactor `src/host/store.ts` so the authoritative selection is `activeSessionPath`, with session summaries derived from normalized records.
- Normalize transcripts and session records by `sessionPath` rather than relying on arrays plus mutable object references.
- Replace any logic that treats `activeSession` as a durable source of truth.
- Add selectors that derive the current session object from `activeSessionPath` on demand.

Primary files:

- `src/host/store.ts`
- `src/host/session-service.ts`
- `src/host/extension-host.ts`

Exit criteria:

- Selection, running-state checks, and transcript lookup all resolve through path identity.
- The UI cannot point at a session object that is no longer canonical.

### Phase 2: Remove Ambiguous Session Fallbacks

Goal: make session routing explicit end to end.

- Remove backend request fallbacks that use `viewedSessionPath` for mutating operations.
- Require explicit `sessionPath` for `message.send`, `message.interrupt`, and similar actions.
- Replace `viewRequestedPath`-style stale-response protection with operation-scoped IDs or tokens.
- Carry those tokens through `session.create` and `session.open` flows so late `session.opened` events can be ignored deterministically.

Primary files:

- `src/backend/index.ts`
- `src/shared/protocol.ts`
- `src/host/session-service.ts`

Exit criteria:

- No state-changing path depends on an implicit "currently viewed" session.
- Late responses cannot promote the wrong session.

### Phase 3: Centralize Session Cleanup

Goal: guarantee teardown of all per-session state.

- Add a single cleanup routine for session-scoped state in the host.
- Clear transcript aliases, current-turn records, busy dedup records, pending placeholders, and any other auxiliary maps when a session is closed, replaced, or invalidated.
- Ensure pending-session failure cleans both the session list and `openTabPaths`.
- Replace timestamp-only pending IDs with collision-safe identifiers.
- Reconcile active selection after close or failure with one shared helper.

Primary files:

- `src/host/store.ts`
- `src/host/session-service.ts`
- `src/shared/tab-behavior.ts`

Exit criteria:

- There is one obvious place to remove all session-scoped state.
- Closing or failing a session cannot leave behind invisible state.

### Phase 4: Serialize Risky Transitions

Goal: stop race windows from becoming user-visible state corruption.

- Introduce a serialized lifecycle queue for `create`, `open`, and close-driven reselection.
- Introduce a per-session operation queue for `send`, `edit`, `truncateAfter`, and `interrupt`.
- Prevent a second operation from observing intermediate optimistic state as if it were final.
- Make optimistic UI transitions reversible if the authoritative result differs.

Primary files:

- `src/host/session-service.ts`
- `src/backend/index.ts`

Exit criteria:

- Concurrent user actions are processed deterministically.
- The store cannot represent two competing owners for the same session lifecycle.

### Phase 5: Harden Snapshot And Patch Recovery

Goal: make host/webview sync robust when events are missed.

- Treat snapshots as explicit bases and patches as deltas against a known base revision.
- When the webview is unavailable or hidden, either queue patch intent for replay or mark the stream dirty and force the next interaction to use a full snapshot.
- Reset overlay state whenever `hostInstanceId` or snapshot base changes.
- Add explicit refresh triggers for focus regain, visibility regain, and webview re-resolution.
- Re-evaluate whether some patch types should be folded back into snapshots if the complexity is not paying for itself.

Primary files:

- `src/host/sidebar-provider.ts`
- `src/host/extension-host.ts`
- `src/webview/panel/panel.tsx`
- `src/webview/panel/overlay.ts`

Exit criteria:

- Missing a patch cannot leave the UI permanently stale.
- Host restarts and hidden-view streaming recover without manual intervention.

### Phase 6: Re-scope Webview Local State

Goal: keep only truly ephemeral UI state in the webview.

- Audit `pendingPaths`, edit state, and other local state to determine what should survive session switches and what should be cleared.
- If attachment intent must survive refresh/reload, move it to host state and include it in snapshots.
- If it is intentionally transient, clear it explicitly on session change and snapshot rebases.
- Keep the webview responsible for presentation concerns, not recoverable domain state.

Primary files:

- `src/webview/panel/panel.tsx`
- `src/webview/panel/ui.tsx`
- `src/host/store.ts`

Exit criteria:

- Reloading or re-syncing the webview never produces surprising leftover composer state.
- The boundary between durable and ephemeral UI state is explicit.

### Phase 7: Expand The Test Matrix To Match The Real Risk

Goal: prove the new invariants under adversarial ordering.

Add tests for:

- two `newSession` calls racing with out-of-order `session.opened`
- two `newSession` calls created in the same tick or millisecond
- rapid `openSession` tab switching with stale responses
- `closeSession` followed by late `session.opened`
- `send` and `interrupt` against a session that is closed during dispatch
- `interrupt` without a valid `sessionPath` failing loudly instead of succeeding silently
- alias-map cleanup on transcript/session removal
- busy-sequence cleanup on session close and backend restart
- pending-session cleanup on backend failure
- hidden webview during streaming followed by reveal
- host restart during streaming and first-message recovery
- settings/model hydration during session restore/open

Primary files:

- `test/session-events.test.ts`
- `test/store.test.ts`
- `test/sync-contract.test.ts`
- add focused tests for sidebar/webview synchronization if needed

Exit criteria:

- The suite covers race and recovery paths, not just steady-state success.
- Regressions in state ordering become cheap to detect.

## Recommended Order Of Execution

If this work is split into PRs, the safest order is:

1. Phase 0 and Phase 7 scaffolding
2. Phase 1 state normalization
3. Phase 2 explicit session routing
4. Phase 3 cleanup centralization
5. Phase 4 operation serialization
6. Phase 5 sync hardening
7. Phase 6 webview-local-state cleanup

That order keeps behavior improving while reducing the chance of rewriting the same logic twice.

## Highest-Value First Fixes

If only a small slice can land immediately, prioritize these items first:

1. Remove implicit session fallbacks for mutating operations.
2. Normalize active selection to `activeSessionPath`.
3. Add centralized cleanup for aliases, busy dedup, and pending placeholders.
4. Add operation tokens for open/create flows.
5. Add hidden-webview and out-of-order response tests.

Those five changes attack the most likely causes of subtle state corruption without requiring a wholesale rewrite.

## Definition Of Done

This audit should be considered resolved only when all of the following are true:

- Session selection is explicit and tokenized.
- Mutating actions never depend on an inferred active session.
- Every per-session structure has teardown coverage.
- The webview can recover deterministically from missed patches and host restarts.
- The test suite covers the important race and recovery cases.
- Manual validation confirms correct behavior for create, open, close, stream, interrupt, restore, and reload.
