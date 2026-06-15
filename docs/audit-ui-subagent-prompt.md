# Audit: UI & Subagent Systems — Integrity, Duplication, Architecture

**Scope:** The pie VS Code extension UI stack and the subagent extension system, plus their interactions with sibling extensions (ask_user, safeguard, skill-pruner, cwd-skills).

**Goal:** Verify that both systems are working correctly, have no duplicated or dead code paths, and follow the documented architecture. Produce a report of findings with severity (P0/P1/P2) and concrete remediation steps.

---

## Part 1 — UI System Audit (pie Extension)

### 1.1 CQRS Spine Integrity

The architecture is documented in `docs/ARCHITECTURE.md` and `docs/internal/ARCH-OVERVIEW.md`. Verify the spine files in `extension/src/host/core/` are consistent and complete:

- **`commands.ts`** — Every webview-to-host intent has a Command variant. Check that `message-router.ts` maps every `WebviewToHostMessage` type to a Command. Look for message types that are handled ad-hoc in `extension-host.ts` instead of going through the reducer.
- **`events.ts`** — Every Command has a corresponding Event wrapper. Every backend event type has an Event variant. Every Effect has a corresponding result Event. Check for gaps.
- **`effects.ts`** — Every side effect the reducer wants to perform has an Effect variant. Check that `effect-runner.ts` handles every Effect variant (no unhandled cases). Check that the namespace grouping (SessionRpc, SessionLifecycle, FileOperation, Notification, Log) is complete and no effects are mis-categorized.
- **`reducer.ts`** — Every Event variant is handled. Check for default/fallthrough cases that silently swallow events. Verify reducer purity: no I/O, no `Date.now()`, no randomness, no async.
- **`effect-runner.ts`** — Every Effect variant has an execution case. Check that session-scoped RPCs go through `enqueueLifecycle → enqueueSessionOperation` and lifecycle effects go through `enqueueLifecycle` only. Check that non-session effects execute directly.
- **`projection.ts`** — Every field in `ViewState` (defined in `extension/src/shared/protocol.ts`) is populated by the projection. Check for ViewState fields that are never read by the webview (dead fields) and webview components that read fields not in ViewState (missing fields).
- **`backend-event-parser.ts`** — Every raw backend event line type is parsed into a typed Event. Check for unhandled backend event types.

### 1.2 State Contract Adherence

The authoritative contract is `docs/STATE_CONTRACT.md`. Verify:

- **Session addressing** — Every session-scoped backend event carries `sessionPath`. Every mutating RPC carries explicit `sessionPath`. No implicit fallback to active/viewed session.
- **Snapshot/patch recovery** — Per-session revision counters. Full snapshots reset all counters. Patches are session-addressed. Non-active session patches update mirrors without polluting active view. Dirty-session marking is per-session, not global.
- **Execution ordering** — Lifecycle queue serializes create/open. Per-session queue serializes mutations. Optimistic ops are reversible on failure.
- **Webview-local state** — Check that the webview only holds the allowlisted ephemeral state (scroll, focus, drag, animation, protocol bookkeeping, keystroke draft buffer, token-rate telemetry). Look for logic state held in `useState`/`useReducer` that should be in host state.
- **Record-only state** — All keyed collections in host state use `Record<string, T>`. No `Map`/`Set` in `ArchState` or any sub-state.
- **Optimistic reconciliation** — Pending ops tagged with `corrId`, promoted on success, reverted on failure. Check that `state.pending` is cleaned up on session close/invalidate.

### 1.3 Webview ↔ Host Protocol

- **`extension/src/shared/protocol.ts`** — Check that `ViewState` matches what the projection produces and what the webview consumes. Check that `WebviewToHostMessage` covers all webview intents. Check `WEBVIEW_PROTOCOL_VERSION` is incremented on breaking changes.
- **`extension/src/host/sidebar/sync.ts`** and **`provider.ts`** — Verify the snapshot/patch transport. Check that `hostInstanceId` change triggers full webview reset. Check that visibility loss marks sessions dirty and next flush is a full snapshot.
- **`extension/src/webview/panel/hooks/use-host-sync.ts`** — Verify mirror management. Check that per-session mirrors are updated for background tabs. Check that `hostInstanceId` change clears all mirrors.

### 1.4 Dead Code & Duplication

