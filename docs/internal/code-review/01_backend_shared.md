
# Code Review — `extension/src/backend/` and `extension/src/shared/`

Scope: backend server/request-handler/rpc/transcript/server-io plus shared protocol-validation, protocol/*, tokenize, token-rate, tool-call-analysis/*. Read in full; findings are structural/quality only (no fixes proposed). Line numbers are 1-indexed and were verified against the current tree.

## Files reviewed

Backend:
1. `extension/src/backend/server.ts` — 570 lines
2. `extension/src/backend/request-handler.ts` — 481 lines
3. `extension/src/backend/rpc.ts` — 409 lines
4. `extension/src/backend/transcript.ts` — 419 lines
5. `extension/src/backend/server-io.ts` — 30 lines
6. `extension/src/backend/session-event-handler.ts` — 328 lines
7. `extension/src/backend/transcript-window.ts` — 227 lines
8. `extension/src/backend/sdk.ts` — 240 lines
9. `extension/src/backend/server-types.ts` — 56 lines
10. `extension/src/backend/runtime-factory.ts` — 41 lines

Shared:
11. `extension/src/shared/protocol-validation.ts` — 371 lines
12. `extension/src/shared/protocol/core.ts` — 66 lines
13. `extension/src/shared/protocol/messages.ts` — 146 lines
14. `extension/src/shared/protocol/sessions.ts` — 234 lines
15. `extension/src/shared/protocol/settings.ts` — 302 lines
16. `extension/src/shared/protocol/webview.ts` — 211 lines
17. `extension/src/shared/protocol/models.ts` — 64 lines
18. `extension/src/shared/tokenize.ts` — 38 lines
19. `extension/src/shared/token-rate.ts` — 471 lines
20. `extension/src/shared/tool-call-analysis/index.ts` — 298 lines
21. `extension/src/shared/tool-call-analysis/verification.ts` — 337 lines
22. `extension/src/shared/tool-call-analysis/mutation-size.ts` — 340 lines
23. `extension/src/shared/tool-call-analysis/mutation-file.ts` — 221 lines
24. `extension/src/shared/tool-call-analysis/mutation-tools.ts` — 150 lines
25. `extension/src/shared/tool-call-analysis/summary.ts` — 162 lines
26. `extension/src/shared/tool-call-analysis/mutation-types.ts` — 49 lines
27. `extension/src/shared/tool-call-analysis/mutation.ts` — 12 lines (barrel)

## Notable issues

### High — Protocol validator is out of sync with the protocol union (setFileChangesExpanded)
`extension/src/shared/protocol/webview.ts` adds `{ type: 'setFileChangesExpanded'; sessionPath: string; expanded: boolean }` to the `WebviewToHostMessage` union, but `extension/src/shared/protocol-validation.ts` `validateWebviewToHostMessage` has no `case 'setFileChangesExpanded'` and falls through to `default: return fail('unknown message type: ...')` (verified: grep for setFileChangesExpanded in the validator returns nothing). This is exactly the class of protocol drift the validator's own header comment says it exists to catch. The webview will post setFileChangesExpanded and the host-side audit log will flag every such message as invalid. The validator is currently audit-only (does not drop), so it is latent, but the moment it is tightened to rejection this breaks file-changes drawer toggling.

### High — Backend handleSessionTruncateAfter reaches into the session file directly, bypassing the SDK
`extension/src/backend/request-handler.ts:173-204`: handleSessionTruncateAfter does `fs.readFile(params.sessionPath, 'utf8')` (line 184), hand-parses each JSONL line with `JSON.parse(trimmed)`, accumulates keepLines until `entry.id === params.entryId`, then `fs.writeFile(params.sessionPath, newContent, 'utf8')` (line 198). It then re-opens via `deps.sdk.SessionManager.open(params.sessionPath)` and recreates the context. This duplicates JSONL parsing (which shared/jsonl.ts and the SDK session manager own), couples the request handler to the on-disk session format, and has no concurrency guard: if a streaming/active request writes to the same file between the read and the write, those entries are silently lost. The isStreaming/activeRequest guard at lines 178-182 only covers the target session, but the write is non-atomic (read-modify-write with no lock or tmp-file rename). Why it matters: a format change in the SDK (entry shape, line framing) silently corrupts truncation, and the handler now owns a second, parallel parser that must be kept in sync with the SDK's.

### High — extension_ui.response backend handler bypasses the rpc validation layer
`extension/src/backend/request-handler.ts:371-389` (handleExtensionUiResponse) parses params with a raw cast `request.params as { sessionPath: string; response: ExtensionUIResponsePayload } | undefined` (line 375) and does ad-hoc `if (!params?.sessionPath || !params.response?.id)` checks. Every other request handler delegates to a `validate*` function in rpc.ts that returns a typed, narrowed object. There is no validateExtensionUiResponse in rpc.ts, so this trust boundary is hand-rolled, untyped, and inconsistent with the rest of the RPC surface. The webview-to-host side does validate extensionUiResponse in protocol-validation.ts:357-365, but the backend re-implements its own check instead of reusing a shared validator. Why it matters: the validation pattern is split across two files and two styles; future field additions to ExtensionUIResponsePayload will be checked in one path and silently trusted in the other.


### Medium — BackendServer is a god class with a wide, untyped event bus
`extension/src/backend/server.ts` (570 lines) holds: SDK loading, auth path resolution/migration, session-context lifecycle, display-transcript cache management, transcript paging, context-usage derivation, system-prompt module loading, model-settings file read/write, session-opened payload assembly, event emission, and the request dispatch wrapper. `handleRequest` (lines ~467-490) wires 16 closure deps into handleBackendRequest. The private `emit(event: string, payload?: unknown)` (line 496) is fully untyped — every typed `satisfies XPayload` check at call sites is erased at the bus boundary, and `this.emit('error', details)` (line 518) emits an arbitrary ErrorPayload under the literal string 'error' with no protocol type for that event. Why it matters: the central seam of the backend is stringly-typed and unifiable only by convention; the class is hard to test in pieces because state and emission are co-located.

### Medium — Error codes are collapsed: all thrown errors become BACKEND_ERROR
`extension/src/backend/server-io.ts:12-17` extractRequestError returns `{ code: 'BACKEND_ERROR', ... }` for every Error and every non-Error. `server.ts:505` uses a distinct 'parse-error'/'PARSE_ERROR' for JSON parse failures, but every validate* failure in rpc.ts throws `new Error('Invalid params for ...')`, and every runtime failure in request-handler.ts throws plain Errors — all of which surface to the client as the identical code BACKEND_ERROR. The client cannot distinguish "invalid params" from "session streaming" from "model not available" from "live model switch did not take effect" without parsing the human-readable message. Why it matters: error handling is effectively un-typed at the wire boundary; structured error codes were clearly intended (the envelope supports error.code) but never populated per-failure.

### Medium — fileBlob composer input is allowed by the protocol and webview validator but rejected by the backend send validator
- `protocol/messages.ts:35-44` defines FileBlobComposerInput and includes it in ComposerInput / ComposerInputDraft.
- `protocol-validation.ts:99-106` validateComposerInputDraft accepts `case 'fileBlob'` and validates its fields.
- `rpc.ts:284-286` validateComposerInput explicitly rejects fileBlob: "Arbitrary pasted file attachments are not supported yet."

So a webview can legitimately build and locally validate a fileBlob draft, post send, and only hit the rejection at the backend. The contract is split across three files with three different policies. Why it matters: the type system says fileBlob is a first-class input; only the backend validator disagrees, by string-match on a comment.

### Medium — Duplicated extractCommandText with divergent return types
`tool-call-analysis/index.ts:105` defines `extractCommandText(input: unknown): string` (returns '' on miss, joins args without trimming). `tool-call-analysis/verification.ts:41` defines `extractCommandText(input: unknown): string | null` (returns null on miss, trims and returns null for empty). Both walk the same command/cmd/script/args keys. Same name, same purpose, different nullability and trimming semantics — a caller that swaps one for the other gets subtly different behavior (empty-string vs null; trimmed vs untrimmed command text). Why it matters: two sources of truth for "extract the command from a tool input"; future bug fixes apply to only one.

### Medium — Duplicated normalizeText
`tool-call-analysis/summary.ts:5` and `tool-call-analysis/verification.ts:37` both define `function normalizeText(text: string): string { return text.replace(/\s+/g, ' ').trim(); }` — byte-identical. Trivial duplication, but it is the second instance of copy-paste between these two modules and signals the barrel (tool-call-analysis/index.ts) is not consolidating shared helpers.

### Medium — Thinking-level enums are defined three times
- `rpc.ts:77` THINKING_LEVELS: ReadonlyArray<ThinkingLevel>
- `protocol-validation.ts:69` THINKING_LEVELS: readonly ThinkingLevel[] (used by isThinkingLevel)
- `protocol-validation.ts:189` VALID_THINKING_LEVELS = new Set([...]) (used by validatePruningSettingsPatch)

Three independent copies of the same six-value list. Adding/changing a thinking level requires editing all three or the validators silently disagree (e.g. setPrefs / setPruningSettings would accept a level that settings.set rejects, or vice versa).

### Medium — runtime-factory.ts erases the SDK factory contract with any
`extension/src/backend/runtime-factory.ts:10` types the factory callback as `async ({ cwd, agentDir, sessionManager, sessionStartEvent }: any) => {...}`, then casts the SDK results `as Record<string, unknown>` (lines 24, 30). sdk.ts goes to the trouble of defining SdkModule, SdkRuntime, etc. as a minimal typed contract, but the runtime factory — the one place that actually calls into the SDK's pluggable factory hook — discards all typing. authStorage is also `unknown` end-to-end (runtime-factory.ts:9, server.ts:102, sdk.ts AuthStorage.create(...): unknown), so the auth object is passed through the whole backend with no type. Why it matters: the boundary most likely to break on SDK changes is the one with zero static checking.

### Medium — session-event-handler.ts casts SDK event to any
`session-event-handler.ts:261`: `mapAssistantMessage(messageId, event.message as any, durationMs, {...})`. SdkSessionEvent.message is typed in sdk.ts:30-40 but the message_end assistant path casts it away, so mapAssistantMessage's MessageLike parameter is unchecked against the actual SDK shape. The other event.message accesses (e.g. `event.message?.role` at lines ~70, ~100) use the typed SdkSessionEvent, but this hot path does not — inconsistent typing on the same field within one file.

### Medium — token-rate.ts is a complexity hotspot (471 lines, dense invariants)
`shared/token-rate.ts` (471 lines) holds Accumulator with two Maps (lastContentTokensById, subagentTokens), composite keys (`${toolCallId}#${resultIndex}`), per-id delta accounting, a generation-clock that pauses/resumes with subtle rules, and ~120 lines of explanatory comments inside tickTokenRate. The invariants (e.g. "leave the map untouched while no message is streaming", "tokens must always be accompanied by generation time") are correct-but-fragile and only encoded in comments. Why it matters: this is the single most logic-dense shared module; a small refactor here can silently inflate or collapse the displayed rate with no type-level guardrail.

### Low/Medium — validateWebviewToHostMessage casts after shallow checks by design, but the cast is unconditional
`protocol-validation.ts`: the header explicitly states validation is intentionally light and the host narrows defensively. Nonetheless every `case` ends with `return { ok: true, value: value as WebviewToHostMessage }` even for branches that checked zero payload fields (openFilePicker, newSession, dismissNotice, interrupt, closeSession, etc.). The `as WebviewToHostMessage` is a hard cast that hides unvalidated extra fields from downstream consumers. Acceptable as documented, but it means the "validated" return is not actually proven to satisfy the union — it is unknown wearing the type.

### Low/Medium — session-metadata.ts double-casts
`session-metadata.ts:172`: `resolveModelInputKinds(model as unknown as Record<string, unknown>)`. A direct `as Record<string, unknown>` would suffice; the `as unknown as` suggests the source type is structurally incompatible with the target, which is a smell that the model type and the helper's expected shape have drifted.


## Smaller nits

- **Dead code**: `backend/rpc.ts:44` SessionPathOptionalParams and `backend/rpc.ts:111` validateSessionPathOptional have no consumers anywhere in extension/src (grep across the whole src tree confirms only the definition sites). Likely dead.
- **Re-export smell**: `backend/rpc.ts:4` re-exports MAX_IMAGE_INPUT_BYTES from ../shared/image-constraints out of the rpc validation module; consumers could import from shared/image-constraints directly. The rpc module is a validator, not a constants barrel.
- **parse-error id/code mismatch**: `server.ts:505` writes `responseError('parse-error', 'PARSE_ERROR', ...)` — the envelope id is the string 'parse-error' (no request id exists yet), which is fine, but the code 'PARSE_ERROR' is the only upper-case code in the system; all other codes are lower/snake (BACKEND_ERROR is the exception, also upper). Inconsistent casing convention.
- **server-io.ts:17** the `data?` param of responseError is never used by any caller (callers pass 2 args). Dead parameter.
- **isEventEnvelope / isResponseEnvelope** in `protocol/core.ts:51-58` check only outer shape ('event' in value, 'id' in value && 'ok' in value); isResponseEnvelope does not verify ok is boolean nor that error exists when ok is false. The protocol-validation.ts header calls this out as a known gap (backend-to-host payloads are unvalidated). Consistent with the header note but worth tracking.
- **transcript.ts:339** uses `(entry as { details?: unknown }).details` even though SessionEntryLike (defined in the same file, lines 41-58) already declares `details?: unknown`. The cast is redundant.
- **request-handler.ts handleSettingsSet rollback** (lines ~420-445): on live-model-switch failure it writes previousSettings back, but writeModelSettings itself can reject (disk error), leaving settings inconsistent with no further rollback and no error surfacing that the rollback failed.
- **request-handler.ts:111-117 handleMessageInterrupt**: `void context.session.abort().catch(...)` is fire-and-forget; the handler returns `{ interrupted: true }` immediately regardless of whether abort succeeds. The failure path only emits an error event asynchronously. The client gets an optimistic success even if the session cannot be interrupted.
- **server.ts:102** `private authStorage: unknown` — assigned once in start() and never re-typed; passed into createRuntimeFactory and AuthStorage.create, both of which accept unknown. The auth storage contract is entirely opaque through the backend.
- **tokenize.ts**: estimateTextTokens and countTextTokens are near-identical (both call bpeCountTokens); the only differences are estimateTextTokens trims and guards non-string, countTextTokens checks length === 0 and does not trim. Two functions, one tokenizer, divergent edge handling — easy to call the wrong one.
- **protocol-validation.ts:189** VALID_PRUNING_MODES / VALID_THINKING_LEVELS are local Sets while PruningMode in protocol/settings.ts:96 is a TS union including 'custom' — but VALID_PRUNING_MODES is `new Set(['auto','shadow','off'])` with no 'custom'. The validator rejects `mode: 'custom'` even though the type permits it. Likely intentional (custom not settable via webview), but the divergence between the type and the validator is unannotated.
- **request-handler.ts:51-58** PreflightGate / createPreflightGate / applyPreflightResult / clearActiveRequest / reportPromptFailure / startPromptBackground are a small cluster of module-private helpers that exist only to support handleMessageSend; they are fine but make the file's top half a mini state machine that is easy to miss when scanning the handler table at the bottom.
- **rpc.ts blank lines / formatting**: the THINKING_LEVELS block (lines 77-84) is followed by two blank lines before isObj; the rest of the file uses one. Minor inconsistency.
- **protocol-validation.ts vs rpc.ts validate divergence**: both files independently validate boolean maps (validateBooleanMap in rpc.ts, isStringBooleanRecord in protocol-validation.ts) and composer inputs, with subtly different rules (rpc.ts rejects fileBlob; protocol-validation.ts accepts it). Two parallel validation stacks for overlapping concerns.
