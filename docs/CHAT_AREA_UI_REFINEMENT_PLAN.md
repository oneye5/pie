# Chat Area UI Refinement Plan

## Refined brief

The red-outlined main chat area should feel like a calm, instrumented workbench rather than a log stream. The user should immediately understand:

- who said what, where a turn begins/ends, and what metadata matters;
- what the agent is doing right now: queued, pruning, starting the model, thinking, running a tool/subagent, streaming, interrupted, or failed;
- what can be acted on: stop, edit/resend, retry from a failed turn, copy details, open referenced files, and expand/collapse long internals;
- whether the UI is alive even when the backend/model takes several seconds;
- that streaming, tool updates, editing, and errors will not cause distracting width/height jumps.

The design direction should extend the existing **Quiet instrumentation panel** style in `extension/src/webview/panel/mockup-description.md`: VS Code-native surfaces, compact monospace status chips, subtle motion, and no loud chatbot-brand visuals.

## Actual UI grounding

This plan targets the active session surface rendered by `extension/src/webview/panel/app.tsx`, specifically:

- `extension/src/webview/panel/app.tsx`: owns send/interrupt/edit handlers, optimistic message insertion, and mounts `TranscriptHost` and `Composer`.
  - Optimistic user acknowledgement already happens through `addOptimisticMessage(...)` before `postMessage({ type: 'send' ... })`.
  - `onInterrupt` is already wired to the composer Stop button.
- `extension/src/webview/panel/transcript/transcript-host.tsx`: keeps the active transcript surface mounted for a session.
- `extension/src/webview/panel/transcript/virtual-list.tsx`: derives activity state, builds virtual rows, owns the virtualizer, scroll state, and Jump to latest control.
- `extension/src/webview/panel/transcript/virtual-list-rows.ts`: turns transcript messages into row types, including placeholder assistant rows and typing indicators.
- `extension/src/webview/panel/transcript/message-item.tsx`: renders message headers, assistant/user/system bodies, errors, reasoning blocks, tool-call parts, inline editing, and streaming text parts.
- `extension/src/webview/panel/transcript/activity.ts`: currently compresses busy state into labels such as `pruning skills/tools`, `starting model`, `running tools`, and `thinking`.
- `extension/src/webview/panel/transcript/buffered-text-part.tsx` and `use-buffered-text.ts`: already smooth incoming text chunks instead of rendering large deltas all at once.
- `extension/src/webview/panel/transcript/tool-call-item.tsx` and `tool-call-card.tsx`: render collapsible tool and subagent details with running/failed status chips.
- `extension/src/webview/panel/ui.tsx` and `composer/toolbar.tsx`: render model/thinking controls, token/context indicators, run status, attachments, textarea, Send/Stop, and draft restoration on failed sends.
- CSS is split across `styles/transcript.css`, `styles/tool-call.css`, `styles/composer.css`, `styles/layout.css`, and `styles/context-menu.css`, with `styles/index.css` as the build entrypoint. A legacy aggregate `extension/src/webview/panel/panel.css` also exists and several CSS tests still read it directly; implementation must not let shard CSS and CSS tests drift. Notably, `.message-glow-indicator` currently lives in `context-menu.css` even though it belongs to transcript styling.

Existing strengths to preserve:

- optimistic user messages and optimistic running state make send feel immediate;
- draft text is restored on `sendRejected`;
- `busy` flips the composer from Send to Stop;
- the transcript already uses virtualized rows and auto-follow scroll logic;
- reasoning, tools, subagents, pruning details, user images, GFM tables, and code blocks already render;
- status chips for messages/tools/subagents already share token variables;
- inline editing captures message height to reduce layout shift.

Current gaps this plan addresses:

- current activity labels are strings, so UI cannot show structured details such as the specific running tool, model, elapsed phase, or error affordances consistently;
- assistant bubbles use content-fit sizing, so streaming replies can visibly grow horizontally before settling;
- the waiting/typing indicator and assistant placeholder are separate concepts, which can still cause turn-start jumps;
- user messages rely on alignment and styling for identity, so refinements should preserve that clarity without adding redundant labels;
- retry/regenerate is not explicit, while user-message editing should continue to rely on the existing cursor/button affordance rather than added hint text;
- code blocks lack copy buttons, language labels, and long-output collapse;
- message-level errors show details, but recovery actions are not as explicit as tool/subagent failed-chip copy behavior;
- some transcript animation styles are misplaced and motion rules are inconsistent across transcript, tool, and composer surfaces.

