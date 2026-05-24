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

See [`docs/internal/archive/ARCH-MIGRATION-PLAN.md`](internal/archive/ARCH-MIGRATION-PLAN.md) for historical context.

---

## 3. Information Flow

```
                       ┌────────────────────────────────────────┐
  Webview Command  ──► │                                        │
  Backend Event    ──► │   Reducer: (State, Event)              │
  EffectResult     ──► │      → { state', effects: Effect[] }   │
  Timer Msg        ──► │   (pure — no I/O)                      │
                       └──────────┬─────────────────────────────┘
                                  │
                ┌─────────────────┴──────────────────┐
                │                                    │
                ▼                                    ▼
     Projection: State → ViewState       EffectRunner executes:
                │                           - RPCs to PI backend
                ▼                           - Tab persistence
       Patch{sessionPath, ops}              - Logging
                │                           Results → Event
                ▼
       Per-session revision channel
                │
                ▼
       Webview mirror[sessionPath]
                │
                ▼
       Render active session
```

**File locations:**

| Box | File |
|-----|------|
| Reducer | `extension/src/host/core/reducer.ts` |
| EffectRunner | `extension/src/host/core/effect-runner.ts` |
| Projection | `extension/src/host/store/index.ts` (`selectViewState`) |
| Patch/Snapshot transport | `extension/src/host/sidebar/sync.ts`, `extension/src/host/sidebar/provider.ts` |
| Webview mirror | `extension/src/webview/panel/hooks/use-host-sync.ts` |
| Render | `extension/src/webview/panel/app.tsx` |

---

## 4. Key Concepts

**Command** — an intent posted from the webview to the host. Carries `corrId` (correlation ID) and `sessionPath`. Defined in `extension/src/host/core/commands.ts`.

**Event** — any input to the reducer: a wrapped Command, a backend streaming event (delta, tool call, message finished), or an EffectResult. Defined in `extension/src/host/core/events.ts`.

**Effect** — a plain data descriptor of a side effect the reducer wants performed (e.g., `SendRpc`, `InterruptRpc`, `PersistTabs`). Never executed inside the reducer. Defined in `extension/src/host/core/effects.ts`.

**EffectRunner** — the single host-side executor of effects. Owns no state. Consumes effects, produces result events. Located at `extension/src/host/core/effect-runner.ts`.

**Projection** — the pure function `State → ViewState` that computes what the webview should display. Currently `selectViewState` in `extension/src/host/store/index.ts`.

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
2. `backend-client.ts` parses each line and fires event callbacks.
3. `session-service/events.ts` dispatches each as a typed `BackendEvent` to the arch reducer.
4. Reducer delegates to `transcript-slice.ts` (append delta, upsert tool call, finalize message).
5. Projection diff produces a patch; `sidebar/provider.ts` posts it to the webview.
6. Webview applies the patch to `mirror[sessionPath]` and re-renders.

### Tab switching

1. Webview dispatches `{ type: 'openSession', sessionPath }`.
2. Host updates `activeSessionPath` in the store.
3. Next projection produces a ViewState composed from `globalState + sessionMirrors[newPath]`.
4. Webview receives a snapshot for the new active session — data was already cached in the host.

### Extension-driven transcript mutation (pruning)

1. Backend emits a custom message with `customType: "pruning-result"` and typed `customDetails`.
2. Reducer processes it as a `MessageFinished` event; transcript-slice upserts the message.
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
| **Host store** (Redux Toolkit + Immer) | Sessions, transcripts, model settings, prefs, file changes, pending optimistic ops, UI logic state (editing, dialogs) |
| **Arch reducer** (`ArchState`) | Pending optimistic table, interrupt-in-flight flags, backend event routing |
| **Webview** (local only) | Scroll position, focus/caret, hover, drag, animation, context menu position, protocol bookkeeping (revision refs), token-rate telemetry, per-keystroke draft buffer |

**Rule of thumb:** if you're unsure whether something is host state or webview state, it's host state.

State-shape constraint: all keyed collections in host state use `Record<string, T>` — never `Map`/`Set` (RTK + Immer limitation).

Full allowlist of webview-local state: see `STATE_CONTRACT.md § Webview-Local State`.

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
2. Handle in reducer (typically delegating to a store slice).
3. Wire the raw backend event → typed Event dispatch in `extension/src/host/session-service/events.ts`.
4. If it affects the transcript, update `extension/src/host/store/transcript-slice.ts`.

### Adding a new ViewState field

1. Add to the `ViewState` interface in `extension/src/shared/protocol.ts`.
2. Populate in `selectViewState` in `extension/src/host/store/index.ts`.
3. Consume in webview components.
4. Update test ViewState literals in `extension/test/sidebar-sync.test.ts` and `extension/test/sync-contract.test.ts`.

### Adding a new Effect type

1. Add variant to `extension/src/host/core/effects.ts`.
2. Add result Event variant to `extension/src/host/core/events.ts`.
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

## 10. Further Reading

- [`docs/STATE_CONTRACT.md`](STATE_CONTRACT.md) — authoritative host ↔ webview invariants
- [`docs/internal/ARCH-OVERVIEW.md`](internal/ARCH-OVERVIEW.md) — concise file map and glossary
- [`AGENTS.md`](../AGENTS.md) — repo conventions, test commands, build instructions
- [`docs/internal/archive/ARCH-MIGRATION-PLAN.md`](internal/archive/ARCH-MIGRATION-PLAN.md) — original migration plan (phases 0–7)