- **Redux remnants** — The architecture migrated from Redux to pure CQRS. Search for any remaining Redux store, slices, selectors, or dispatch patterns in `extension/src/host/`. Check `extension-host.ts` for any state mutations that bypass the reducer.
- **Dual state paths** — Check that no state is mutated both through the reducer and through direct assignment in `extension-host.ts` or elsewhere.
- **Unused exports** — Check `commands.ts`, `events.ts`, `effects.ts` for variants that are defined but never dispatched or handled.
- **Duplicate type definitions** — Check that types aren't defined in both `shared/protocol.ts` and local webview/host files.

### 1.5 Extension Points

Verify the extension-point recipes in `ARCHITECTURE.md §8` are followed for all existing features:

- Every user action follows: Command → Event → Reducer → Effect → EffectRunner → (optional) Result Event → Reducer.
- Every backend event follows: BackendEvent → Event → Reducer → (optional) Effect → EffectRunner.
- Every ViewState field follows: projection populates → protocol defines → webview consumes.

---

## Part 2 — Subagent System Audit

### 2.1 Tool Registration & Lifecycle

Files: `extensions/subagent/src/register.ts`, `extensions/subagent/src/execute.ts`

- **Registration** — Check that the tool registers correctly with the pi SDK. Verify the `description` and `promptSnippet` change when subagents are disabled (`--no-subagent` flag or `PI_SUBAGENT_DISABLED` env var). Verify the disabled path returns an immediate error, not a hang.
- **Parameter schema** — `extensions/subagent/schema.ts` — Check that `SubagentParams` covers all three modes (single, parallel, chain) and all fields (`agent`, `task`, `tasks`, `chain`, `agentScope`, `bucket`, `thinkingLevel`, `cwd`). Verify no field is accepted but ignored.
- **Mode validation** — `validateSubagentParams()` in `execute.ts` — Check that exactly-one-mode is enforced. Check that invalid agent names produce error results, not crashes.

### 2.2 Agent Discovery

Files: `extensions/subagent/agents.ts`