## UX principles translated into requirements

1. **Fast perceived responsiveness**
   - User message appears immediately with a subtle sent/queued acknowledgement.
   - The current assistant turn gets a stable shell immediately after send, even before first model output.
   - Waiting phases show specific activity, not a generic spinner.
   - Stop is always visible while `busy` is true.

2. **Clear conversational structure**
   - Message ownership should remain obvious from the existing alignment, bubble styling, and role treatment without adding redundant user labels.
   - Assistant headers expose compact model/thinking/time/duration/status metadata.
   - Current-turn activity appears inside the assistant turn shell, not as a separate jumping row where possible.
   - Reasoning/tool/subagent details remain collapsible and summarized.

3. **Smoothness / low clunkiness**
   - The active assistant message width is stable while streaming.
   - Current-turn status reserves space so phase changes do not snap the transcript.
   - Text reveal remains buffered, but layout changes are limited to predictable vertical growth.
   - Height animations are avoided inside virtualized rows; use opacity/transform/color only.
   - All motion respects `prefers-reduced-motion`.

4. **Graceful failure handling**
   - Typed input remains preserved on failed send.
   - Failed assistant/tool/subagent surfaces expose clear details and copy affordances.
   - Failed/interrupted turns expose an obvious retry/edit-from-here path instead of forcing users to infer it.

5. **Multi-modal and dense output readiness**
   - Code blocks need copy controls, language labels, and long-output collapse.
   - Tables remain readable at narrow sidebar widths.
   - User images keep current thumbnail/caption behavior.
   - Charts, PDFs, artifacts/canvas, and interactive widgets are deferred.

## Implementation plan

### 1. Lock the visual contract for the chat surface

- Files:
  - Modify `extension/src/webview/panel/mockup-description.md`.
  - Modify `extension/src/webview/panel/styles/tokens.css`.
  - Modify `extension/src/webview/panel/styles/index.css` only if import order changes are needed.
- What:
  - Extend the existing **Quiet instrumentation panel** mockup with the chat-turn refinements: stable assistant shell, turn activity strip, clearer assistant-side instrumentation, code-block controls, and recovery affordances.
  - Add or normalize CSS tokens for message widths, current-turn min heights, activity chip widths, motion durations, and reduced-motion-safe transitions.
  - Decide the CSS source-of-truth before moving rules: either migrate existing CSS tests off `extension/src/webview/panel/panel.css` to the shard files/build entrypoint, or keep `panel.css` synchronized in the same change. Do not add new shard-only tests while old tests still validate stale aggregate CSS.
  - Move transcript-only styles such as `.message-glow-indicator` out of `context-menu.css` into `transcript.css` so ownership is clear.
- Tests:
  - Update CSS tests such as `extension/test/tool-call-heading-css.test.ts` and `extension/test/tool-call-status-css.test.ts` to use the chosen CSS source-of-truth.
  - Add/adjust CSS source tests in `extension/test/` to assert status chip width tokens and that transcript-only classes are not defined in `styles/context-menu.css`.
  - Run `npm run test -- --package extension`.

### 2. Replace string-only activity labels with a structured current-turn status model

- Files:
  - Modify `extension/src/webview/panel/transcript/activity.ts`.
  - Modify `extension/src/webview/panel/transcript/virtual-list.tsx`.
  - Modify `extension/src/webview/panel/transcript/virtual-list-rows.ts`.
  - Modify `extension/src/webview/panel/transcript/rows/typing-indicator-row.tsx`.
  - Modify `extension/src/webview/panel/transcript/message-item.tsx`.
  - Modify `extension/test/ui-loading-states.test.ts` and `extension/test/transcript-virtual-list-rows.test.ts`.
