# pie State Contract

## Session Selection

- The host store owns selection through `activeSessionPath`.
- `activeSession` in the webview snapshot is derived from `activeSessionPath` plus the current session summaries.
- `session.create` and `session.open` carry a `selectionToken`.
- `session.opened` may only activate a tab when its `selectionToken` still owns selection.
- Stale `session.opened` payloads may refresh cached data, but they must not steal focus.

## Session Routing

- Mutating backend requests require an explicit `sessionPath`.
- `message.send`, `message.interrupt`, and `session.truncateAfter` never fall back to the viewed or active session implicitly.
- Session-scoped backend events must include `sessionPath`.
- Missing `sessionPath` is treated as a protocol defect.

## Session Cleanup

- Closing or invalidating a session clears transcript state, alias state, current-turn state, busy dedup state, pending composer inputs, and queued per-session operations.
- Pending composer inputs are session-scoped host state: close/invalidate clears them for that session; extension restart/shutdown clears all remaining pending inputs.
- Pending-session placeholders are cleaned up one session at a time; overlapping creates must not share teardown.
- Pending session identifiers must be collision-safe under rapid repeated creation.

## Snapshot And Patch Recovery

- Full snapshots are the authoritative base.
- A full snapshot contains the currently loaded transcript window (`transcript`) plus explicit window metadata (`transcriptWindow`), not necessarily the entire historical transcript.
- Patch envelopes are **session-addressed**: every `patch` message carries a `sessionPath` and the webview routes the patch to the matching per-session overlay/revision counter.
- Patch revisions are **per-session** on the host: a patch addressed to session A advances only A's revision counter; sessions B, C are unaffected.
- State-envelope revisions are global and advance on each full snapshot; they continue to detect host-instance counter resets in combination with `hostInstanceId`.
- Every envelope (state and patch) carries `protocolVersion` matching `WEBVIEW_PROTOCOL_VERSION`.
- Patches are applied even while a session is not the active tab so background streams do not pollute the active view; non-active patches update per-session overlays that the webview holds but does not render.
- If a patch cannot be delivered (view hidden or webview not ready), the host marks **that session** dirty (not a global flag) and the next flush emits a full snapshot.
- When visibility returns, the next host-to-webview sync is a full snapshot. A full snapshot resets all per-session revision counters on both host and webview.
- The webview clears overlay/transient UI when the host instance changes or the active session changes.
- A busy `session.opened` refresh may update tab/session metadata, but it must not discard in-memory optimistic or streaming transcript state that is newer than the backend snapshot.

## Execution Ordering

- Lifecycle requests (`create`, `open`) are serialized through a host lifecycle queue.
- Session mutations (`send`, `edit`, `truncateAfter`, `interrupt`) are serialized per session path.
- Optimistic UI writes must be reversible when the authoritative operation fails.
- The EffectRunner routes session-scoped RPC effects through `enqueueLifecycle → enqueueSessionOperation(sessionPath, ...)` to guarantee FIFO ordering with respect to other session operations.
- Lifecycle effects (`OpenSession`, `CreateSession`) use `enqueueLifecycle(...)` directly (no inner session queue).
- Non-session effects (`PersistTabs`, `Log`) execute directly without queueing.

## Reducer Purity

- The reducer is pure: `(State, Event) → { state, effects }`. No I/O, no `Date.now()`, no randomness.
- Side effects only happen inside the EffectRunner.
- An `EffectResult` handler in the reducer may return new effects, but those are queued asynchronously by the runner; the reducer never synchronously awaits another effect.

## Optimistic Reconciliation

- Optimistic mutations (send, edit) are tagged with a `corrId` that correlates the command, the pending state entry, and the eventual `EffectResult`.
- `state.pending: Record<corrId, PendingOp>` tracks in-flight optimistic operations with rollback snapshots.
- On RPC success: promote pending → authoritative (clear `corrId` tag, finalize backend-assigned id).
- On RPC failure: revert via `state.pending[corrId].snapshot`, drop entry.
- Backend events arriving before `SendRpcResult` are applied normally — the pending user message is already in the transcript, so assistant deltas append after it.

## Webview-Local State

The webview must not hold logic state in local `useState`/`useReducer`. Only the following ephemeral UI concerns are allowed as webview-local state:

- **contextMenu** — position and type of the currently open context menu (dismissed on click-outside/Escape)
- **scrollPosition / autoScroll** — viewport scroll tracking
- **input focus / caret position** — DOM focus state
- **drag state** — transient tab drag-and-drop position
- **animation / transition state** — CSS transition tracking
- **protocol-sync bookkeeping** — `lastRevisionRef` (per-session), `awaitingSnapshotRef`, `hostInstanceIdRef`, pending-draft-restore tracking, in-flight `corrId` set for UI gating
- **derived UI telemetry** — token-rate measurement state, FPS counters, render-timing buffers
- **per-keystroke draft buffer** inside an active input (the committed draft on blur/send/tab-switch is host state; the live keystroke buffer is not)
- **optimistic user message overlay** — pending user messages shown instantly before the host confirms them. The webview generates a `localId`, sends it with the `send` protocol message, and displays the message in the transcript immediately. When the host state arrives containing a message with that `localId`, the optimistic overlay entry is reconciled away. On `sendRejected`, the overlay entry is removed and the draft is restored.

All other state (editing, outcome dialogs, draft content, session selection, model settings, prefs) lives in the host store and reaches the webview via ViewState snapshots/patches.