- **Scope resolution** — Check that `agentScope: "user"` (default) discovers from `~/.pi/agent/agents/`. Check that `"project"` discovers from `.pi/agents/`. Check that `"both"` merges both. Verify project agents require confirmation (`confirmProjectAgents`).
- **Agent config parsing** — Check that agent frontmatter (`bucket`, `thinkingLevel`, `model`, `tools`, `systemPrompt`) is parsed correctly. Verify the migration from `defaultScores` to `bucket` + `thinkingLevel` is complete — no remaining `defaultScores` references in agent configs or code.
- **Agent listing in tool description** — Check that the tool description dynamically lists available agents. Verify it handles discovery failures gracefully (omits listing, doesn't crash).

### 2.3 Model Selection (v2 Bucket System)

Files: `extensions/subagent/bucket-selector.ts`, `extensions/subagent/bridge.ts`, `analysis/scripts/stratified-ranker.ts`

- **Bucket selector** — Verify `selectModel()` correctly filters by thinkingLevel, provider allowlist, and excludeModels. Check that uniform random selection is truly uniform. Check fallback to active model when bucket is empty.
- **Bridge** — Verify `getBucketAssignments()` is stateless (no caching). Check that it handles analytics module unavailability gracefully (returns empty assignments).
- **Stratified ranker** — Verify complexity scoring uses the 6 signals with equal weights. Check tercile splitting. Check two-stage ranking (quality composite → cost within tiers). Check best-band assignment. Verify the 40-run bootstrap gate.
- **Provider toggles** — Check that `PIE_PROVIDER_TOGGLES_JSON` env var is read correctly. Verify disabled providers are excluded from the selection pool. Check that the toggle logic is consistent between the bucket selector and `model-resolution.ts`.
- **Retry logic** — Verify `MAX_MODEL_RETRIES = 5`. Check that failed models are added to `excludeModels` and the bucket is re-queried. Check fallback to active model when bucket is exhausted.
- **Old model-selection.ts** — Check if `extensions/subagent/model-selection.ts` still exists. If it does, verify it's fully replaced by `bucket-selector.ts` and can be deleted. Check for any remaining imports of the old selector.
- **`MIN_CAPABILITY_AGGREGATE` temp fix** — If still present, verify it's documented as removable once v2 is operational.

### 2.4 In-Process Session Runner

Files: `extensions/subagent/runner.ts`

- **Session creation** — Verify `createAgentSession` is called with correct parameters (cwd, modelRegistry, model, thinkingLevel, tools, sessionManager, resourceLoader). Check that `noExtensions: false` allows subagent extensions to load (ask_user, safeguard, etc.).
- **Resource loading** — Check that `DefaultResourceLoader` is configured with the agent's system prompt via `appendSystemPrompt`. Verify `agentDir` is set correctly.
- **Parent UI bridge proxy** — Check that `ParentExtensionUIBridgeProxy` is constructed with `parentUiBridge` and `_toolCallId` when both are available. Verify it's injected via `session.extensionRunner.setUIContext(proxy)`. Check that the proxy correctly stamps `subagentCallId` on ask_user requests and delegates to the parent bridge.
- **Event subscription** — Verify the session event subscriber handles `message_update` (text_delta), `tool_execution_start`, `tool_execution_end`, and `message_end`. Check that streaming text is accumulated and cleared correctly. Check that usage stats are recorded per assistant message.
- **Timeout handling** — Verify `SUBAGENT_PROMPT_TIMEOUT_MS` (10 min). Check that the combined abort signal (parent signal + timeout) works correctly. Check that timeout vs parent-abort are distinguished.
- **Depth/trail tracking** — Verify `AsyncLocalStorage` (`subagentRuntime`) correctly tracks depth and trail across nested calls. Check `MAX_DEPTH = 3` is enforced. Check trail loop detection.
- **Session teardown** — Verify unsubscribe + dispose happen in `finally` block. Check that disposal errors are swallowed.

### 2.5 Mode Execution

Files: `extensions/subagent/src/modes.ts`

- **Single mode** — Verify single agent execution with retry logic. Check that `{previous}` placeholder is a no-op in single mode.
- **Parallel mode** — Verify `MAX_PARALLEL_TASKS = 8` and `MAX_CONCURRENCY = 4`. Check that `mapWithConcurrencyLimit` correctly limits concurrent executions. Check that results are collected in order. Verify `MAX_SESSIONS_PER_CALL = 20`.
- **Chain mode** — Verify sequential execution with `{previous}` placeholder substitution. Check that each step receives the previous step's final output. Check that chain aborts on first failure (or continues — verify the intended behavior).
- **Result rendering** — Check `render.ts` for all three modes. Verify collapsed/expanded states. Check that subagent cards show streaming text, running tools, and final output correctly.

### 2.6 ask_user Integration (Subagent Path)

Files: `extensions/subagent/src/parent-extension-ui-bridge-proxy.ts`, `docs/subagent-ask-user-design.md`

- **Proxy implementation** — Verify the proxy implements `ExtensionUIContext` correctly. Check that `select`, `input`, `confirm`, `notify` delegate to the parent bridge. Check that TUI-specific methods are no-ops. Verify `hasUI` returns `true` when proxy is injected.
- **Request tagging** — Verify `subagentCallId` is stamped on every request payload. Check that the `ExtensionUIRequestPayload` type includes `subagentCallId`.
- **Per-session request map** — Check that `pendingExtensionUIRequestsBySession` is `Record<sessionPath, Record<requestId, payload>>` (multi-request), not the old single-entry-per-session. Verify reducer handlers upsert/delete by `requestId`. Check that `RespondExtensionUICommand` carries `requestId`.
- **Webview rendering** — Check that `AskUserContext` is a registry keyed by request ID. Verify subagent cards show pending ask_user prompts. Check collapsed card indicator (blinking border). Check tab-level dot indicator for non-active sessions with pending requests.
- **Response routing** — Verify user answers route back to the correct subagent via the parent bridge's promise resolution.

---

## Part 3 — Cross-System Concerns

### 3.1 Duplicated Systems

- **Model selection** — Is the old `model-selection.ts` (fitness-based) fully replaced by `bucket-selector.ts`? Are there any remaining code paths that use the old selector?
- **State management** — Is there any remaining Redux code in the extension host? Are there any state mutations outside the reducer?
- **ask_user** — Is the ask_user flow duplicated between main-agent and subagent paths, or does the proxy cleanly delegate? Check that the `ask_user` extension itself has no subagent-specific code.
- **Provider toggles** — Are provider toggles parsed in multiple places? Check `bucket-selector.ts`, `model-resolution.ts`, and any other location. Consolidate if duplicated.
- **Agent discovery** — Is agent discovery logic duplicated between the tool registration (for listing) and execution (for validation)? Check `agents.ts` usage.
- **Config loading** — Is `model-profiles.yaml` loaded in multiple places? Check `bucket-selector.ts` and any other location.
- **Pricing** — Is `pricing.ts` the single source for cost data? Check that no other file reads `models.json` directly for pricing.

### 3.2 Extension Interactions

- **safeguard ↔ subagent** — When a subagent runs a dangerous bash command, does the safeguard extension intercept it? Verify safeguard works in subagent sessions (it hooks `tool_call` events, which should fire in subagent sessions too).
- **skill-pruner ↔ subagent** — Does the skill pruner affect subagent sessions? Should it? Verify the pruner's scope.
- **cwd-skills ↔ subagent** — When a subagent runs in a project with local skills, are those skills discovered? Verify `resources_discover` event fires in subagent sessions.
- **ask_user ↔ safeguard** — When safeguard prompts the user for confirmation, does it use the same UI bridge as ask_user? Check for conflicts.

### 3.3 Error Handling & Edge Cases

- **Subagent disabled** — Tool registers but returns error. Verify no hang.
- **No agents discovered** — Tool registers with generic description. Verify execution fails gracefully.
- **Analytics module unavailable** — Bridge returns empty assignments. Verify fallback to active model.
- **All bucket models exhausted** — Retry exhausts excludeModels set. Verify fallback to active model.
- **Parent session closes during subagent** — Verify subagent is aborted, session is disposed, pending ask_user requests are cancelled.
- **Webview not ready** — Verify host queues state and flushes on ready.
- **Extension host restart** — Verify `hostInstanceId` change triggers full webview reset.
- **Protocol version mismatch** — Verify `WEBVIEW_PROTOCOL_VERSION` check prevents skew.

---

## Part 4 — Architecture Quality

### 4.1 Module Boundaries

- **extension/src/host/core/** — Is the CQRS spine self-contained? Does any code outside `core/` import reducer internals or mutate `ArchState` directly?
- **extension/src/shared/** — Are protocol types the only shared code between host and webview? Check that no host implementation details leak into shared.
- **extensions/** — Are extensions truly independent? Check for cross-extension imports that create coupling. Each extension should only depend on the pi SDK.
- **analysis/** — Is the analytics module cleanly separated? Check that the subagent extension only accesses it through `bridge.ts`.

### 4.2 Design Document vs Reality

For each design doc in `docs/`, verify the code matches:

- **`ARCHITECTURE.md`** — Does the CQRS flow match? Are all spine files present and correct? Are invariants upheld?
- **`STATE_CONTRACT.md`** — Are all invariants enforced in code? Are there tests for each invariant?
- **`subagent-model-selection-v2.md`** — Is the v2 system fully implemented? Are all "What gets replaced" items actually replaced? Are all "What stays" items unchanged?
- **`subagent-ask-user-design.md`** — Is the proxy implemented? Is the per-session map implemented? Are the webview changes implemented? Check which phases are complete.

### 4.3 Test Coverage

- **`extension/test/`** — Check for reducer tests, sync contract tests, protocol tests. Verify tests cover the invariants in `STATE_CONTRACT.md`.
- **`extensions/subagent/test/`** — Check for bucket selector tests, agent discovery tests, mode execution tests.
- **`analysis/test/`** — Check for stratified ranker tests.

---

## Output Format

Produce a structured report:

```
# Audit Report: UI & Subagent Systems

## Critical Issues (P0 — broken functionality)
- [ ] Issue: ... → Fix: ...

## High Priority (P1 — architectural violations, duplication)
- [ ] Issue: ... → Fix: ...

## Medium Priority (P2 — code quality, missing tests, docs drift)
- [ ] Issue: ... → Fix: ...

## Verified Correct
- [x] Item: ... (why it's fine)

## Summary
- Systems working: X/Y
- Duplications found: N
- Architecture violations: N
- Missing tests: N
- Docs drift: N files
```

For each finding, include:
- **What**: concrete file paths and line references
- **Why it matters**: impact on correctness, maintainability, or user experience
- **Fix**: specific code change or refactoring step
- **Severity**: P0/P1/P2 with justification

---

## Execution Notes

1. Start with a scout subagent to map all relevant files and trace data flow end-to-end.
2. Use parallel workers for independent audit sections (UI spine, state contract, subagent core, cross-system).
3. Use a reviewer subagent to verify findings before finalizing the report.
4. Read files, don't guess. Every finding must reference specific code.
5. Run `npm run typecheck` in `extension/` and `analysis/` to catch type errors.
6. Run existing tests: `cd extension && npm run test`, `cd analysis && npm run test`.
