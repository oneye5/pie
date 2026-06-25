# 02 — `extension/src/host/core/` (incl. `reducer/`) — skeptical review

Scope: all of `extension/src/host/core/` and the `reducer/` subfolder. CQRS
spine: `dispatch -> reducer -> Effect[] -> EffectRunner -> *Result Event -> reducer`.
No fixes proposed; issues only.

## Files reviewed (paths + line counts)

Core:
- `extension/src/host/core/dispatch.ts` (26)
- `extension/src/host/core/reducer.ts` (344)
- `extension/src/host/core/arch-state.ts` (377)
- `extension/src/host/core/commands.ts` (359)
- `extension/src/host/core/events.ts` (610)
- `extension/src/host/core/effects.ts` (332)
- `extension/src/host/core/effect-runner.ts` (843)
- `extension/src/host/core/message-router.ts` (663)
- `extension/src/host/core/event-dispatch.ts` (89)
- `extension/src/host/core/projection.ts` (242)
- `extension/src/host/core/composer.ts` (181)
- `extension/src/host/core/model-capability.ts` (46)
- `extension/src/host/core/transcript-helpers.ts` (257)
- `extension/src/host/core/transcript-window.ts` (176)
- `extension/src/host/core/session-opened-transcript.ts` (280)
- `extension/src/host/core/file-change-derivation.ts` (324)
- `extension/src/host/core/file-diff-service.ts` (130)
- `extension/src/host/core/shell-deletion-parsing.ts` (233)
- `extension/src/host/core/restored-session-plan.ts` (60)
- `extension/src/host/core/restored-session-summaries.ts` (38)

Reducer handlers:
- `extension/src/host/core/reducer/helpers.ts` (265)
- `extension/src/host/core/reducer/command-handlers.ts` (230)
- `extension/src/host/core/reducer/command-misc-handlers.ts` (301)
- `extension/src/host/core/reducer/command-session-handlers.ts` (296)
- `extension/src/host/core/reducer/command-tab-handlers.ts` (81)
- `extension/src/host/core/reducer/command-model-handlers.ts` (90)
- `extension/src/host/core/reducer/command-file-handlers.ts` (133)
- `extension/src/host/core/reducer/command-transcript-handlers.ts` (86)
- `extension/src/host/core/reducer/command-composer-handlers.ts` (59)
- `extension/src/host/core/reducer/session-handlers.ts` (638)
- `extension/src/host/core/reducer/streaming-handlers.ts` (262)
- `extension/src/host/core/reducer/result-handlers.ts` (260)
- `extension/src/host/core/reducer/set-model-handlers.ts` (177)
- `extension/src/host/core/reducer/host-handlers.ts` (194)
- `extension/src/host/core/reducer/ui-handlers.ts` (74)
- `extension/src/host/core/reducer/optimistic-handlers.ts` (31)
- `extension/src/host/core/reducer/misc-handlers.ts` (38)
- `extension/src/host/core/reducer/file-handlers.ts` (62)
- `extension/src/host/core/reducer/composer-handlers.ts` (44)

Total ~8,931 LOC.

## Notable issues

### Critical

**C1. Per-session eviction logic is duplicated and has drifted — `handleSessionScopeCleared` leaks `fileChanges.expandedBySession`.**
`reducer/helpers.ts:62-167` (`removeSessionFromState`) and
`reducer/session-handlers.ts:319-433` (`handleSessionScopeCleared`) implement
essentially the same "drop every per-session keyed map for `sp`" operation with
~18 destructure-and-rest cleanups each, hand-rolled in parallel. They diverge:
`removeSessionFromState` clears `fileChanges.expandedBySession`
(`helpers.ts:90,154`) and removes the summary/open/pinned/running/unread/active
arrays; `handleSessionScopeCleared` does **not** clear `expandedBySession`
(grep returns 0 hits in the file) and only touches the tab/active arrays when
`event.removeSessionSummary === true`.
`handleCloseSession` (`command-session-handlers.ts:230-267`) routes through
`handleSessionScopeCleared{removeSessionSummary:false}`, so closing a session
tab leaves `fileChanges.expandedBySession[sp]` dangling forever (per-session
state leak that survives tab close + reopen). Why it matters: two parallel
eviction code paths will keep drifting; the `expandedBySession` leak is a
latent bug that only surfaces as a wrong rail-expanded state after
close/reopen. This should be one helper parameterized by a `{removeSummary,
removeTabs}` flag set.

