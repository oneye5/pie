# Architecture

## 1. System Overview

pie is a VS Code extension that provides a chat interface to a local PI (Programming Intelligence) backend. Three processes cooperate:

- **PI backend** — a separate process communicating via JSON-RPC over stdio. Executes language-model calls, tool invocations, and session persistence.
- **Extension host** — the VS Code extension process. Owns all application state, serializes mutations, and projects state to the webview.
- **Webview** — a Preact single-page app rendered in a VS Code sidebar panel. Displays the chat UI and dispatches user intents back to the host.

---

## 2. Architecture Pattern

The system follows a **CQRS-shaped Elm/MVI** pattern. User actions and backend events are unified into a single `Event` type processed by a pure reducer. The reducer returns updated state plus effect descriptors. An effect runner executes side effects (RPCs, persistence, logging) and feeds results back as events. The webview is a passive renderer of projected state — it never mutates logic state directly.

This pattern was chosen to eliminate the class of bugs caused by distributed mutable state across host and webview, ensure testability of all state transitions without I/O, and make streaming/optimistic-update interactions explicit and auditable.

See git history (commit d581d83, file docs/internal/archive/ARCH-MIGRATION-PLAN.md) for historical context.

---

## 3. Information Flow

```
                       ┌──────────────────────────────────────────┐
  Webview Command  ──► │                                         │
  Backend Event    ──► │   Reducer: (ArchState, Event)           │
  EffectResult     ──► │      → { archState', effects: Effect[] } │
  Timer Msg        ──► │   (pure — no I/O, no Redux)             │
                       └──────────┬───────────────────────────────┘
                                  │
                ┌─────────────────┴──────────────────┐
                │                                    │
                ▼                                    ▼
     Projection: ArchState → ViewState    EffectRunner executes:
                │                           - RPCs to PI backend
                ▼                           - File operations
       Patch{sessionPath, ops}              - Notifications
                │                           - Analytics export
                ▼                           Results → Event
       Per-session revision channel
                │
                ▼
       Webview mirror[sessionPath]
                │
                ▼
       Render active session
```

**File locations:**

| Box | Current file | Target file |
|-----|-------------|-------------|
| Reducer | `extension/src/host/core/reducer.ts` | (same) |
| EffectRunner | `extension/src/host/core/effect-runner.ts` | (same) |
| Projection | `extension/src/host/store/index.ts` | `extension/src/host/core/projection.ts` |
| Patch/Snapshot transport | `extension/src/host/sidebar/sync.ts`, `extension/src/host/sidebar/provider.ts` | (same) |
| Webview mirror | `extension/src/webview/panel/hooks/use-host-sync.ts` | (same) |
| Render | `extension/src/webview/panel/app.tsx` | (same) |
| Backend event parser | `extension/src/host/session-service/events.ts` | `extension/src/host/core/backend-event-parser.ts` |
| Message router | `extension/src/host/extension-host.ts` (`handleWebviewMessage`) | `extension/src/host/core/message-router.ts` |

---

## 4. Key Concepts

**Command** — an intent posted from the webview to the host. Carries `corrId` (correlation ID) and `sessionPath`. Defined in `extension/src/host/core/commands.ts`.

**Event** — any input to the reducer: a wrapped Command, a backend streaming event (delta, tool call, message finished), or an EffectResult. Defined in `extension/src/host/core/events.ts`.

**Effect** — a plain data descriptor of a side effect the reducer wants performed (e.g., `SendRpc`, `InterruptRpc`, `PersistTabs`). Never executed inside the reducer. Defined in `extension/src/host/core/effects.ts`.

**EffectRunner** — the single host-side executor of effects. Owns no state. Consumes effects, produces result events. Located at `extension/src/host/core/effect-runner.ts`.

**Projection** — the pure function `ArchState → ViewState` that computes what the webview should display. Will move to `extension/src/host/core/projection.ts` after the migration; currently `selectViewState` in `extension/src/host/store/index.ts`.

**Patch** — a session-addressed diff of `ViewState`, delivered over the host → webview channel. Carries `sessionPath` and a monotonic per-session revision. Defined in `extension/src/shared/protocol.ts`.

**Snapshot** — a full `ViewState` used for initial load and recovery after missed patches. Same transport as patches but replaces the entire mirror.

