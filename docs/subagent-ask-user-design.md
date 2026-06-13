# Subagent `ask_user` Support — Design Doc

## Problem

When a subagent calls `ask_user`, the call aborts because the subagent's in-memory session has no `ExtensionUIBridge` wired up. Subagents are fully autonomous — they can't ask the user questions, even when it would be valuable to do so.

## Goals

1. Subagent `ask_user` calls should appear in the parent session's UI
2. Collapsed subagent cards should show an indicator when a question is pending
3. The expanded subagent card should render the interactive prompt
4. Multiple parallel subagents asking questions simultaneously should work (thanks to per-session map)
5. The answer should route back to the correct subagent

## Architecture

### Current Flow (Main Agent)

```
ask_user extension → ctx.ui.select() → ExtensionUIBridge.emit()
  → host event pipeline → ExtensionUIRequest arch event
  → pendingExtensionUIRequestsBySession[parentSessionPath]
  → webview renders inline prompt
  → user answers → postMessage → RespondExtensionUI command
  → backend extension_ui.response RPC → ExtensionUIBridge.resolveRequest()
  → ask_user promise resolves
```

### Proposed Flow (Subagent)

```
ask_user extension (in subagent session) → ctx.ui.select()
  → ParentExtensionUIBridgeProxy.select()   ← NEW: proxy that stamps subagentCallId, delegates to parent
  → parent session's ExtensionUIBridge.select()
  → ExtensionUIBridge.emit('extension_ui.request', payload)
  → host event pipeline → ExtensionUIRequest arch event
  → pendingExtensionUIRequestsBySession[parentSessionPath]
  → webview renders prompt in subagent tool call context
  → user answers → postMessage → RespondExtensionUI command
  → backend extension_ui.response RPC → parent ExtensionUIBridge.resolveRequest()
  → same promise that proxy is awaiting resolves → subagent ask_user promise resolves
```

## Key Design Decisions (Resolved)

### 1. Proxy the parent bridge into the subagent ✅

The subagent runner (`extensions/subagent/runner.ts`) creates in-memory sessions. When the `ask_user` extension loads in the subagent session, it gets a `ToolContext` with `ctx.ui`. Currently this is a no-op stub for in-memory sessions.

**Proposal**: Create a `ParentExtensionUIBridgeProxy` — a thin decorator that implements `ExtensionUIContext`, stamps every request payload with `subagentCallId`, and delegates to `parentBridge.select()`/`parentBridge.input()`. The parent bridge owns the promise; the proxy just awaits it. No parallel promise tracking, no subscription lifecycle, no new event types.

```typescript
// In runner.ts, when creating the subagent session:
const proxy = new ParentExtensionUIBridgeProxy(parentBridge, subagentCallId);
const { session } = await createAgentSession({
  cwd: sessionCwd,
  modelRegistry,
  model: resolvedModel,
  thinkingLevel,
  tools: agent.tools,
  sessionManager: SessionManager.inMemory(sessionCwd),
  resourceLoader,
  uiContext: proxy,  // NEW: inject proxy, not raw parent bridge
});
```

**Proxy scope**: The proxy implements only the dialog methods (`select`, `input`, `confirm`, `notify`). All other `ExtensionUIContext` methods (TUI-specific: `setTheme`, `setStatus`, `setWidget`, `onTerminalInput`, etc.) are no-ops on the proxy. This is documented on the proxy class, not via a separate type — we don't want to confuse agents with a split interface.

**`ctx.hasUI`**: Returns `true` when a parent bridge proxy is injected, `false` otherwise. The `ask_user` extension currently doesn't check `hasUI` — it calls `port.ui.select()` / `port.ui.input()` unconditionally. The `safeguard` extension does check `ctx.hasUI` before calling `ctx.ui.confirm()`. Both paths work correctly with the proxy.

**`subagentCallId` availability**: The `_toolCallId` is available in `execute()` but not at `createAgentSession()` time (which runs inside `runSingleAgent()`). The cleanest approach is to pass `_toolCallId` and `parentUiBridge` as additional parameters to `runSingleAgent()`, so the proxy can be constructed with the ID at creation time. No lazy initialization or mutable ID fields.

### 2. Tag requests with subagent context ✅

The `ExtensionUIRequestPayload` needs metadata to associate a request with the subagent tool call that spawned it. This allows the webview to render the prompt in the right context.

**Restructure `ExtensionUIRequestPayload`** into a base type + method-specific payload:

```typescript
interface ExtensionUIRequestBase {
  id: string;
  sessionPath: string;
  extensionId?: string;
  timeout?: number;
  subagentCallId?: string;  // links to the parent session's subagent tool call
}

type ExtensionUIRequestPayload =
  | (ExtensionUIRequestBase & { method: 'confirm'; title: string; message: string })
  | (ExtensionUIRequestBase & { method: 'select'; title: string; options: string[] })
  | (ExtensionUIRequestBase & { method: 'input'; title: string; placeholder?: string })
  | (ExtensionUIRequestBase & { method: 'notify'; message: string; notifyType?: 'info' | 'warning' | 'error' });
```

When a subagent's `ask_user` emits a request, the proxy stamps it with the parent session's tool call ID so the webview knows where to render it.

### 3. Webview rendering: collapsed indicator + expanded prompt ✅

**Tab-level indicator**: When any session (including non-active tabs) has a pending `ask_user` request, the session tab shows a colored dot. This applies to both main-agent and subagent `ask_user` calls.

**Collapsed subagent card**: Show a blinking/flashing animation on the subagent row border when a pending `ask_user` request belongs to that subagent.

**Expanded subagent card**: Render the `AskUserInlinePrompt` component inside the subagent's tool call area. The `AskUserContext` is redesigned as a registry keyed by request ID; components subscribe by matching `subagentCallId`.

### 4. Response routing ✅

The proxy delegates to `parentBridge.select()`/`parentBridge.input()`, so the parent bridge owns the `PendingRequest`. When the user answers, the response routes through the existing pipeline by `sessionPath` and resolves by `id` in the parent bridge. The subagent's `ask_user` is awaiting the same promise — it resolves automatically.

No changes needed to the response pipeline.

## Changes Required

### SDK Change

| File | Change |
|------|--------|
| `@mariozechner/pi-ai` SDK — `CreateAgentSessionOptions` | Add optional `uiContext?: ExtensionUIContext` field so the proxy can be injected at session creation time |

### Backend

| File | Change |
|------|--------|
| `extensions/subagent/runner.ts` | Accept `_toolCallId` and `parentUiBridge` params in `runSingleAgent()`; construct `ParentExtensionUIBridgeProxy` and pass it to `createAgentSession({ uiContext: proxy })` |
| `extensions/subagent/src/execute.ts` | Pass `_toolCallId` and `ctx` (for UI bridge) through to `runSingleAgent()` |
| `extensions/subagent/src/parent-extension-ui-bridge-proxy.ts` | **NEW**: Thin decorator implementing `ExtensionUIContext` — stamps `subagentCallId` on every payload, delegates `select`/`input`/`confirm`/`notify` to parent bridge, no-ops for TUI methods |
| `extensions/ask-user/src/ask.ts` | No change — uses `ctx.ui` transparently |
| `extension/src/backend/extension-ui-bridge.ts` | No change — proxy delegates to its public API |
| `extension/src/shared/protocol/webview.ts` | Restructure `ExtensionUIRequestPayload` into `ExtensionUIRequestBase & method-specific` intersection type; add `subagentCallId?: string` to `ExtensionUIRequestBase` |

### Host / State

| File | Change |
|------|--------|
| `extension/src/host/core/arch-state.ts` | Change `pendingExtensionUIRequestsBySession` from `Record<sessionPath, ExtensionUIRequestPayload>` to `Record<sessionPath, Record<requestId, ExtensionUIRequestPayload>>` to support multiple parallel requests per session |
| `extension/src/host/core/reducer/ui-handlers.ts` | Change `handleExtensionUIRequest` to upsert by `requestId` instead of overwriting; change `handleExtensionUIResponse` to delete by `requestId` instead of clearing the entire session entry |
| `extension/src/host/core/reducer/command-handlers.ts` | `RespondExtensionUI` handler: delete by `requestId` instead of `delete draft.settings.pendingExtensionUIRequestsBySession[cmd.sessionPath]` |
| `extension/src/host/core/commands.ts` | Add `requestId: string` field to `RespondExtensionUICommand` |
| `extension/src/host/core/message-router.ts` | Pass `msg.response.id` through to `RespondExtensionUI` command construction |
| `extension/src/host/core/projection.ts` | Change projection to expose the multi-request map; optionally add `pendingAskBySubagent` for tab indicator lookups |
| `extension/src/shared/protocol/webview.ts` | Update `ViewState.pendingExtensionUIRequests` type from single request to map |

### Webview

| File | Change |
|------|--------|
| `extension/src/webview/panel/hooks/ask-user-context.ts` | Redesign `AskUserContext` as a registry keyed by request ID; components subscribe by `subagentCallId`. Derive from ViewState, not local state |
| `extension/src/webview/panel/app-body.tsx` | Change `isAskUserHandledInline` to search nested subagent tool calls for pending ask_user, not just top-level transcript. Change `askUserContextValue` to provide the registry instead of single `pendingRequest` |
| `extension/src/webview/panel/transcript/tools/ask-user-tool.tsx` | Match `subagentCallId` when rendering inside subagent context |
| `extension/src/webview/panel/transcript/tool-call-item.tsx` | Add blinking/flashing border animation on `SubagentSingleBlock`/`SubagentBlock` when pending request has matching `subagentCallId` |
| Session tab component | Add colored dot indicator when session has pending `ask_user` requests (may already be partially wired via `hasPendingExtensionUIRequest`) |