### High

**H1. `EffectRunner.runRpc` dead arms in `rpcMethodFor` / `rpcParamsFor` / `rpcResultFor`.**
`effect-runner.ts:560-592`: `runRpc` short-circuits `SendRpc`->`runSendRpc` and
`EditRpc`->`runEditRpc` and returns. The generic fall-through path (lines
~578-592) is therefore only reached by `InterruptRpc`, `TruncateRpc`,
`ExtensionUiResponseRpc`. Yet `rpcMethodFor` (789-805), `rpcParamsFor`
(807-820), and `rpcResultFor` (822-843) each contain a `case 'SendRpc'` and
`case 'EditRpc'` arm that can never execute. Confusing for maintainers (a
reader will assume the generic path handles Send/Edit) and a trap: if someone
"fixes" `runSendRpc` to delegate back to the generic path, the
`rpcParamsFor(EditRpc)` arm silently drops `inputs`/`localId`/`messageId` —
which is exactly why `runEditRpc` was split out. Dead code in a switch that
also serves as the exhaustiveness proof undermines the proof's meaning.

**H2. `EffectRunner.run()` is a ~430-line god method with a long if-chain and copy-pasted try/catch blocks.**
`effect-runner.ts:181-548`: one method, ~30 `if (effect.kind === '...')`
branches, each with the identical shape `void (async () => { try { await
deps.X(...); deps.dispatch({kind:'XResult', corrId, ..., ok:true}); } catch
(err) { deps.dispatch({kind:'XResult', corrId, ..., ok:false,
error:toErrorMessage(err)}); } })();`. `FileDiff`, `FileRevert`,
`LoadOlder/Newer/JumpToLatest`, `RecordOutcome`, `StartNewTask`, `ContinueTask`,
`OpenFileInEditor`, `OpenFile`, `SetPruningSettings`, `CloseSession`,
`PersistTabs` are all the same template with the kind string swapped. This is
begging for a dispatch table mapping each kind to the (dep call, result kind,
extra fields) tuple, plus a single wrapper that maps the promise to the
`*Result` event. The boilerplate hides the actual per-effect differences (which
are: which dep method, which result kind, which extra fields). High because
additions currently require adding another 12-line block and the
error-handling shape must be hand-copied correctly each time (one missed
`error:` field = a reducer that can't surface the failure).

**H3. `message-router.ts` reaches past the reducer with direct Event dispatch and ad-hoc render calls — leaky abstraction.**
The router is supposed to translate webview messages into Commands and let the
reducer/runner own state. Instead:
- `onRevertFile` (message-router.ts:558-566) dispatches a `RevertFile` Command
  AND a `FileChangeRemoved` Event directly, then calls `this.scheduleRender()`
  manually. The `FileRevertResult` reducer handler is a no-op
  (`result-handlers.ts:117-119`), so the file-change removal lives in the
  router, not the reducer/runner. The "open = read" side effect is similarly
  composed in the router via `markFileViewedRead` (lines 459-466) dispatching
  an extra `SetFileRead` Command for every `OpenFileDiff`/`OpenFileInEditor`.
- Render triggering is inconsistent: `onRevertFile` and `onSetPruningSettings`
  call `scheduleRender()` (566, 582); `onSend` calls it only on the
  name-derivation path (261); most other handlers call `sidebarProvider.postState()`
  instead (200, 215, 219, 337, 379, 394, 413, 420, 429, 441) — a different
  codepath. There is no documented rule for which to call when.
Why it matters: the contract ("caller schedules render; reducer owns state")
is violated in practice; behavior on whether a given dispatch re-renders
depends on which router method handled it. New handlers will copy whichever
pattern is nearest, entrenching the inconsistency.

**H4. `message-router.ts` type hole: `SidebarProviderLike.postImperative(msg: any): void` (line 15).**
The entire `EffectRunner`/`PostImperativeEffect` machinery was tightened
(`effects.ts:139-160`) so a missing `text` is a compile error, but the router's
narrow `SidebarProviderLike` interface widens it back to `any`. Any caller of
`sidebarProvider.postImperative(...)` in the router escapes the type check the
effect spine deliberately enforces.

**H5. `command-composer-handlers.ts:9` — `as ComposerInput` cast on a `ComposerInputDraft` spread.**
Line 9: `const input: ComposerInput = { ...cmd.input, id: cmd.corrId + ':input' } as ComposerInput;`
`ComposerInputDraft` and `ComposerInput` are deliberately distinct
discriminated unions (draft vs materialized). The cast bypasses the
discriminator check, so a future field added to `ComposerInput` but not to the
draft shape will silently type-check here while producing a runtime-malformed
input that flows into `pendingComposerInputsBySession` and is sent to the
backend. The other materialization path (`composer.ts:
validateAndMaterializeComposerInput`) does this properly field-by-field; this
fast path in the reducer does not.

**H6. `command-misc-handlers.ts:79-187` — `handleSend` has three near-duplicate branches.**
Pending-tab path (82-103), backend-not-ready path (110-130), and normal path
(133-159) each independently: `produce(state, draft => { appendLocalUserMessage(...);
...; delete draft.composer.draftTextBySession[cmd.sessionPath]; })`. The
append + draft-clear logic is repeated verbatim; only the queue/op-write
differs. If the optimistic-message insertion changes (e.g. a new field), all
three must be updated in lockstep — easy to miss one. Extract a shared
`insertOptimisticSendAndClearDraft(draft, cmd, branch)` helper.

### Medium

**M1. `session-handlers.ts:319-433` — `handleSessionScopeCleared` is a ~115-line function with ~18 destructure-with-discards.**
`const { [sp]: _t, ...remainingTranscripts } = ...` repeated for every
per-session map, plus three more `for...of Object.entries(...)` loops to drop
pending ops/setModel/requestIdToLocalId/messageIdAlias. The discard variables
(`_t`, `_sp`, `_w`, `_pf`, `_ed`, `_m`, `_cu`, `_eui`, `_od`, `_ci`, `_rs`,
`_dt`, `_fc`, `_rfr`, `_af`, `_if`, `_psq`, `_brq`, `_ct`) are noise and the
pattern is hostile to adding a new per-session map (you must add a new
destructure line in *both* `removeSessionFromState` and
`handleSessionScopeCleared`, see C1). A single `evictSession(state, sp,
{removeSummary, removeTabs})` helper would collapse both functions.

**M2. `events.ts` categorization is blurry; `BackendEvent` mixes lifecycle with host-side concerns.**
`events.ts:543-559`: `BackendEvent` includes `SessionOpened`, `SessionClosed`,
`CustomMessage`, `ExtensionUIRequest`, `Error`, `BusyChanged`, `BusyCompleted`,
`ContextUsageChanged`, `SessionListChanged` — these are not all "backend
streaming" the way `MessageStarted`/`MessageDelta`/`ToolCall` are. `SessionOpened`
carries a host-orchestrated payload (transcript window, system prompts, model
settings, analytics) assembled by the attach path, not a raw backend event.
Meanwhile `OptimisticMessageInserted`/`Removed`, `FileChangeRemoved`,
`SessionNameDerived` live under `HostEvent` but are optimistic-UI concerns.
The category names don't constrain anything (the top-level `Event` union
flattens them all), so this is mostly documentation, but the mislabeling makes
the reducer routing harder to reason about: a reader expecting
`BackendEvent` to be "things from the wire" will be surprised that
`SessionOpened` is host-built.