**Mirror** — the webview-side cache of `ViewState` per session. Managed in `extension/src/webview/panel/hooks/use-host-sync.ts`.

**GlobalViewState / SessionViewState** — the ViewState is composed of global fields (session list, tabs, prefs) and per-session fields (transcript, busy, file changes). Both defined in `extension/src/shared/protocol.ts`.

---

## 5. Data Flow Scenarios

### User sends a message

1. Webview dispatches `{ type: 'sendMessage', sessionPath, text, inputs }`.
2. `extension-host.ts` wraps it as a `Send` Command with a fresh `corrId` + local message ID.
3. Reducer inserts an optimistic user message into `state.pending[corrId]` and returns a `SendRpc` effect.
4. EffectRunner routes the RPC through `enqueueLifecycle → enqueueSessionOperation`.
5. On success: `SendRpcResult` event promotes the pending entry to authoritative.
6. On failure: reducer reverts via the snapshot in `state.pending[corrId]`.

### Streaming assistant reply

1. PI backend emits line-by-line JSON events (`message.delta`, `tool.started`, `message.finished`, etc.).
2. `backend-client.ts` parses each line into a typed `BackendEvent`.
3. The event is dispatched to the reducer.
4. Reducer updates `ArchState.transcript` (append delta, upsert tool call, finalize message).
5. Projection diff produces a patch; `sidebar/provider.ts` posts it to the webview.
6. Webview applies the patch to `mirror[sessionPath]` and re-renders.

### Tab switching

1. Webview dispatches `{ type: 'openSession', sessionPath }`.
2. The Command is dispatched to the reducer, which updates `ArchState.sessions.activePath`.
3. Projection produces a ViewState for the new active session.
4. Webview receives a snapshot for the new active session.

### Extension-driven transcript mutation (pruning)

1. Backend emits a custom message with `customType: "pruning-result"` and typed `customDetails`.
2. Reducer processes it as a `MessageFinished` event, updating `ArchState.transcript`.
3. Projection includes pruning data in ViewState; the webview renders the pruning banner from structured data (no regex parsing).

---

## 6. Boundaries and Contracts

### Host ↔ PI backend

- JSON-RPC over stdio. Request/response plus streaming event lines.
- Backend events carry `sessionPath` — missing `sessionPath` is a protocol defect.
- The host serializes all RPCs per session to prevent races.

### Host ↔ Webview

- Unidirectional state flow: host → webview via snapshots/patches; webview → host via message commands.
- Per-session revision counter detects missed patches; recovery is a full snapshot.
- `hostInstanceId` detects extension restarts; webview resets all mirrors on change.
- `WEBVIEW_PROTOCOL_VERSION` prevents version skew between host and webview code.

See [`docs/STATE_CONTRACT.md`](STATE_CONTRACT.md) for the full invariant set.

---

## 7. State Ownership Rules

| Owner | What it holds |
|-------|--------------|
| **ArchState** (reducer) | All application state: sessions, transcripts, model settings, prefs, file changes, pending optimistic ops, UI logic state, interrupt-in-flight flags, backend event routing |
| **Webview** (local only) | Scroll position, focus/caret, hover, drag, animation, context menu position, protocol bookkeeping (revision refs), token-rate telemetry, per-keystroke draft buffer |

**Rule of thumb:** if you're unsure whether something is host state or webview state, it's host state.

State-shape constraint: all keyed collections in host state use `Record<string, T>` — never `Map`/`Set`.

Full allowlist of webview-local state: see `STATE_CONTRACT.md § Webview-Local State`.

### Migration note

State currently held in Redux Toolkit slices (`transcript-slice`, `sessions-slice`, etc.) will be consolidated into `ArchState` as part of the CQRS migration (see §10). After the migration completes, the Redux store and its slices will be removed, and the SyncEffectSink bridge will be eliminated. All state transitions will go through the reducer; all side-effects through the EffectRunner.

---

## 8. Extension Points

### Adding a new Command (user action)

1. Add variant to `extension/src/host/core/commands.ts`.
2. Add corresponding Event wrapper in `extension/src/host/core/events.ts`.
3. Handle in `extension/src/host/core/reducer.ts` — return state change + effects.
4. If an RPC is needed, add Effect variant in `extension/src/host/core/effects.ts`.
5. Add execution logic in `extension/src/host/core/effect-runner.ts`.
6. Wire the webview message → Command conversion in `extension/src/host/extension-host.ts`.
7. Add reducer unit test in `extension/test/`.