- What:
  - Introduce a `TurnActivityState` type derived from existing `busy`, transcript messages, pruning settings, pending model/thinking, and running tool calls. Keep this derivation webview-local/derived; do not add host state unless interrupt-specific UI later requires it.
  - Treat `TurnActivityState` as the **in-flight** status model. It should represent `preparing`, `pruning`, `startingModel`, `thinking`, `runningTool`, and `streaming` only while `busy` is true.
  - Keep terminal states (`interrupted`, `error`) owned by message status/error UI, not the live activity strip, to avoid duplicate visual and ARIA announcements.
  - Define deterministic precedence: explicit streaming assistant wins over generic thinking; running tool wins over thinking; pruning/start-model placeholders suppress duplicate standalone typing rows; terminal message errors render recovery UI but do not produce a busy activity row unless the session is actually busy on a later turn.
  - Include fields such as `label`, `detail`, `tone`, `ariaLabel`, `runningToolName`, `runningToolSummary`, and `pendingModelLabel` where available.
  - Preserve `derivePendingActivityLabel(...)` as a compatibility wrapper during the refactor or update all call sites in one slice.
  - Use existing tool-call data to show specific activity like `running read`, `running subagent`, or `running 3 tools` rather than only `running tools`.
- Tests:
  - Unit-test phase selection for: no assistant yet, pruning pending, pruning result then model start, running tool call, active streaming assistant, and not-busy interrupted/error assistant messages.
  - Unit-test that terminal interrupted/error messages keep their existing message status UI without generating duplicate activity rows.
  - Unit-test that `buildTranscriptRows(...)` still produces stable placeholder rows and suppresses duplicate typing indicators.
  - Render-test the typing row and inline activity row in `extension/test/webview-render.test.ts`.

### 3. Add a stable turn activity strip inside the assistant turn

- Files:
  - Create `extension/src/webview/panel/transcript/turn-activity-strip.tsx`.
  - Modify `extension/src/webview/panel/transcript/rows/typing-indicator-row.tsx`.
  - Modify `extension/src/webview/panel/transcript/message-item.tsx`.
  - Modify `extension/src/webview/panel/styles/transcript.css`.
  - Modify `extension/src/webview/panel/styles/tool-call.css` only if shared chip classes are extracted.
  - Modify `extension/test/webview-render.test.ts`.
- What:
  - Render one reusable activity strip for both standalone waiting rows and inline assistant-turn activity.
  - Place the strip inside the assistant placeholder/current assistant message when one exists; use a standalone row only for truly empty transcripts or pre-assistant states where no message shell is available.
  - Use the existing status-chip visual language: small dot, monospace uppercase label, subtle tone surface, and compact detail text.
  - Reserve a stable min-height for the strip so phase changes from `pruning` → `starting model` → `thinking` do not change row shape dramatically.
  - Expose clear ARIA status text while keeping decorative animations hidden from assistive tech.
  - Keep motion to one subtle underline/dot pulse and disable it under `prefers-reduced-motion`.
- Tests:
  - Render-test standalone and inline variants with label/detail/tone.
  - Verify no duplicate `role="status"` spam for the same phase inside one row.
  - CSS source-test reduced-motion coverage for the new animation class.

### 4. Stabilize assistant message layout during streaming

- Files:
  - Modify `extension/src/webview/panel/transcript/message-item.tsx`.
  - Modify `extension/src/webview/panel/styles/transcript.css`.
  - Modify `extension/src/webview/panel/transcript/use-buffered-text.ts` only if text reveal tuning is needed.
  - Modify `extension/test/ui-loading-states.test.ts` and CSS source tests in `extension/test/`.
- What:
  - Add explicit state classes such as `streaming`, `current-turn`, and `has-activity` to assistant message containers.
  - Stop active assistant bubbles from using content-fit width while streaming; use a stable width such as `width: min(var(--message-assistant-width), 100%)` with a max width token that adapts to narrow sidebar widths.
  - Keep completed short assistant replies visually compact if desired, but never allow a streaming message to grow horizontally token-by-token.
  - Reserve enough vertical room for the first assistant line/status strip to prevent a blank-to-card jump after send.
  - Keep virtualized row height updates measured by the virtualizer; do not animate row height or `top` positioning.
  - Tune `useBufferedText` only if tests/visual inspection show trailing lag or first-chunk snap; maintain the existing fast baseline so the UI feels alive rather than slow.
- Tests:
  - Source-test that streaming/current-turn classes are emitted for the last busy assistant row.
  - CSS source-test that `.message.role-assistant.streaming` or equivalent uses stable width and does not rely on `width: fit-content`.
  - Keep the existing buffered-text rate assertions in `ui-loading-states.test.ts` passing.