**M3. `result-handlers.ts:166` — `handleEffectResult` parameter type is a fragile `Exclude<...>` that duplicates reducer routing.**
`Exclude<EffectResultEvent, {kind:'TruncateResult'} | {kind:'OpenSessionResult'} |
{kind:'CreateSessionResult'} | {kind:'DuplicateSessionResult'} |
{kind:'CloseSessionResult'} | {kind:'PersistTabsResult'} |
{kind:'ModelSwitchConfirmResult'}>`. This list must stay in sync with the
set of `case 'XResult':` branches in `reducer.ts:88-122` that route elsewhere
(reducer.ts:294-319). The `never` default at line 252 makes a missed case a
compile error, so it fails safe, but the coupling is invisible: there's no
comment tying the Exclude list to the reducer's "Result stubs" section. Adding
a new dedicated-handler Result kind requires editing both files in the right
way; forgetting the Exclude entry flows the event into `handleEffectResult`'s
switch and trips the `never` (loud but confusing).

**M4. `reducer.ts:88-122` — the big grouped `case` block delegates 16 result kinds to one function but 7 others are scattered below.**
The reducer has three separate "Result" sections: the grouped
`case 'InterruptResult': ... case 'ExtensionUiResponseResult':` block (all
->`handleEffectResult`), the "Result stubs" section
(`TruncateResult`/`CreateSessionResult`/`DuplicateSessionResult`/`CloseSessionResult`/
`OpenSessionResult`/`PersistTabsResult` -> misc-handlers), and
`ModelSwitchConfirmResult` -> its own handler. There's no header comment
explaining *why* some Result kinds get dedicated handlers and others go
through the generic switch. The split tracks "does the reducer need to
reconcile optimistic state on this result?" but that's not documented, so the
grouping looks arbitrary.

