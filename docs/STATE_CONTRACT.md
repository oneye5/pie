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
- Patches are applied only when the webview is visible and able to consume them.
- If a patch cannot be delivered, the host marks the stream dirty instead of advancing revision.
- When visibility returns, the next host-to-webview sync is a full snapshot.
- The webview clears overlay/transient UI when the host instance changes or the active session changes.
- A busy `session.opened` refresh may update tab/session metadata, but it must not discard in-memory optimistic or streaming transcript state that is newer than the backend snapshot.

## Execution Ordering

- Lifecycle requests (`create`, `open`) are serialized through a host lifecycle queue.
- Session mutations (`send`, `edit`, `truncateAfter`, `interrupt`) are serialized per session path.
- Optimistic UI writes must be reversible when the authoritative operation fails.