## Edge Cases

1. **Parallel subagents asking simultaneously**: Works naturally with per-session map. Each request has a unique `id` and `subagentCallId`.

2. **Subagent timeout**: Timeouts are being removed from `ask_user` per design decision. The proxy does not add a timeout. The parent bridge's existing timeout mechanism (if kept for main-agent prompts) does not apply to subagent prompts.

3. **Parent session closes while subagent is waiting**: The parent's `cancelAll()` on the bridge cancels all pending requests, including the subagent's.

4. **Subagent aborts**: If the parent aborts the subagent (e.g., user cancels), the proxy listens to the abort signal and cancels the pending `ask_user` request in the parent bridge. The request resolves with `cancelled: true`, and the UI prompt disappears. No orphaned pending requests.

5. **Timeout removal**: The `ask_user` extension currently has a timeout on prompts. Per decision, timeouts should be removed — they get in the way more than they help. The proxy does not add a timeout.

6. **Nested subagents**: A subagent spawning another subagent that calls `ask_user` would need to pass the bridge proxy down another level. The proxy's `subagentCallId` would be the nested subagent's tool call ID. The webview renders cards hierarchically, so the prompt appears inside the nested card. The depth limit (`MAX_DEPTH = 3`) prevents infinite nesting. Single `subagentCallId` is sufficient — no ID chain needed.

## Critical Architectural Issue

The current `pendingExtensionUIRequestsBySession` is `Record<string, ExtensionUIRequestPayload>` — a **single pending request per session**. This means:

1. If two subagents in the same parent session call `ask_user` simultaneously, the second overwrites the first.
2. `RespondExtensionUICommand` deletes the entire session entry, not a specific request.
3. `RespondExtensionUICommand` has no `requestId` field — only `sessionPath` and `approved`.

**Resolution**: Change the data structure to `Record<string, Record<string, ExtensionUIRequestPayload>>` (session → requestId → payload). This cascades to the reducer handlers, command types, message-router, projection, and ViewState types. All changes are listed in the Changes Required tables above.

## Open Questions

- ~~Should the subagent's question text include a prefix like "[Subagent: reviewer] asking..." for clarity?~~
- ~~Should the collapsed indicator be a `?` icon, a colored dot, or the same `attention` class used for the main agent?~~
- ~~How should the `AskUserContext` be scoped inside subagent tool call rendering?~~ → **Resolved**: Redesign as a registry keyed by request ID; components subscribe by `subagentCallId`.
- ~~Should `ctx.hasUI` return `true` for subagent sessions when a parent bridge is available?~~ → **Resolved**: Yes, `ctx.hasUI` returns `true` when a proxy is injected, `false` otherwise.

## Implementation Priority

This is a **P2 feature** — nice to have but not blocking. The per-session robustness fix is P0 and already landed. Subagent `ask_user` support can be implemented incrementally:

1. **Phase 0 (prerequisite)**: Change `pendingExtensionUIRequestsBySession` from single-entry to multi-entry per session (`Record<sessionPath, Record<requestId, payload>>`). Update reducer handlers, command types, message-router, projection, and ViewState types. This change is independent of subagent support and benefits the main agent too (e.g., multiple extensions asking questions simultaneously).
2. **Phase 1**: Pass parent bridge proxy into subagent sessions. Questions appear in the main session's UI (no subagent-scoped rendering). This is minimal effort and unblocks the basic case.
3. **Phase 2**: Add `subagentCallId` tagging and render prompts inside subagent tool call cards with collapsed indicators. Redesign `AskUserContext` as a registry.

## Testing Plan

1. Main agent calls `ask_user` in parallel across 3 sessions → all prompts appear correctly (already tested via per-session map)
2. Subagent calls `ask_user` → prompt appears inside subagent tool call card in parent session UI
3. User answers subagent's question → subagent receives the answer
4. Subagent is aborted (user cancels) → pending `ask_user` resolves with `cancelled: true`, prompt disappears
5. Parent session closes → subagent's pending questions are cancelled via `cancelAll()`
6. Two parallel subagents both call `ask_user` simultaneously → both prompts appear in their respective cards, answers route to the correct subagent
7. Nested subagent (A spawns B, B calls `ask_user`) → prompt appears inside B's card within A's card
8. Tab-level colored dot appears when non-active session has a pending `ask_user`
9. Collapsed subagent card shows blinking border animation when it has a pending `ask_user`