**M5. `command-misc-handlers.ts` (301 LOC, 12 handlers) is a kitchen-sink file.**
It mixes the most critical handlers in the codebase (`handleSend`,
`handleEdit` — the core optimistic-send path) with trivia
(`handleDismissNotice`, `handleSetOutcomeDialog`). The name "misc" suggests
the leftovers pile, but Send/Edit are not misc. This file is the first place a
new engineer looks for "where does sending happen?" and the name misdirects
them. The split into `command-*-handlers` is otherwise by domain
(session/file/tab/model/transcript/composer); `command-misc-handlers` breaks
the pattern and collects everything that didn't fit.

**M6. `message-router.ts:387-393` — `onOpenSession` fires unconditional cleanup Commands for every open.**
`SetEditingMessage{messageId:null}` and `SetOutcomeDialog{visible:false}` are
dispatched on every `openSession` from the webview, even when the session was
never editing and never had the outcome dialog open. Cheap, but it's reducer
work + render work on every tab click for state that's already correct, and it
couples the router to the "opening resets these" policy that isn't expressed
in the OpenSession Command itself. The same pattern repeats in `onCloseSession`
(396-401). If the "reset on open/close" policy changes, two router methods
must update.

**M7. `effect-runner.ts` — three separate dispatch callbacks (`dispatch`, `dispatchCommand`, `dispatchEvent`) into the reducer.**
`EffectRunnerDeps` (lines ~99-130) exposes three different ways for the runner
to feed back into the reducer: `dispatch: (EffectResultEvent) => void`,
`dispatchCommand: (CommandEvent) => void`, `dispatchEvent: (Event) => void`.
The runner uses `dispatchCommand` for `DrainPendingSendQueue` /
`DrainBackendReadyQueue` re-dispatches (430-454, 462-484) and `dispatchEvent`
for `BackendReadyWatchdogFired` (494). The split is documented per-use but the
shape leak (the runner reaches into the Command channel and the generic Event
channel, not just its own Result channel) means the runner is not the "thin
side-effect executor" the doc comments claim — it's a second dispatcher that
can re-enter the reducer with any event kind. Re-entrancy ordering is managed
only by `void (async () => ...)` IIFEs; there's no guard against a future
effect dispatching a Command synchronously and re-entering the reducer mid-loop.