### 5. Tighten message headers without adding redundant user chrome

- Files:
  - Modify `extension/src/webview/panel/transcript/header.ts`.
  - Modify `extension/src/webview/panel/transcript/message-item.tsx`.
  - Modify `extension/src/webview/panel/styles/transcript.css`.
  - Modify `extension/test/transcript-header.test.ts` and `extension/test/webview-render.test.ts`.
- What:
  - Keep user-message identity implicit through the existing right alignment and styling; do not add a `You` label.
  - Keep assistant `PI` identity visible and group metadata consistently: time, model, thinking level, duration, token usage when available, and status.
  - Preserve the current click-to-edit behavior and cursor/button affordance for user messages without adding explicit edit hint copy or extra edit chrome.
  - Refine spacing, hierarchy, and metadata grouping so assistant turns scan more clearly while user turns stay visually light.
- Tests:
  - Header-format tests for model/thinking/duration/usage combinations.
  - Render tests showing assistant status metadata remains visible in narrow output while user messages keep their alignment-based identity.

### 6. Improve graceful failure and retry affordances

- Files:
  - Modify `extension/src/webview/panel/transcript/message-item.tsx`.
  - Modify `extension/src/webview/panel/transcript/virtual-list-rows.ts` if previous-user context is needed for retry actions.
  - Modify `extension/src/webview/panel/app.tsx` if new retry/edit callbacks must be passed down.
  - Modify `extension/src/shared/protocol.ts`, `extension/src/shared/protocol-validation.ts`, `extension/src/host/extension-host.ts`, and `extension/src/host/core/*` only if a new explicit `retryFromMessage` / `regenerate` command is chosen instead of reusing `editMessage`.
  - Modify `extension/src/webview/panel/styles/transcript.css`.
  - Modify `extension/test/webview-render.test.ts`, `extension/test/sync-contract.test.ts`, and relevant host reducer/effect tests if protocol changes are made.
- What:
  - Keep the current `ErrorDetail` truncation/More/Dismiss behavior.
  - Add a copy-detail affordance to message-level errors matching failed tool/subagent chips.
  - For failed or interrupted assistant turns, show an explicit recovery action near the error: `Retry from previous prompt` or `Edit previous prompt`.
  - Respect transcript windowing: only show an enabled retry/edit action when the previous user message is present in the loaded `transcriptWindow`. If it is outside the loaded slice, show a disabled explanation such as `Load older messages to retry` and reuse the existing older-page controls instead of guessing from unloaded history.
  - Prefer reusing the existing edit flow behind those recovery actions: editing a previous user message already truncates/resends through `editMessage`. Do not add extra always-visible edit hints to normal user messages, and only add a new protocol command if one-click regenerate cannot be expressed cleanly with existing commands.
  - Surface failed-send draft restoration with a concise notice/hint when possible, without duplicating the global notice banner.
- Tests:
  - Render-test failed assistant messages with detail, copy affordance, and retry/edit action.
  - Unit-test any row context added to associate an assistant failure with the previous user message, including the partial-window case where that user message is not loaded.
  - If a new protocol message is added, update protocol validation and CQRS reducer/effect tests.

### 7. Upgrade dense markdown/code rendering without changing the backend protocol

- Files:
  - Create or modify `extension/src/webview/panel/transcript/markdown-body.tsx` if the string renderer needs a wrapper component.
  - Modify `extension/src/webview/panel/markdown.ts` only for safe renderer configuration changes.
  - Modify `extension/src/webview/panel/transcript/message-item.tsx` and `ReasoningBlock` usage to use the wrapper.
  - Modify `extension/src/webview/panel/styles/transcript.css`.
  - Modify `extension/test/webview-render.test.ts` and add markdown-focused tests if needed.
- What:
  - Keep `marked` + `DOMPurify` sanitization.
  - Add code-block affordances after sanitized render: language label when present, Copy button, and collapse/expand for long blocks.
  - Avoid adding a heavyweight syntax-highlighting dependency in this pass; rely on VS Code code-block colors unless a later visual review proves syntax highlighting is worth the bundle cost.
  - Improve table overflow handling for narrow sidebar widths with horizontal scrolling and sticky-ish headers only if it does not harm theme compatibility.
  - Preserve current user image rendering and captions.
