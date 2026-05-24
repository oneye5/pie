# Architecture Migration Plan — CQRS-shaped Elm/MVI

**Audience:** implementation agent (worker)
**Status:** draft
**Authoritative contract:** `docs/STATE_CONTRACT.md` (extend; do not contradict)

---

## 0. Purpose

The extension currently runs a partially-formed Flux/Redux architecture with significant drift: a second unused signals store, an aspirational doc (`CHAT_UI_ARCHITECTURE.md`) that does not match reality, and a mounted webview path (`app.tsx`) that holds substantial logic state locally. This causes the pain points enumerated in §1.

This plan migrates the system to a **CQRS-shaped Elm/MVI** pattern, incrementally, with each phase independently mergeable and verifiable.

**Non-goals:**
- Rewriting the backend or PI SDK integration shape.
- Changing the on-disk session format.
- Replacing Preact, Redux Toolkit, or VS Code webview transport.
- Re-skinning UI.

---

## 1. Target shape (one paragraph)

Host owns a single Redux store. All mutations flow through a reducer keyed off a discriminated `Msg` union sourced from: (a) `Command`s posted by the webview, (b) typed backend `Event`s from PI, (c) `EffectResult` messages from the effect runner. Side effects are returned from reducers as plain `Effect` descriptors and executed by a single effect runner that feeds results back as `Msg`. The webview holds only ephemeral render state (scroll, focus, hover); everything else is a projection of host state, delivered as session-addressed `Patch`es with revisioned full-snapshot recovery (per `STATE_CONTRACT.md`).

---

## 2. Glossary (terms used in this doc)

- **Command** — webview → host intent. Carries `corrId` for correlation. Replaces the action-shaped variants of today's `WebviewToHostMessage`.
- **Event** — host-internal `Msg` fed to the reducer. Sources: commands, backend events, effect results, timers.
- **Effect** — plain data describing a side effect the reducer wants performed (e.g. `{ kind:'SendRpc', sessionPath, corrId, payload }`). Never executed inside the reducer.
- **EffectRunner** — single host-side dispatcher that executes `Effect`s and feeds results back as `Event`s.
- **Projection** — pure function `State → ViewState[sessionPath]`. Today's `selectViewState` is the seed.
- **Patch** — wire-format diff of a `ViewState` for a specific `sessionPath`. Today's `PatchOp` extended with `sessionPath`.
- **Mirror** — webview-side cache of `ViewState` per `sessionPath`, kept in sync via `Patch`/`Snapshot`.

---

## 3. Invariants (must hold after every phase)

1. The reducer is pure: `(State, Msg) → { state, effects }`. No I/O, no `Date.now()`, no random.
2. Side effects only happen inside the EffectRunner.
3. Webview never mutates logic state directly — it dispatches `Command`s and applies `Patch`/`Snapshot`.
4. Every `Patch` and session-scoped backend event carries an explicit `sessionPath`.
5. Optimistic state is tagged with `corrId` and reconciled by matching `EffectResult`.
6. Background-tab patches are not dropped; they update that tab's mirror.
7. `STATE_CONTRACT.md` invariants continue to hold (selection ownership, snapshot recovery, serialized ordering, cleanup).
8. Each phase leaves the build green and all tests passing. `npm run test` is the canonical gate.

---

## 4. Phases

Each phase is independently mergeable. Do not start phase N+1 until phase N's exit criteria are met and reviewed.

### Phase 0 — Doc reconciliation & dead-code removal

**Why first:** removes drift that will otherwise confuse every subsequent step.

**Framing note for the agent:** The mounted webview path is `panel.tsx → app.tsx`. The signals store under `extension/src/webview/panel/store/` (`dispatch.ts`, `session-store.ts`, `signals.ts`, `index.ts`) **exists in the repo but is never imported by the mounted path** — only by its own tests. `docs/CHAT_UI_ARCHITECTURE.md` accurately describes the signals store; it just describes code that was never wired up. That is the drift Phase 0 resolves.