**M8. `transcript-helpers.ts:160-171` — `appendContinuationSeparator` acknowledged to desync parts from aggregates.**
The doc comment on `appendContinuationSeparator` (lines 137-159) explicitly
states: "If a mixed turn has reasoning followed by text (e.g. 'think ->
answer') and the continuation starts with more reasoning, the reasoning
aggregate will carry the '\n\n' separator but the reasoning PART won't. This
is a pre-existing limitation." This means the `message.markdown`/`message.thinking`
aggregate fields and the `message.parts[]` array can diverge, which is
exactly the kind of dual-source-of-truth bug that bites rendering and
tokenization. Acknowledged but unfixed; not a regression, but a known
correctness gap in the streaming merge path.

**M9. `projection.ts:228-237` — inconsistent scoping of `pendingExtensionUIRequests`.**
`pendingExtensionUIRequestsBySession: settings.pendingExtensionUIRequestsBySession`
is returned wholesale (all sessions), while `pendingExtensionUIRequest`
(lines 232-237) is active-session-scoped. Two fields, same domain, different
scoping rules in the same return object. The webview must know to scope the
map itself for non-active sessions. Either scope both or expose a per-session
accessor; the mixed shape is a footgun.

**M10. `file-change-derivation.ts:213-271` — subagent traversal uses ad-hoc structural types cast from `unknown`.**
`SubagentContentPart`/`SubagentMessage`/`SubagentSingleResult`/`SubagentDetails`
(lines 30-55) are locally defined interfaces that mirror the pi-ai protocol by
hand. `result.details as SubagentDetails | undefined` (line 222) is an
unchecked cast — if the real subagent result shape changes (a field renamed,
`results` becomes `singleResult`, etc.), this silently returns `[]` instead
of erroring. The `isRecord` guard only checks object-ness, not shape. Fragile
cross-boundary typing with no compile-time link to the source protocol.

**M11. `session-opened-transcript.ts` — O(n^2) dedup in `mergeIncomingWithEphemeralLocal`.**
`mergeIncomingWithEphemeralLocal` (lines 152-221) loops over `localTranscript`
and, for each ephemeral message, may call
`hasEquivalentIncomingUserAfterLocalPrefix` (which itself loops back through
`localTranscript` and `incomingTranscript.findIndex`) or
`hasEquivalentIncomingAssistantByToolCallIds` (which loops `incomingTranscript`
building a `Set` per message). On a large transcript with many ephemeral local
messages this is O(local x incoming x local). Fine for typical sessions,
pathological for a long-running streaming session reopened with a big
snapshot. No memoization of the incoming index.

### Low

**L1. `handleSendResult` / `handleEditResult` (`result-handlers.ts`) mix `produce` with pre-computed `restOps`.**
`const { [event.corrId]: _removed, ...restOps } = state.pending.ops;` then
`produce(state, draft => { draft.pending.ops = restOps; ... })`. The
destructure happens outside the draft, so the comment in
`handlePendingPathReplaced` ("read BEFORE the produce draft") doesn't apply
here — but the pattern is inconsistent with handlers that delete inside the
draft (`delete draft.pending.ops[event.corrId]`). Two styles for the same
operation across the same file.

**L2. `handleSendResult` failure path uses `pending.text ?? ''` (`result-handlers.ts:78`).**
`PostImperative` `sendRejected` carries `text: pending.text ?? ''`. `PendingOp.text`
is optional and only set for `send` ops (`command-misc-handlers.ts:153`), so the
`?? ''` hides the contract: if a non-send op ever flows through here the
webview gets an empty-text rejection. Defensive but masks a type mismatch
(`text` should be required on send-kind `PendingOp`).

**L3. `reducer.ts:204-208` — `SessionOpened` case has a misleading inline comment.**
`// Kept inline for now (matches handleSessionOpened in session-handlers)`
above `return handleSessionOpened(state, event);` — it's *not* inline, it
delegates. Stale comment from a refactor.

