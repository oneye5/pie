# Plan: Agent Question-Asking UI for pie

## Problem Statement

Agents (via pi extensions) currently cannot ask clarifying questions through the pie webview UI. The SDK provides a complete `ExtensionUIContext` interface (`confirm`, `select`, `input`, `editor`, `notify`) and the RPC protocol already defines `extension_ui_request` / `extension_ui_response` message types — but the pie backend never provides a UI context to the `ExtensionRunner`, so extension UI calls either silently fail or extensions gate on `ctx.hasUI === false` and fall back to blocking (as safeguard does).

## Key Discovery: The Infrastructure Already Exists

The pi SDK's RPC mode (`@mariozechner/pi-coding-agent/dist/modes/rpc/rpc-types.d.ts`) defines:

```typescript
// Emitted by backend when an extension needs user input
type RpcExtensionUIRequest =
  | { type: "extension_ui_request"; id: string; method: "select"; title: string; options: string[]; timeout?: number }
  | { type: "extension_ui_request"; id: string; method: "confirm"; title: string; message: string; timeout?: number }
  | { type: "extension_ui_request"; id: string; method: "input"; title: string; placeholder?: string; timeout?: number }
  | { type: "extension_ui_request"; id: string; method: "editor"; title: string; prefill?: string }
  | { type: "extension_ui_request"; id: string; method: "notify"; message: string; notifyType?: ... }
  | { type: "extension_ui_request"; id: string; method: "setStatus"; ... }
  | { type: "extension_ui_request"; id: string; method: "setWidget"; ... }
  | { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
  | { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string }

// Sent back to resolve a pending request
type RpcExtensionUIResponse =
  | { type: "extension_ui_response"; id: string; value: string }
  | { type: "extension_ui_response"; id: string; confirmed: boolean }
  | { type: "extension_ui_response"; id: string; cancelled: true }
```

The `ExtensionRunner` already has `setUIContext(uiContext?: ExtensionUIContext)`. We do **not** need a new extension — we need to implement the wiring through the existing architecture layers.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│ Webview (Preact)                                                     │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │ QuestionOverlay component                                    │    │
│  │  - renders confirm/select/input prompts inline in transcript │    │
│  │  - posts response via WebviewToHostMessage                   │    │
│  └─────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────┬───────────────────────────────────┘
                                  │ postMessage
┌─────────────────────────────────▼───────────────────────────────────┐
│ Extension Host                                                       │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ SessionService / event-dispatch                               │   │
│  │  - receives 'extension_ui.request' backend event             │   │
│  │  - stores pending request in state                           │   │
│  │  - includes it in ViewState snapshot to webview              │   │
│  │  - receives webview response, sends RPC to backend           │   │
│  └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────┬───────────────────────────────────┘
                                  │ JSONL stdin/stdout
┌─────────────────────────────────▼───────────────────────────────────┐
│ Backend Process                                                       │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ ExtensionUIContext implementation                             │   │
│  │  - provided to ExtensionRunner via setUIContext()            │   │
│  │  - each ctx.ui.confirm/select/input emits event + awaits    │   │
│  │  - resolved when host sends extension_ui.response RPC       │   │
│  └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

## Implementation Plan

### Phase 1: Backend — Implement ExtensionUIContext Bridge

**Files:** `extension/src/backend/extension-ui-bridge.ts` (new), `extension/src/backend/server.ts`

1. Create `ExtensionUIBridge` class implementing the SDK's `ExtensionUIContext` interface.
2. Each method (`confirm`, `select`, `input`) creates a pending promise keyed by a unique `id`, emits an `extension_ui.request` event via `this.emit(...)`, and `await`s the promise.
3. Expose a `resolveRequest(id, response)` method that the backend server calls when it receives the host's response RPC.
4. Wire the bridge into `createSessionContext()`: call `runtime.extensionRunner.setUIContext(bridge)` after creating the runtime (the runner is exposed on the runtime object).
5. Add a `notify` implementation that emits a fire-and-forget event (no response needed).
6. Handle timeout: auto-resolve with cancellation after `timeout` ms if specified.

**New RPC method:** `extension_ui.response` — host → backend, carries `{ id, value?, confirmed?, cancelled? }`.

**New event:** `extension_ui.request` — backend → host, carries the full `RpcExtensionUIRequest` shape.

### Phase 2: Protocol — Add Types to Shared Protocol

**File:** `extension/src/shared/protocol.ts`