### Adding a new backend event type

1. Add variant to `Event` union in `extension/src/host/core/events.ts`.
2. Handle in reducer — return state change + effects.
3. Wire the raw backend event → typed Event dispatch in the backend event parser (formerly `session-service/events.ts`, now a simple parse function).
4. If the event requires a side-effect (RPC, notification, file operation), add an Effect variant.

### Adding a new ViewState field

1. Add to the `ViewState` interface in `extension/src/shared/protocol.ts`.
2. Populate in the projection function (`selectViewState`).
3. Consume in webview components.
4. Update test ViewState literals in `extension/test/sidebar-sync.test.ts` and `extension/test/sync-contract.test.ts`.

### Adding a new Effect type

Effects are grouped into namespaces (e.g. `SessionRpc`, `SessionLifecycle`, `FileOperation`, `Notification`). To add a new effect:

1. Add variant to the appropriate group in `extension/src/host/core/effects.ts` (or create a new group if it's a new category).
2. Add result Event variant to `extension/src/host/core/events.ts` (if the effect produces a result).
3. Add execution case in `extension/src/host/core/effect-runner.ts`.
4. Handle the result in the reducer.

---

## 9. Invariants

1. **Reducer purity** — `(State, Event) → { state, effects }`. No I/O, no `Date.now()`, no randomness.
2. **Single effect executor** — side effects only happen in the EffectRunner.
3. **Webview passivity** — the webview dispatches Commands and applies Patches. It never mutates logic state.
4. **Session addressing** — every Patch and session-scoped event carries `sessionPath`.
5. **Optimistic correlation** — pending ops are tagged with `corrId` and reconciled by `EffectResult`.
6. **Background preservation** — patches to non-active sessions update their mirrors; they are never dropped.
7. **Record-only state** — `Record<string, T>` for keyed collections (no Map/Set in host state).
8. **Serialized execution** — session RPCs are FIFO-ordered through the lifecycle + session queues.

See [`docs/STATE_CONTRACT.md`](STATE_CONTRACT.md) for additional invariants (snapshot recovery, cleanup, selection ownership).

---

## 10. CQRS Migration — Completion Plan

The original CQRS migration (phases 1–5) left a dual-path architecture: backend streaming events routed through the CQRS reducer, but many handlers still dispatching directly to Redux. The following plan completes the migration to a pure CQRS architecture.

### Design decisions

1. **Unconditional CQRS path** — remove the `dispatchArch` flag and all `else` branches. No fallback. The reducer is the only way to mutate state.
2. **All side-effects become Effect types** — file-change derivation, runObserver calls, completion notification, transcript eviction, file operations, analytics export all become effect descriptors produced by the reducer.
3. **All backend events through the reducer** — `onBusyChanged`, `onContextUsageChanged`, `onSessionListChanged`, `onCustomMessage`, `onExtensionUIRequest`, `onError`, and `applySessionOpened` all become `BackendEvent` variants.
4. **All webview commands through the reducer** — every `WebviewToHostMessage` becomes a `Command` variant → `CommandEvent`.
5. **Big-bang state migration** — all Redux slices consolidated into `ArchState`. SyncEffectSink bridge removed. No Redux store.
6. **Auto-projection** — `ViewState` computed after every reducer cycle. No explicit `ScheduleRender` effect. `PostImperative` becomes state-driven (webview reads intent from `ViewState`).
7. **`ArchState` nested with redrawn boundaries** — not 1:1 with current slices:
   - **`transcript`**: messages, deltas, tool calls, pruning results, message status, editing state
   - **`sessions`**: session list, running states, unread marks, active path
   - **`settings`**: model settings, chat prefs, pruning config, available models, backend ready
   - **`composer`**: pending composer inputs, active run summaries
   - **`fileChanges`**: file change entries, derived state
   - **`pending`**: optimistic ops table, interrupt flags (already in `ArchState`)
8. **`SessionOpened` hybrid handling** — synchronous state mutations happen atomically in one reducer pass; async operations (transcript load, file-change derivation) become effects whose result events trigger further state transitions.
9. **`SessionServiceEvents` replaced by parse function** — no class overhead. Backend event parsing is a simple function.
10. **`PieExtension` becomes thin orchestrator** — lifecycle + wiring only. `MessageRouter`, `QueueManager`, `FileDiffService` extracted as focused modules.
11. **Effects use grouped sub-types** — `SessionRpc`, `SessionLifecycle`, `FileOperation`, `Notification`, etc.
12. **Compute projection on the fly** — add memoization only if latency is measurable.
13. **`session-service/` module dissolved** — parse function → `core/`, queue logic → `EffectRunner`, startup → lifecycle effects.
14. **Test surface** — reducer unit tests `(ArchState, Event) → {state, effects}` plus a small integration test suite for the full cycle.

### Implementation order

- [x] **Step 1:** Define new `ArchState` nested sub-state types (`arch-state.ts`)
- [x] **Step 2:** Expand `Effect` union with grouped namespaces (FileOperation, Notification, Analytics, Eviction, Derivation)
- [x] **Step 3:** Expand `Event` and `Command` unions for currently direct-to-Redux handlers (8 new backend events, 9 new commands)
- [x] **Step 4:** Add new reducer handler stubs (21 stubs with TODO comments)
- [x] **Step 5:** Build projection function `selectViewState(ArchState) → ViewState` (`projection.ts`)
- [x] **Step 6:** Create dispatch module (`dispatch.ts`) with state change notification
- [x] **Step 7:** Remove `dispatchArch` flag and all `else` branches — unconditional CQRS path in `session-service/events.ts`
- [x] **Step 8:** Remove `TransitionalArchState`; reducer now uses full `ArchState` with all 6 sub-states. `SyncEffectSink` bridge still in place but reducer handles all state mutations.
- [x] **Step 9 (partial):** Create `backend-event-parser.ts` — pure function replacing `SessionServiceEvents`. Full dissolution of `session-service/` deferred to step 10.
- [ ] **Step 10:** Remove Redux store — delete slice files, store creation, RTK dependency
- [ ] **Step 11:** Thin `PieExtension` — extract `MessageRouter`, `QueueManager`, `FileDiffService`
- [ ] **Step 12:** Remove `SyncEffectSink` bridge, dissolve `session-service/`, update tests

### Completed files

| File | Status |
|------|--------|
| `extension/src/host/core/arch-state.ts` | New — target `ArchState` type with 6 sub-states, `TransitionalArchState` for backward compatibility, `createInitialArchState()`, `createInitialTransitionalArchState()` |
| `extension/src/host/core/effects.ts` | Updated — 5 new namespace groups (FileOperation, Notification, Analytics, Eviction, Derivation) with 7 new effect types and 5 type guards |
| `extension/src/host/core/events.ts` | Updated — 8 new backend event variants (BusyChanged, BusyCompleted, ContextUsageChanged, SessionListChanged, CustomMessage, ExtensionUIRequest, Error, SessionOpened) |
| `extension/src/host/core/commands.ts` | Updated — 9 new command variants (SetModel, SetPrefs, SelectSession, CloseTab, ReorderTabs, OpenFileDiff, RevertFile, ExportAnalytics, CloseSession) |
| `extension/src/host/core/reducer.ts` | Updated — 21 new handler stubs with TODO comments for new event and command kinds |
| `extension/src/host/core/projection.ts` | New — `selectViewState(ArchState): ViewState` projection function with `derivePruningResult` and `selectActivePruningCatalog` helpers |
| `extension/src/host/core/backend-event-parser.ts` | New — pure function `parseBackendEvent(raw: string): BackendEvent | null` that parses backend JSON lines into typed events (replaces `SessionServiceEvents`) |
| `extension/src/host/core/dispatch.ts` | New — `dispatch()` function wrapping reducer call with state change notification, `subscribeToArchState()` listener API |

## 11. Further Reading

- [`docs/STATE_CONTRACT.md`](STATE_CONTRACT.md) — authoritative host ↔ webview invariants
- [`docs/internal/ARCH-OVERVIEW.md`](internal/ARCH-OVERVIEW.md) — concise file map and glossary
- [`AGENTS.md`](../AGENTS.md) — repo conventions, test commands, build instructions
- Git history: `docs/internal/archive/ARCH-MIGRATION-PLAN.md` (commit `d581d83`) — original migration plan (phases 0–7)