**L4. `event-dispatch.ts:62-119` — switch with no default.**
`dispatchSessionBackendEvent` switches on `event.event` with no `default`
branch and no `never` exhaustiveness check. A new envelope kind from the
backend is silently dropped. Not as safe as the reducer's `never` pattern.
The casts `event.payload as SessionOpenedPayload` (lines 64-119) assume the
envelope discriminator maps to the payload type with no compile-time link.

**L5. `model-capability.ts:33-46` — `getArchState` default throws at call time.**
`getArchState: GetArchState = () => { throw new Error('getArchState not provided'); }`
— the throw is only reachable at runtime, not a compile error, so a caller
that forgets to pass the thunk gets a runtime crash only when
`modelSupportsInputKind` is actually called. A mandatory parameter would be
safer; the default exists only because the reducer passes `() => state`
inline. Minor.

**L6. `commands.ts:273-359` — `Command` union members declared after the union.**
The `export type Command = ...` union (lines 269-309) references
`SetModelCommand`, `HydrateModelCommand`, `SetPrefsCommand`,
`SelectSessionCommand`, etc. that are *declared below* the union (lines
311-359). TypeScript hoists types so it compiles, but the file reads
back-to-front: the union lists 38 kinds, then the definitions follow. A
reader scanning top-down sees the union before any member is defined.

**L7. `projection.ts:235` — reads `state.transcript.editingMessageIdBySession` directly.**
Line 235: `editingMessageId: activePath ? state.transcript.editingMessageIdBySession[activePath] ?? null : null`
— uses `state.transcript...` while every other field uses the destructured
`transcript` (line 70). Inconsistent; minor readability.

**L8. `effect-runner.ts:178` — `OPTIMISTIC_OP_TIMEOUT_MS = 60_000` static, but the timeout message divides by 1000 to render seconds (line 678).**
`this.optimisticOpTimeoutMs / 1000` assumes ms units; the constant is named
`_MS` so it's correct, but the division duplicates the unit knowledge. If
someone changes the constant to seconds the message renders 60,000s.

**L9. `restored-session-summaries.ts:33` — magic string `'New Session'`.**
`isPlaceholder: !restoredName || name === 'New Session'` — hardcoded display
string used as a semantic signal. If the default session name localization or
default changes, the placeholder flag silently flips.

**L10. `file-diff-service.ts:115-127` — `revertFile` swallows git errors and falls through to a "file exists?" probe.**
The catch block (line 121) ignores the specific error and only checks
existence; a permission error, a locked file, or a git failure mode where the
file still exists surfaces as the generic "Could not revert" warning with no
detail. The `exists` probe then treats "file gone" as success even if git
itself failed for a different reason.

## Smaller nits

- `reducer.ts:1-12` docstring says "no mutation of input" but several handlers
  call `produce(state, draft => { ... })` and then return `{ state: nextState,
  effects }` where `nextState` *is* the produce result — fine, but the
  "Immer's produce" mention in the doc only covers transcript mutations; in
  practice `produce` is used for field updates too (e.g.
  `handleDismissNotice`, `handleSetOutcomeDialog`), so the "simple field
  updates continue using spread-operator patterns" claim is inaccurate.
- `dispatch.ts` is a 26-line wrapper that just calls `reducer(state, event)`.
  It exists purely as a "single entry point" indirection; callers could call
  `reducer` directly. Not wrong, just a layer with no behavior.
- `reducer/helpers.ts:5-11` re-exports `ArchState`, `PendingOp`, `CurrentTurn`,
  `createInitialArchState`, `initialArchState` — and `reducer.ts:8-13` re-exports
  the same set again. Two re-export layers for the same types. `initialArchState`
  is also defined as a module-level `const` in *both* `helpers.ts:18` and
  `reducer.ts:25` — two pre-created initial states exist in memory.