1. Add `ExtensionUIRequestPayload` type (discriminated union matching the SDK's `RpcExtensionUIRequest` methods we want to support initially: `confirm`, `select`, `input`, `notify`).
2. Add `ExtensionUIResponsePayload` type (`{ id: string; value?: string; confirmed?: boolean; cancelled?: boolean }`).
3. Add `'extension_ui.request'` to the event dispatch switch.
4. Add a `WebviewToHostMessage` variant: `{ type: 'extensionUiResponse'; ... }`.
5. Add `pendingUIRequest` (or `null`) to `ViewState` — at most one question active at a time (matches how agent streaming blocks on the response).

### Phase 3: Host — Event Handling and Webview Bridging

**Files:** `extension/src/host/session-service/event-dispatch.ts`, `extension/src/host/session-service/events.ts`, `extension/src/host/sidebar/webview-message-handler.ts`

1. Add `onExtensionUIRequest` handler to `SessionBackendEventHandlers`.
2. In the handler: store the pending request in the Redux store (or arch state), schedule a render so the webview gets the new `pendingUIRequest` in its `ViewState`.
3. Handle the webview's `extensionUiResponse` message: forward to backend via the existing `BackendClient.request()` RPC mechanism, then clear the pending request from state.
4. Handle edge cases: if the session is interrupted/aborted while a UI request is pending, send a `cancelled: true` response to the backend automatically.

### Phase 4: Webview — Render the Question UI

**Files:** `extension/src/webview/panel/question-prompt.tsx` (new), integrate into `app.tsx`

Design the UI component to render inline at the bottom of the transcript (above the composer) when `pendingUIRequest` is present. Three variants:

#### 4a. Confirm prompt
- Title + message text
- Two buttons: "Allow" / "Deny" (or custom labels)
- Optional timeout countdown badge

#### 4b. Select prompt  
- Title text
- List of clickable option chips/buttons
- Optional "Cancel" action

#### 4c. Input prompt
- Title text
- Text input field with optional placeholder
- "Submit" / "Cancel" buttons

#### Visual design principles (matching GitHub Copilot's `vscode_askQuestions` UX):
- Appears inline in the conversation flow, not as a modal/overlay
- Uses the webview's existing design tokens (colors, spacing, typography)
- Auto-focuses the first interactive element
- Keyboard-navigable (Enter to confirm, Escape to cancel)
- Shows source context: "Extension X is asking:" header
- Subtle animation on appearance (slide-in or fade)

### Phase 5: Extension — Build an `ask-questions` Extension (Optional)

**Directory:** `extensions/ask-questions/` (new)

This is the **optional/future** layer — a dedicated pi extension that gives agents a structured `ask_questions` tool (similar to Copilot's `vscode_askQuestions`). This would:

1. Register a tool named `ask_questions` via `defineTool()`.
2. Accept a structured schema: `{ questions: [{ header, question, options?, multiSelect? }] }`.
3. In `execute()`: use `ctx.ui.custom()` or multiple sequential `ctx.ui.select()`/`ctx.ui.input()` calls to gather answers.
4. Return the collected answers as the tool result.

This layer is independent of Phases 1–4. Phases 1–4 enable **any** extension to ask questions; Phase 5 gives the LLM a **dedicated tool** for structured multi-question flows.

**Decision:** Phase 5 is optional because:
- Phases 1–4 already unlock safeguard confirmations, subagent trust prompts, and custom extension inputs through the webview.
- Phase 5 adds convenience for the specific "agent wants to ask clarifying questions" use case.
- Building Phase 5 on top of a working Phase 1–4 is straightforward.

## Scope Prioritization

| Phase | Effort | Value | Recommendation |
|-------|--------|-------|----------------|
| 1 (Backend bridge) | Medium | Critical foundation | Must do first |
| 2 (Protocol types) | Small | Enables host↔webview | Must do with Phase 1 |
| 3 (Host wiring) | Medium | Connects layers | Must do with Phases 1–2 |
| 4 (Webview UI) | Medium-Large | User-facing payoff | Must do — this is the user sees |
| 5 (ask_questions tool) | Small-Medium | Nice UX polish | Do after Phases 1–4 validate |

## Existing Patterns to Leverage

- **Run Outcome Dialog:** `extension/src/webview/panel/run-outcome-dialog.tsx` — shows how host-state-driven dialogs work. The pending UI request follows the same pattern: host state drives rendering, webview posts response back.
- **Inline Editor:** `extension/src/webview/panel/transcript/inline-editor.tsx` — text input with confirm/cancel already exists.
- **safeguard confirm:** Proves that `ctx.ui.confirm()` is the right API surface and extensions already use it.
- **Backend event dispatch:** `event-dispatch.ts` shows exactly how to add a new event type.
- **ViewState-driven rendering:** Everything in the webview derives from `ViewState` snapshots — no local state for this feature.

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| SDK `ExtensionRunner` not exposed on runtime | Blocks Phase 1 | Check `runtime.extensionRunner` exists; if not, patch SDK or use the `createExtensionRuntime` API directly |
| Agent streaming blocks while awaiting UI response | Could appear frozen | Show clear "waiting for your input" indicator; include the question context |
| Multiple concurrent UI requests (e.g. parallel tool calls) | State complexity | Queue them — only one active at a time, serialized. The SDK already serializes tool execution by default |
| Timeout fires before user responds | Confusing UX | Show countdown; extend timeout on user interaction; "I need more time" action |
| Session interrupted while question pending | Orphaned state | Auto-cancel pending requests on session abort/interrupt |

## Success Criteria

1. `safeguard` confirm prompts render in the webview instead of silently blocking
2. `subagent` project-agent trust prompts appear in the webview
3. A new `ask_questions` tool (Phase 5) lets agents ask structured multi-part questions with options
4. The UI matches the clean inline style of GitHub Copilot's question prompts
5. No new extension package needed for Phases 1–4 — it's pure wiring through existing layers