**Tasks:**
1. Read `docs/CHAT_UI_ARCHITECTURE.md` end-to-end. Identify claims about runtime behavior that the mounted `app.tsx` path does not exhibit.
2. Either delete `docs/CHAT_UI_ARCHITECTURE.md` outright, or rewrite it as a *target-state* doc that points to this plan. Do not leave it claiming current behavior it does not have.
3. Verify via grep that no file outside `extension/src/webview/panel/store/` and outside `extension/test/` imports from `webview/panel/store`. Expected result: zero matches in mounted code.
4. Delete the entire `extension/src/webview/panel/store/` directory.
5. Delete `extension/test/webview-store-dispatch.test.ts`. **This is an explicit, sanctioned exception to the §7 "test count drops" stop condition** because the deleted tests exclusively exercise dead code that is also being deleted. Note this exception in the PR description.
6. Do **not** delete `extension/src/webview/panel/overlay.ts` in this phase, even though the signals store imports `Overlay`/`emptyOverlay` from it. `overlay.ts` has other live consumers (`app.tsx`, `stream-smoother.ts`) and is removed in Phase 5.
7. Update `docs/INDEX.md` to point at this plan and remove references to deleted docs/files.

**Exit criteria:**
- `extension/src/webview/panel/store/` no longer exists.
- `extension/test/webview-store-dispatch.test.ts` no longer exists.
- `grep -rn "webview/panel/store" extension/src extension/test` returns no results.
- `npm run test` passes (with the documented test-count reduction explained in the PR).
- `npm run typecheck` passes.

**Risks:**
- If grep at task 3 finds mounted-code references, stop and report — do not force deletion.

---

### Phase 1 — Protocol: session-addressed patches

**Why:** unlocks per-tab mirrors and removes the `isActiveSession` guards that cause background-tab data loss.

**Tasks:**
1. In `extension/src/shared/protocol.ts`:
   - Add required `sessionPath: string` to the patch envelope (preferred over per-op tagging because all ops in one envelope address the same session). Document the choice with a code comment.
   - Add required `sessionPath` to every session-scoped variant of `HostToWebviewMessage` that does not already have it.
   - **Change `{ type: 'requestSnapshot' }` to `{ type: 'requestSnapshot', sessionPath?: string }`.** When `sessionPath` is provided, the host replies with a snapshot for that session only. When omitted, the host replies with a global snapshot (all sessions + global state) — used on first connect or `hostInstanceId` change. Update `extension-host.ts`'s `requestSnapshot` handler accordingly: route to either `postState(sessionPath)` or `postState()` (all). Add the corresponding global-vs-session snapshot variants to the host → webview message types.
   - Bump a `PROTOCOL_VERSION` constant if one exists; if not, add one and have the webview log a warning on mismatch.
2. Update `extension/src/host/session-service/events.ts`:
   - Remove every `isActiveSession(sessionPath)` guard around patch emission (search lines ~277, 297, 336, 369, 401, 425).
   - Every patch emitted now carries its originating `sessionPath`.
3. **Per-session revision tracking redesign** (`sidebar-provider.ts` / `sidebar-sync.ts`):
   - Change `SidebarSyncState` from `{ revision: number; hostInstanceId: string; dirty: boolean }` to `{ hostInstanceId: string; sessions: Record<string, { revision: number; dirty: boolean }> }`. The `hostInstanceId` stays global; revision and dirty are per-session.
   - `buildPatchEnvelope(sessionPath, ops)` advances `state.sessions[sessionPath].revision` only. Envelopes from session A and session B advance independently.
   - The webview side currently keeps `lastRevisionRef` as a single number; change it to `Map<sessionPath, number>` (or `Record<sessionPath, number>`). Out-of-order detection becomes per-session.
   - Dirty-stream recovery (`flushDirtySnapshot`): when a specific session's stream is marked dirty, the next host-to-webview sync for **that session** is a full snapshot; other sessions are unaffected. Existing global recovery on `hostInstanceId` change is preserved (forces snapshot of every session).
   - Closing/invalidating a session removes its entry from `state.sessions` and from the webview's revision map. This must be wired into the existing cleanup path (`clearSessionScope`).
4. **Webview mirror shape.** `ViewState` currently mixes per-session fields (transcript, busy, pendingInputs, systemPrompts) with global fields (`sessions` summaries list, `openTabPaths`, `activeSessionPath`, `notice`, `backendReady`, prefs). Split the mirror into:
   - `globalMirror: GlobalViewState` — holds the global fields. Updated by global-scoped patches (envelope with no `sessionPath`) or by the global snapshot.
   - `sessionMirrors: Map<sessionPath, SessionViewState>` — one entry per open session. Updated by session-addressed envelopes.
   Define `GlobalViewState` and `SessionViewState` explicitly in `protocol.ts` by splitting today's `ViewState`. The composed `ViewState` consumed by render is `{...globalMirror, ...sessionMirrors.get(activeSessionPath)}`. Patches MUST target exactly one of `global` or a specific `sessionPath` — mixing is a protocol defect.