- `events.ts` defines `BackendEvent` and `HostEvent` sub-unions but the
  top-level `Event` union (line 561) doesn't reference them by name in a way
  that enforces coverage — `Event = CommandEvent | EffectResultEvent |
  BackendEvent | HostEvent` does, but the sub-unions are otherwise unused
  except documentation. Could be removed or actually consumed.
- `effect-runner.ts:26` imports `PostImperativeMessage` type but only uses it
  in the `PostImperativeSink` interface; the `PostImperative` effect branch
  (line 235) uses `effect.imperativeMessage` which is already typed. Fine.
- `command-handlers.ts` switch has a `default: never` (line 218) plus a Log
  effect on the never path — but the Log uses `corrId: ''` (empty), same as
  `reducer.ts` default. A `Log` effect with empty corrId is a slightly odd
  artifact (the corrId field is required by `EffectBase`).
- `composer.ts:90` `DispatchArchEvent` is re-exported from `model-capability`
  via `composer.ts` — circular-ish re-export chain (`composer` re-exports from
  `model-capability`, `model-capability` imports only a type from
  `arch-state`). Not a cycle, but the re-export path is non-obvious.
- `transcript-window.ts:53-78` `withIncrementedWindowCounts` /
  `withDecrementedWindowCounts` carry a `hasUserMessages` field that is only
  updated in `appendLocalUserMessage` (`helpers.ts:213`), not in the window
  helpers themselves — split responsibility for one field.
- `shell-deletion-parsing.ts:170` env-var assignment skip is applied
  after `sudo`/`env` skip but the regex `\w+=` would also match a path-like
  token containing `=`; edge case, unlikely to bite.
- `file-change-derivation.ts:81-89` `looksLikeFileModifyingTool` includes
  `n === 'bash'` as a separate clause but `looksLikeBashTool` (line 102) lists
  `'bash'` among others — two overlapping definitions of "is bash".

## Architecture assessment

**Reducer handler split:** The `command-*-handlers` split is mostly sensible
(8 files by domain: session/tab/model/file/transcript/composer + the
catch-all `misc`). The event-side split (`session-handlers`,
`streaming-handlers`, `host-handlers`, `ui-handlers`, `optimistic-handlers`,
`misc-handlers`, `result-handlers`, `file-handlers`, `composer-handlers`,
`set-model-handlers`) tracks the `Event` union's sub-categories reasonably.
The fragmentation is *not* arbitrary, with two exceptions: (a)
`command-misc-handlers` (M5) is a genuine kitchen sink; (b) the
Result-handling split across `result-handlers` + `misc-handlers` +
`set-model-handlers` (for `handleSetModelResult`/`handleModelSwitchConfirmResult`)
scatters the "what happens when an effect completes" logic across three
files with no index.

**Oversized files:** `effect-runner.ts` (843) and `session-handlers.ts` (638)
are red flags for the reasons above (H2, M1). `message-router.ts` (663) is
large but cohesive — it's one class with one `switch` + N small private
methods; the size is mostly the per-handler boilerplate, and the real issue
is H3 (leaky dispatch) not size. `events.ts` (610) is a type file; size is
fine but the categorization is muddy (M2).

**Dispatch / effect-runner / events / message-router interaction:** The
spine is cleanly separated at the type level (`dispatch` is pure, `reducer`
is pure, `EffectRunner` is the only side-effect site, `events`/`effects` are
descriptive). The leak is at the *callback* boundaries: the runner reaches
back into the reducer via three dispatch channels (M7) and the router reaches
*around* the reducer via direct Event dispatch + manual render calls (H3).
The reducer itself is genuinely pure and the `never`-exhaustiveness pattern
is consistently applied (reducer.ts, command-handlers.ts,
streaming-handlers.ts, result-handlers.ts, effect-runner.ts) — that part is
solid. State immutability is upheld via Immer `produce` + spread; the one
soft spot is `handlePendingPathReplaced` reading `sendQueueBySession[oldPendingPath]`
before the draft (documented and correct). The biggest correctness risk is
C1 (eviction drift); the biggest maintainability risk is H2 (effect-runner
boilerplate) and H1 (dead switch arms).