- Tests:
  - Render-test code blocks with language labels and copy buttons.
  - Test long code block collapse threshold and expand control.
  - Test table wrapper/overflow markup.
  - Add sanitization regression coverage for copied/enhanced markdown so controls do not introduce unsafe HTML.

### 8. Polish composer-to-transcript continuity

- Files:
  - Modify `extension/src/webview/panel/ui.tsx`.
  - Modify `extension/src/webview/panel/composer/toolbar.tsx`.
  - Modify `extension/src/webview/panel/styles/composer.css` and `styles/transcript.css`.
  - Modify `extension/test/app-smoke.test.ts` and `extension/test/webview-render.test.ts` if render output changes.
- What:
  - Keep the existing Send/Stop behavior, model/thinking selectors, context indicators, and token-rate display.
  - Make the busy composer placeholder more specific by reusing `TurnActivityState` when available, e.g. `Agent is pruning skills/tools…` rather than only `Waiting for a response...`.
  - Ensure the Jump to latest button remains positioned above the composer using `--composer-height` and does not overlap new status surfaces.
  - Preserve draft restore behavior on failed sends.
- Tests:
  - Smoke-test composer still sends, stops, restores drafts, and renders with active session state.
  - CSS source-test Jump to latest still uses `--composer-height` and remains above the composer.

## Verification plan

Before implementation, capture the current extension verification baseline. If `cd extension && npm run typecheck` is already red for unrelated reasons, either fix that baseline first or document the existing failures and require this UI work to introduce no new typecheck errors.

Run these before considering implementation complete:

```bash
npm run test -- --package extension
cd extension && npm run typecheck
cd extension && npm run build
```

Manual verification in the VS Code sidebar:

- Send a prompt while backend/model startup is slow: user message appears immediately, stable assistant shell appears, status advances without jumping.
- Stream a long response: assistant bubble width stays stable, text reveal is smooth, auto-scroll follows only while the user is at the bottom.
- Scroll up during streaming: transcript does not yank the user back down; Jump to latest appears above composer.
- Run a tool and a subagent: activity strip names the current phase/tool, and tool/subagent cards keep their collapsed summaries and status chips.
- Interrupt generation: Stop works, status does not stick forever, interrupted turn is understandable.
- Trigger a failed send/backend error: draft is preserved or restored, error detail is copyable, retry/edit path is visible.
- Render code blocks, tables, long outputs, and user images in light/dark/high-contrast themes.
- Repeat with `prefers-reduced-motion: reduce` enabled.

## Out of scope for this pass

- Conversation branching.
- Artifacts/canvas/workspace documents separate from chat.
- Persistent memory or project spaces beyond existing sessions/tabs.
- Shareable conversations.
- Full PDF/chart/diagram/widget rendering.
- Backend model/provider behavior changes.
- A heavyweight syntax-highlighting dependency unless approved after a bundle/performance review.
- Rebuilding the file-changes panel or session tabs, except where they overlap current chat status.

## Acceptance criteria

- The main chat area communicates the current agent phase at a glance without relying on generic loading text.
- Streaming assistant replies do not resize horizontally token-by-token.
- The current turn has one coherent visual home from immediate acknowledgement through final response.
- Message ownership remains clear through alignment/styling, while assistant metadata and recovery actions stay compact enough for a VS Code sidebar.
- Errors preserve user work and expose clear recovery actions.
- Code and long structured outputs are easier to scan/copy without overwhelming normal prose replies.
- Existing host/webview state ownership remains intact: durable logic state stays in the host; webview additions are derived view state, animation, or interaction state allowed by `docs/STATE_CONTRACT.md`.
- Extension tests and build pass after implementation; typecheck is green or has a documented pre-existing baseline with no new errors from this work.

## Reviewer loop notes

- Initial plan written from current source inspection on 2026-05-29.
- Adversarial review pass 1 found issues around CSS test source-of-truth, partial-window retry behavior, in-flight vs terminal activity precedence, and current typecheck baseline realism.
- Plan updated to address those issues before the second review pass.
- Adversarial review pass 2 approved the revised plan with no remaining blockers.