5. Active-session rendering composes from `globalMirror` + `sessionMirrors.get(activeSessionPath)`. Tab switching is a pure `activeSessionPath` change in `globalMirror` followed by a re-compose; no host round-trip required.
6. Audit `resolveSessionOpenedTranscript`: the parts that exist *only* to compensate for missed background patches can be removed; the parts that handle legitimate snapshot-vs-optimistic reconciliation (busy refresh while the user has uncommitted optimistic state) must be preserved. Document which is which inline in the PR description.

**Exit criteria:**
- Switching tabs renders instantly from the existing mirror with no host round-trip required for transcript data.
- A streaming reply continues to update its session's mirror while a different tab is active. Verify by sending a message in tab A, switching to tab B mid-stream, switching back to tab A; the full streamed content must be present without any reload.
- `STATE_CONTRACT.md` updated: add a clause that patches are session-addressed; per-session revisions and dirty state; mirrors persist across tab switches until session close/invalidate.
- New tests required (all must pass):
  - `patch_envelope_addresses_session` — envelope built for session A only mutates `mirrors[A]`, leaves `mirrors[B]` untouched.
  - `revision_advances_per_session` — patches to A do not advance B's revision counter.
  - `dirty_stream_per_session` — marking A dirty does not force B to take a snapshot.
  - `background_stream_preserved` — simulates the manual scenario above with a fake backend.
- `npm run test` and `npm run typecheck` pass.

**Risks:**
- Memory: keeping all open tabs' transcripts in webview memory. Verify against existing tab-count expectations; typical case is <10 tabs, transcripts are bounded by `transcriptWindow`.
- Snapshot recovery semantics: if a mirror is dirtied for a non-active session, the existing dirty-snapshot fallback must still work. Do not change snapshot semantics — only addressability.

---

### Phase 2 — `Command` / `Event` / `Effect` type spine

**Why:** establishes vocabulary before refactoring call sites.

**State-shape note (applies to all later phases):** Host state lives in Redux Toolkit slices, which use Immer. Immer does not handle `Map`/`Set` mutations in draft state without explicit opt-in, and RTK's serializable-state middleware rejects them by default. **Use plain `Record<string, T>` for keyed collections in host state.** `Map` is fine inside the webview (no Immer/serializable constraints there). If a future need genuinely requires `Map` in host state, that is a deliberate decision requiring `enableMapSet()` opt-in and a justification — not a default.

**EffectRunner contract (binding for all later phases):**
- Effects are executed by a single `EffectRunner` class instantiated once at extension activation, holding references to `BackendClient`, `SessionServiceState` (for the queues), and VS Code globalState.
- **The EffectRunner must mirror the legacy two-level queue routing exactly** so that during the multi-phase migration, new-path effects and legacy-path actions remain mutually serialized:
  - For every `Effect` whose `kind` ends in `Rpc` (`SendRpc`, `EditRpc`, `InterruptRpc`, `TruncateRpc`), the runner calls `enqueueLifecycle(() => enqueueSessionOperation(sessionPath, () => doRpc()))` — the **same double-wrap** that today's `message-actions.ts` uses. This is required because Phase 3 migrates only `interrupt`; legacy `send`/`edit` still go through the same `enqueueLifecycle → enqueueSessionOperation` path, and the two must interleave correctly.
  - Lifecycle effects (`OpenSession`, `CreateSession`) use `enqueueLifecycle(...)` directly (no inner session queue, since the session may not exist yet).
  - Non-session effects (`PersistTabs`, `Log`) execute directly without queueing.
  - Once Phase 4 has migrated `send`/`edit` and there are no remaining legacy direct callers of `enqueueLifecycle`, the outer `enqueueLifecycle` wrap on per-session RPCs MAY be removed in a follow-up cleanup — but only after confirming via grep that no legacy path remains. Until then, the double-wrap stays.
