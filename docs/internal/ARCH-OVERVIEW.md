# Architecture Overview — Developer Onboarding

**Pattern:** CQRS-shaped Elm/MVI
**Authoritative contract:** [`docs/STATE_CONTRACT.md`](../STATE_CONTRACT.md)
**Migration history:** [`docs/internal/archive/ARCH-MIGRATION-PLAN.md`](archive/ARCH-MIGRATION-PLAN.md)

---

## Three Processes

| Process | Role | Entry point |
|---------|------|-------------|
| PI backend | Language model + tool execution | External; communicates via JSON-RPC stdio |
| VS Code extension host | State, effects, projection, webview transport | `extension/src/host/extension-host.ts` |
| Webview (Preact) | Render + user input | `extension/src/webview/panel/app.tsx` |

---

## Spine Files

All core architecture types live in `extension/src/host/core/`:

| File | Responsibility |
|------|----------------|
| `commands.ts` | `Command` discriminated union — intents from webview. Each carries `corrId` + `sessionPath`. |
| `events.ts` | `Event` discriminated union — inputs to the reducer (commands, backend events, effect results). |
| `effects.ts` | `Effect` discriminated union — side-effect descriptors returned by the reducer. |
| `reducer.ts` | Pure function `(ArchState, Event) → { state, effects }`. No I/O. |
| `effect-runner.ts` | Executes effects, posts result events back to reducer. Owns no state. |

Supporting state slices remain in `extension/src/host/store/` (Redux Toolkit + Immer).

---

## Information Flow

```
                       ┌────────────────────────────────────────┐
  Webview Command  ──► │                                        │
  Backend Event    ──► │   Reducer: (State, Event)              │
  EffectResult     ──► │      → { state', effects: Effect[] }   │
  Timer Msg        ──► │   (pure)                               │
                       └──────────┬─────────────────────────────┘
                                  │
                ┌─────────────────┴──────────────────┐
                │                                    │
                ▼                                    ▼
     projection: State → ViewState[s]       EffectRunner executes:
                │                              - RPCs to backend
                ▼                              - persistence
       diff → Patch{sessionPath, ops}          - logging
                │                              results → Event
                ▼
       per-session revision channel
                │
                ▼
       Webview applies to mirrors[sessionPath]
                │
                ▼
       Render active mirror
```

---

## Glossary

| Term | Definition | Source file |
|------|-----------|-------------|
| **Command** | Webview → host intent, carries `corrId` | `host/core/commands.ts` |
| **Event** | Reducer input (command, backend event, or effect result) | `host/core/events.ts` |
| **Effect** | Plain data describing a side effect | `host/core/effects.ts` |
| **EffectRunner** | Executes effects, produces result events | `host/core/effect-runner.ts` |
| **Projection** | `State → ViewState` (currently `selectViewState` in `host/store/index.ts`) | `host/store/index.ts` |
| **Patch** | Session-addressed diff of ViewState | `shared/protocol.ts` |
| **Snapshot** | Full ViewState for recovery | `shared/protocol.ts` |
| **Mirror** | Webview-side cache of ViewState per session | `webview/panel/hooks/use-host-sync.ts` |

---

## Key Invariants

1. The reducer is pure — no I/O, no `Date.now()`, no randomness.
2. Side effects only happen inside the EffectRunner.
3. Webview never mutates logic state directly — it dispatches Commands and applies Patches/Snapshots.
4. Every Patch and session-scoped backend event carries an explicit `sessionPath`.
5. Optimistic state is tagged with `corrId` and reconciled by matching `EffectResult`.
6. Background-tab patches update that tab's mirror; they are never dropped.
7. Host state uses `Record<string, T>` only (no `Map`/`Set` — RTK/Immer constraint).
8. See `STATE_CONTRACT.md` for the full set.

---

## Effect Routing

| Effect category | Queue path |
|-----------------|-----------|
| `*Rpc` (SendRpc, EditRpc, InterruptRpc, TruncateRpc) | `enqueueLifecycle → enqueueSessionOperation(sessionPath, doRpc)` |
| Lifecycle (OpenSession, CreateSession) | `enqueueLifecycle(...)` only |
| Non-session (PersistTabs, Log) | Direct execution, no queue |

---

## Webview State Rules

The webview owns **only** ephemeral render concerns:
- Scroll/focus/hover/drag/animation state
- Protocol bookkeeping (revision refs, snapshot flags)
- Per-keystroke draft buffer (committed draft is host state)
- Token-rate telemetry

Everything else is host state delivered via ViewState. See `STATE_CONTRACT.md § Webview-Local State`.

---

## Where To Make Changes

| Task | Files to touch |
|------|---------------|
| New user action | `commands.ts` → `events.ts` → `reducer.ts` → `effects.ts` (if RPC needed) → `effect-runner.ts` → `extension-host.ts` (dispatch wiring) |
| New backend event | `events.ts` → `reducer.ts` → `store/transcript-slice.ts` (if transcript mutation) |
| New ViewState field | `store/index.ts` (`selectViewState`) → `shared/protocol.ts` (`ViewState`) → webview consumer |
| New effect type | `effects.ts` → `effect-runner.ts` (execution logic) → `events.ts` (result event) |
| New webview component | `webview/panel/components/` → import in `app.tsx` |