- Every effect, on completion or failure, posts an `Event` (typically named `XxxResult`) back to the reducer via the runner's `dispatch` callback.
- The runner never inspects or modifies state; it only consumes `Effect`s and produces `Event`s.
- **No re-entrant blocking.** An `EffectResult` handler in the reducer may freely return new effects, but those effects are queued asynchronously by the runner; the reducer must not synchronously await another effect. Concretely: effect execution is `Promise`-based and result-dispatch goes through the normal `dispatch(event)` path, which schedules a microtask. This avoids any possibility of queue starvation or deadlock from a lifecycle effect waiting on a session effect waiting on a lifecycle effect.
- **Selection token forwarding.** Effects that wrap session lifecycle RPCs (`OpenSession`, `CreateSession`) carry `selectionToken` and pass it through unchanged to `BackendClient`. The reducer never invents tokens; tokens originate from the same source as today (the lifecycle queue's selection bookkeeping in `SessionServiceState`).

**Tasks:**
1. Create `extension/src/host/arch/` directory with:
   - `commands.ts` — `Command` discriminated union. Migrate the action-shaped variants from `WebviewToHostMessage`. Each carries `corrId: string` and `sessionPath` where applicable.
   - `events.ts` — `Event` discriminated union. Includes: every `Command` (wrapped as `{kind:'Command', cmd}`), every backend event type, every `EffectResult` variant, internal timer/lifecycle msgs.
   - `effects.ts` — `Effect` discriminated union. Starts with: `SendRpc`, `EditRpc`, `InterruptRpc`, `TruncateRpc`, `OpenSession`, `CreateSession`, `PersistTabs`, `Log`. Extend as needed.
   - `reducer.ts` — top-level `(state, event) => { state, effects: Effect[] }`. Initially delegates to existing Redux slices; new code lands here.
   - `effect-runner.ts` — implements the EffectRunner contract above.
2. Do **not** rewire existing code paths in this phase. Only define the types and a runner that no code calls yet.
3. Write unit tests for the reducer skeleton (empty state + a no-op `Event` returns unchanged state + no effects) and for the EffectRunner's routing decisions (e.g., `InterruptRpc` is enqueued via the session operation queue; verify with a spy on `enqueueSessionOperation`).

**Exit criteria:**
- New types exist, compile, and are exported.
- `npm run test -- --package extension` passes.
- No existing code imports the new types yet (verify via grep).

**Risks:**
- Bikeshedding on names. Resolution: match the glossary in §2; do not invent new terms.

---

### Phase 3 — Route one command through the new spine (vertical slice)

**Why:** prove the pattern works end-to-end on the smallest viable scope before mass migration.

**Pick:** `interrupt`. It has the smallest surface area, no optimistic update, no streaming interaction. **However**, today's `interrupt` is serialized through `enqueueLifecycle → enqueueSessionOperation` (`message-actions.ts`). This phase MUST preserve that serialization — the EffectRunner routes `InterruptRpc` into the per-session operation queue (as specified in Phase 2). Failing to do so introduces a race between an in-flight `send`/`edit` and an interrupt that was previously impossible.

**Tasks:**
1. Define `Command{kind:'Interrupt', corrId, sessionPath}` and `Effect{kind:'InterruptRpc', corrId, sessionPath}` and `Event{kind:'InterruptResult', corrId, ok, error?}`.
2. Webview posts the new `Command` shape (keep the old shape too for now, or alias — choose minimum churn).
3. `extension-host.ts` dispatch: when it sees the interrupt command, route it through the new reducer + effect runner instead of calling `message-actions.interruptMessage` directly.
4. Reducer for `Interrupt`: sets `state.sessions[sessionPath].interruptInFlight = true`, returns `[InterruptRpc(...)]`.
5. Effect runner executes `InterruptRpc` using the **double-wrap routing specified in the Phase 2 EffectRunner contract** (`enqueueLifecycle(() => enqueueSessionOperation(sessionPath, () => doRpc()))`). This is what guarantees interrupt FIFO-orders correctly with respect to legacy `send`/`edit` paths that still call `enqueueLifecycle` directly. Result is posted back as `Event{kind:'InterruptResult', ...}`.
6. Reducer for `InterruptResult`: clears the flag, logs on failure.
7. Add tests:
   - Reducer test: `Interrupt` returns expected state + single effect.
   - Reducer test: `InterruptResult{ok:false}` clears flag and produces a `Log` effect.
   - Integration test: end-to-end through the host with a fake backend client.
   - **Serialization test:** queue `SendRpc(A)` then immediately `InterruptRpc(A)`; assert send executes before interrupt (FIFO), and that interrupt does not race ahead.

**Exit criteria:**
- Interrupt works in the running extension (manual smoke test documented in PR description).
- All existing tests still pass; new reducer tests added.
- Old `interruptMessage` function in `message-actions.ts` is deleted or marked deprecated with a comment pointing to the new path.

**Risks:**
- Discovering the new shape doesn't fit. If so, stop and revise this plan before proceeding to phase 4.

---

### Phase 4 — Migrate optimistic mutations (`send`, `edit`)

**Why:** this is where the bulk of the complexity lives; doing it after the spine is proven de-risks the largest refactor.

**Tasks:**
1. Add reducer support for an optimistic table: `state.pending: Record<string, PendingOp>` (keyed by `corrId`) where `PendingOp` is `{kind:'send'|'edit', sessionPath, snapshot}` with whatever fields are needed to roll back. **Plain `Record`, not `Map`** — see Phase 2 state-shape note.
2. Reducer for `Command{kind:'SendMessage'}`:
   - Insert pending user message into transcript, tagged with `corrId`.
   - Record entry in `state.pending`.
   - Return `Effect{kind:'SendRpc', corrId, ...}`.
3. Reducer for `Event{kind:'SendRpcResult', ok, corrId, ...}`:
   - On ok: promote pending → authoritative (clear `corrId` tag, finalize id if backend returned one).
   - On failure: revert via `state.pending[corrId].snapshot`, drop entry.
4. Same shape for `Edit`.
5. **Delete the event-buffering window** in `backend-client.ts`. The buffer spans **five locations**, all of which must be removed together or TypeScript will fail to compile:
   1. Field declarations: `bufferedEvents`, `bufferedEventDepth`, `bufferedEventFlushTimer` in the class body.
   2. The `shouldBufferEvents` branch inside `request()` (the window most visibly around lines 196–277).
   3. The `bufferedEventDepth > 0` guard inside `handleLine()` that diverts events into the buffer.
   4. The entire `flushBufferedEventsLater()` private method.
   5. Reset/cleanup statements in **both** `stop()` and `dispose()` (`this.bufferedEvents = []`, `this.bufferedEventDepth = 0`, `clearTimeout(this.bufferedEventFlushTimer)`).
   Locate each via `grep -n "buffered\(Events\|EventDepth\|EventFlushTimer\)\|flushBufferedEventsLater\|shouldBufferEvents" extension/src/host/backend-client.ts` before editing.
   
   The reducer now handles arrival order explicitly: if a `DeltaArrived` event arrives for a turn before `SendRpcResult`, the reducer applies it normally (the pending user message is already in the transcript, so assistant deltas append after it).
6. Add tests covering: send-then-success, send-then-failure, send-then-delta-before-ack, send-then-delta-after-ack, edit-truncate-then-stream.

**Exit criteria:**
- All optimistic logic in `session-service/message-actions.ts` and reconciliation logic in `session-service/session-opened-transcript.ts` related to optimistic merging is either deleted or reduced to glue that calls the reducer.
- `backend-client.ts` no longer buffers events around RPCs.
- New tests pass; existing tests pass or are updated with justification in commit message.

**Risks:**
- This is the highest-risk phase. The arrival-order test cases above are mandatory before merging. If any cannot be made to pass cleanly, stop and revise the plan.

---

### Phase 5 — Migrate transcript-affecting backend events through reducer

**Why:** with the spine and optimistic flow in place, streaming and tool events become trivial.

**Preflight (mandatory, must complete before task 1):**

Verify the `pruning-result` data contract before relying on it. `ChatMessage.customDetails` is typed `unknown` in `protocol.ts`. Inspect the live shape:
1. Read `extensions/skill-pruner/index.ts` around the `customType: "pruning-result"` emission. Confirm exactly which fields are placed on `customDetails`.
2. Read `extension/src/backend/transcript.ts` to confirm those fields survive the backend mapping.
3. Compare against what `parsePruningResult` in `host/store.ts` extracts from `message.markdown` (currently: summary/banner text).
4. If `customDetails` does **not** contain everything the banner needs, the regex parse cannot be deleted in this phase — extend `customDetails` in the skill-pruner extension first (a small Phase 5a sub-step) and add a protocol-validation test before continuing.
5. Type the `customDetails` field properly in `protocol.ts` (a discriminated union keyed by `customType`) so subsequent reducer code is type-safe.

**Tasks:**
1. Wrap every backend event (`message.delta`, `message.thinking`, `message.created`, `message.finished`, `message.aborted`, `tool.started`, `tool.progress`, `tool.finished`, custom messages including `pruning-result`) as an `Event` and route through the reducer.
2. Reducer applies the transcript mutation; projection diff produces the patch.
3. **Delete the webview overlay system.** The files and call sites are:
   - `extension/src/webview/panel/overlay.ts` (note: at `panel/`, **not** `panel/transcript/`).
   - `StreamSmoother` coupling to the overlay (`extension/src/webview/panel/stream-smoother.ts`).
   - `overlay` prop fanout through `TranscriptVirtualList` → `TranscriptVirtualRow` → `MessageItem` (paths under `extension/src/webview/panel/transcript/`).
   - `MessageItem` reads message content directly; no overlay merge.
4. **Replacement for `clearOverlay` semantics.** Today, `events.ts` `onMessageFinished` emits an explicit `{ kind: 'clearOverlay', messageIds: [...] }` patch op to signal that streaming buffers for a message can be discarded. Under the reducer model this signal becomes implicit: when a `MessageFinished` event arrives, the reducer replaces the streaming entry with its authoritative form, and the resulting projection diff naturally produces a content-replacement patch. Document this transition in a code comment at the call site; add a regression test (`message_finished_replaces_streaming_content`) that asserts the final message content is the authoritative one even if late deltas arrive after `MessageFinished`.
5. Reducer absorbs assistant-turn aliasing logic from `transcript-slice.ts` (the alias-tracking section).
6. Collapse the dual pruning representation: the reducer produces one structured marker from typed `customDetails`; the banner in `host/store.ts` becomes a projection over markers. Delete `parsePruningResult` and its regex.
7. Update test files that import from the deleted overlay module. The known consumers are:
   - `extension/test/session-events.test.ts` (imports `applyPatch`, `emptyOverlay`)
   - `extension/test/stream-smoother.test.ts` (imports `Overlay`)
   - `extension/test/webview-render.test.ts` (imports `emptyOverlay`, uses `overlay` prop)
   Either rewrite each to test the new projection-based equivalent or delete tests that exclusively exercise overlay mechanics that no longer exist. Document each decision in the PR.
8. Also remove or rewrite the stale code comment `extension/src/webview/panel/store/session-store.ts:37` (`/** Legacy overlay compat — will be removed in Phase 8. */`) — it refers to a *different* plan's numbering and will mislead readers. (Note: the entire `store/` directory was deleted in Phase 0, so this should already be moot. Verify.)

**Exit criteria:**
- `grep -rn "overlay" extension/src/webview --include="*.ts" --include="*.tsx"` returns no results in production code. (CSS comments mentioning "overlay" in `.css` files are unrelated and out of scope.)
- Streaming visually unchanged from a user perspective; verify via manual smoke test of a multi-tool-call streaming reply, documented in PR with before/after observations.
- Pruning banner still displays correctly; its data source is typed `customDetails`, not regex.
- All tests pass; new tests required: streaming patch idempotency, pruning marker → banner projection, tool lifecycle ordering, `message_finished_replaces_streaming_content`.

**Risks:**
- Visual regressions from removing the smoother. If streaming feels jankier, re-introduce smoothing as a *view-layer* concern (render throttling in the transcript component), not as a separate data structure.

---

### Phase 6 — Move webview logic state into host reducer

**Why:** completes the pattern. `app.tsx` becomes a thin dispatcher + renderer.

**Tasks:**
1. Audit `app.tsx` and enumerate every `useState`/`useRef` that holds **logic** state (not pure render state like scroll/focus/hover). Expected candidates: editing state, draft state, menu open state, dialog state, model-picker state.
2. For each: add corresponding fields to host `State`, corresponding `Command`s (e.g., `OpenEditMenu`, `SetDraft`), update reducer and projection.
3. Webview reads these from `ViewState`; mutations go through commands.
4. Pure render state (scroll position, hover, focus rings, transient animations, IME composition) **stays in the webview**. Document this distinction in `STATE_CONTRACT.md`.
5. Extract the in-file `ContextMenu` component (~55 LOC) and any other in-file component bodies into their own files under `extension/src/webview/panel/components/`. This is required to hit the LOC target and is in scope for this phase.
6. **Webview-local state allowlist (replaces the previous 16ms latency rule).** The following state MUST remain webview-local because round-tripping it introduces user-perceptible jank or breaks browser semantics:
   - Scroll position, scroll-into-view requests.
   - Focus/blur, selection range inside inputs/textareas.
   - Hover state, pointer position.
   - IME composition state (`compositionstart`/`compositionend`).
   - Transient animations and CSS-driven UI (menu open/close transitions).
   - Per-keystroke draft buffer **inside an active input** (the *committed* draft on blur/send/tab-switch is host state; the live keystroke buffer is not).
   - **Protocol-sync and transport bookkeeping** — `lastRevisionRef` (now per-session per Phase 1), `awaitingSnapshotRef`, `hostInstanceIdRef`, pending-draft-restore tracking, in-flight `corrId` set for UI gating. These are not application state; they are bookkeeping for the message-passing transport and stay webview-local.
   - **Derived UI telemetry** — token-rate measurement state (`tokenRateRef`, `tokenRateState`), FPS counters, render-timing buffers. These are computed-from-stream and discarded on each render cycle; host has no use for them.
   Any candidate not on this list moves to host state. If during implementation the agent identifies a state that *should* be on this list but isn't, stop and report — do not silently expand the allowlist.

**Exit criteria:**
- `app.tsx` contains no `useState`/`useReducer` for logic state — only the webview-local allowlist categories.
- `STATE_CONTRACT.md` has a new section "Webview-local state" enumerating the allowlist verbatim.
- Tab switching, edit menu, draft preservation work across tab switches without bespoke webview code.
- All tests pass.
- LOC target: `app.tsx` < 250 LOC after `ContextMenu` extraction. (Initial draft of this plan claimed 200; corrected because the import block, render shell, and unavoidable plumbing total ~80 LOC even fully migrated.)

---

### Phase 7 — Documentation finalization (internal)

**Tasks:**
1. Update `docs/STATE_CONTRACT.md` with everything added across phases (session-addressed patches, per-session revisions, optimistic reconciliation via `corrId`, webview-local state allowlist, reducer purity invariant, effect-runner serialization routing).
2. Write `docs/internal/ARCH-OVERVIEW.md`: a developer-onboarding doc with the diagram from §5 below, the glossary from §2, and the locations of `commands.ts`/`events.ts`/`effects.ts`/`reducer.ts`/`effect-runner.ts`.
3. **Archive this migration plan to `docs/internal/archive/ARCH-MIGRATION-PLAN.md`** (do not delete). Future retrospectives and incremental rollbacks may need to consult the original sequencing and rationale.

**Exit criteria:**
- `docs/STATE_CONTRACT.md` reflects the implemented architecture without contradicting any production code path.
- A new contributor can read `ARCH-OVERVIEW.md` and find any of the five spine files within 30 seconds.
- This plan is in `docs/internal/archive/`, not deleted.

---

### Phase 8 — Public architecture document (`docs/ARCHITECTURE.md`)

**Why:** the codebase needs a single entry-point document that both human contributors and AI agents can read to understand the system's architecture without tracing code. `docs/internal/ARCH-OVERVIEW.md` (Phase 7) is an implementation-focused file map; this document is the *conceptual* explanation of how and why the system works the way it does.

**Target audience:** a developer (human or agent) who has never seen the codebase and needs to:
- Understand the overall information flow in under 5 minutes of reading.
- Know *where* to make a change for any given category of work.
- Avoid violating architectural invariants by accident.

**Location:** `docs/ARCHITECTURE.md` (top-level in `docs/`, not `internal/`).

**Required sections:**

1. **System overview** — one-paragraph summary of what the extension does and the three processes involved (PI backend, VS Code extension host, webview).

2. **Architecture pattern** — name the pattern (CQRS-shaped Elm/MVI) and explain in 3–5 sentences why it was chosen. Link to this migration plan in `docs/internal/archive/` for historical context.

3. **Information flow diagram** — the §5 reference diagram from this plan, annotated with the file paths that implement each box (e.g., "Reducer → `extension/src/host/arch/reducer.ts`"). Must be copy-pasteable ASCII art, not an image.

4. **Key concepts** — concise definitions (2–3 sentences each) of: Command, Event, Effect, EffectRunner, Projection, Patch, Snapshot, Mirror, GlobalViewState, SessionViewState. For each, name the canonical source file.

5. **Data flow scenarios** — 3–4 concrete end-to-end traces showing how information flows for representative operations:
   - User sends a message (optimistic insert → RPC → ack/rollback → streaming reply).
   - Streaming assistant reply (backend event → reducer → patch → webview mirror → render).
   - Tab switching (webview command → global state update → re-compose from existing mirror).
   - Extension-driven transcript mutation, e.g. pruning (backend custom event → reducer → structured marker → banner projection).
   Each trace should name the actual files/functions involved at each step.

6. **Boundaries and contracts** — describe the two process boundaries (host↔PI, host↔webview), what guarantees each provides (serialization, revision-based delivery, snapshot recovery), and point to `docs/STATE_CONTRACT.md` as the authoritative invariant list.

7. **State ownership rules** — where state lives, who can mutate it, and what the webview is allowed to own locally (reference the allowlist from Phase 6). Explicit statement: "If you're unsure whether something is host state or webview state, it's host state."

8. **Extension points** — how to add a new Command, a new Effect, a new backend event type, or a new projection field. Brief recipe (5–10 steps) for each, naming the files to touch.

9. **Invariants** — the §3 invariants from this plan, restated as permanent architectural rules (not migration-phase-specific). Link to `STATE_CONTRACT.md` for the full set.

10. **Further reading** — links to `docs/STATE_CONTRACT.md`, `docs/internal/ARCH-OVERVIEW.md` (file map), `AGENTS.md` (repo conventions), and the archived migration plan.

**Writing guidelines:**
- Assume the reader has zero prior context about this codebase but is technically competent.
- Use concrete file paths, not vague references ("the reducer" → "`extension/src/host/arch/reducer.ts`").
- Keep total length under 400 lines. Prefer diagrams and tables over prose where possible.
- Do not duplicate `STATE_CONTRACT.md` content — reference it.
- Do not describe implementation details that are likely to drift (e.g., specific line numbers). Describe structural invariants and file responsibilities.
- Write for scanning: use headers, bullet lists, and bold key terms. An agent should be able to `grep` for a concept and land on the right section.

**Exit criteria:**
- `docs/ARCHITECTURE.md` exists and contains all 10 required sections.
- Every file path referenced in the document exists in the repo (verify with `find`).
- The document does not contradict `docs/STATE_CONTRACT.md` or `docs/internal/ARCH-OVERVIEW.md`.
- A cold-start agent given only `AGENTS.md` + `docs/ARCHITECTURE.md` can correctly answer: "Where does streaming text arrive? What file handles it? What is the webview allowed to mutate locally?" (Verify by reading the doc and checking these are explicitly answered.)
- `docs/INDEX.md` updated to list `ARCHITECTURE.md` as the primary architecture reference.
- Total length ≤ 400 lines.

**Risks:**
- Document drift on day one: if any Phase 0–7 deliverable is slightly different from what this section describes, the doc will be wrong before it's merged. Mitigation: write Phase 8 by reading the *actual implemented code*, not by copying from this plan. This plan describes intent; the doc describes reality.

---

## 5. Reference diagram

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

## 6. Verification per phase

After every phase:

1. `npm run test` (canonical, repo root). Coverage gates must hold.
2. `npm run typecheck` in `extension/`.
3. `npm run build` in `extension/` (auto-syncs to installed extension).
4. Manual smoke test of the specific scenario the phase touches, documented in the PR description.
5. `grep` checks specified in the phase's exit criteria.

If any check fails: stop, diagnose root cause, do not advance.

---

## 7. Stop conditions (when to halt and report)

Halt and report to the user, do not proceed autonomously, if:

- Any phase's exit criteria cannot be met after one good-faith attempt.
- Any invariant in §3 is violated by the cleanest design you can find.
- A phase requires changes to `STATE_CONTRACT.md` that *weaken* an existing invariant.
- Test count drops (tests deleted without equivalent replacement).
- Build time or extension cold-start time regresses by more than 20%.

---

## 8. Out of scope for this plan

- Backend (PI process) refactoring beyond the event-type surface.
- Replacing Redux Toolkit with a different state library.
- Webview framework changes (Preact stays).
- New features. This is a behavior-preserving migration.
