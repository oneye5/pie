# PI Assistant Migration Plan

## Purpose

Restore the extension to a working, testable baseline and then migrate the chat UI in small, reversible steps. The end state is still a minimal, transparent PI Assistant experience in the VS Code sidebar, but the plan now prioritizes recovery and validation over speculative framework work.

## Guiding Principles

- Recovery before redesign. No new UX work lands until the extension builds, activates, and renders a minimal sessions view.
- One active path at a time. Do not keep parallel sidebar and panel implementations alive unless both are intentional, wired, and tested.
- Preserve proven native attachment flows. Reliable file attachment comes from the native `AttachmentDropView`, Explorer actions, and file picker flows, not raw DOM drop in a webview.
- Defer irreversible tech decisions until the baseline is healthy. Framework swaps are justified only when they reduce complexity for a real requirement.
- Every phase ends with an executable feedback loop: build, tests, or manual validation against explicit exit criteria.

## Confirmed Current State

**Migration complete (Phases 0–6).** The extension builds, all tests pass (78/78), and the implementation matches this plan.

- `src/host/sidebar-provider.ts` — revision-based snapshot/patch posting, implements `vscode.WebviewViewProvider`.
- `src/host/session-service.ts` — session lifecycle owner: backend process management, event → Redux dispatch bridge.
- `src/webview/panel/panel.tsx` — Preact webview with session tabs, streaming transcript, tool call cards, reasoning blocks, composer with file picker and attachments.
- `scripts/build.mjs` — bundles `src/webview/panel/panel.tsx` → `out/webview/panel/panel.js`; copies `index.html` + `panel.css`.
- `test/file-drop.test.ts` — imports from `../src/webview/panel/file-drop` (fixed).
- `npm run build` passes. `npm test` passes (78 tests).

**Phase 5 features deferred (not yet implemented):**
- Nested transcript sections for subagent work.
- Inline approval cards instead of modal interruptions.
- Live context inspector for attached files/snippets.
- Developer diagnostics panel behind an explicit toggle.

## Stable Decisions

These choices are stable enough to plan around now.

| Decision | Choice | Why it stays |
|---|---|---|
| Primary workbench surface during this migration | Sidebar `WebviewView` | It matches the current extension contributions, avoids editor-cover behavior, and preserves full custom rendering control. |
| Attachment strategy | Native `AttachmentDropView` + Explorer / picker flows | Reliable in VS Code today; raw DOM file drop in a webview is not. |
| Host orchestration | Keep host-side Redux store for now | It already exists and should not be rewritten during baseline recovery. |
| Backend boundary | Host owns PI process lifecycle; webview never talks to backend directly | Keeps process management, persistence, and session control in one place. |

## Decisions to Defer Until Phase 1

The previous draft locked in a full frontend stack before the extension even built. That is backwards. These decisions should be made only after a minimal shell is rendering again.

- Keep the existing Preact/esbuild path and rebuild the sidebar incrementally, or adopt React only if the recovery spike shows a clear payoff.
- Introduce a dedicated webview store only when the host-to-webview state shape is stable enough to justify it.
- Add runtime schema validation after the message envelope is settled; do not block baseline recovery on new validation infrastructure.
- Add transcript virtualization only when the rebuilt transcript proves it needs it.

Decision criteria for any stack change:

- Fewer moving parts than the current alternative.
- Clear testability win.
- No regression in VS Code theming or accessibility.
- No second migration nested inside the first one.

## What Must Survive the Migration

| File or area | Keep | Reason |
|---|---|---|
| `src/backend/index.ts` | Yes | PI backend process management remains the core runtime. |
| `src/backend/rpc.ts` | Yes | Existing transport layer. |
| `src/backend/transcript.ts` | Yes | Transcript semantics already live here. |
| `src/host/backend-client.ts` | Yes | Existing backend client abstraction. |
| `src/host/attachment-drop-view.ts` | Yes | Proven native attachment bridge. |
| `src/host/store.ts` | Yes, unless a later focused refactor replaces it | Current host orchestration source of truth. |
| `src/shared/protocol.ts` | Yes | Shared contract boundary should stay centralized. |
| `src/webview/panel/file-drop.ts` | Yes | Useful parser logic regardless of final webview entry point naming. |

## Migration Phases

### Phase 0: Restore a Single Compiling Path

Goal: make the extension build and render one minimal sessions surface again.

- Choose one webview entry strategy and commit to it for the recovery pass.
- Either recreate a minimal `src/webview/sidebar/` shell to match the current build and package contributions, or retarget the build pipeline to a new sidebar-backed entry point under `src/webview/panel/` and update all references together.
- If the build pipeline is retargeted, update `scripts/build.mjs` completely: entry point, copied HTML/CSS assets, and any output paths that still assume `webview/sidebar/`.
- Add the missing host pieces (`SessionService` and `SidebarViewProvider`) or replace those references with a simpler owner if that reduces duplication. Do not leave phantom imports behind.
- Keep `PiAssistantExtension` as a composition root only: register commands, wire provider/service/backend, and avoid pushing session logic back into it.
- Ensure the sessions view can resolve HTML/JS/CSS, even if the UI is only a placeholder shell.
- Ensure the native attachments view still registers.
- Delete the abandoned webview path once the chosen entry point is working. The repo should not carry both `src/webview/sidebar/` and `src/webview/panel/` as live candidates after this phase unless both are intentionally wired and tested.
- Run `npm run build` and `npm test` before leaving this phase.

Exit criteria:

- `npm run build` passes.
- One webview entry point exists, builds, and renders; the abandoned path is removed or clearly marked as inert.
- Tests either pass or remaining failures are unrelated, named, and documented in this plan or a linked follow-up issue list before new feature work resumes.
- Activating the extension shows a sessions view without runtime errors.

### Phase 1: Stabilize Host and Protocol Boundaries

Goal: make the host logic trustworthy before adding richer UI.

- Extract or finish the session lifecycle owner so one module is responsible for backend start, restart, session create/open/close, send, interrupt, and persistence.
- Define the smallest useful host-to-webview state model: active session, session list, transcript, busy state, attachments, model prefs, and notices.
- Keep a single message envelope with discriminated `type` values in `src/shared/protocol.ts`.
- Add protocol tests around the host/webview contract and any patch or snapshot sequencing.
- Decide whether the webview naming mismatch (`panel` directory backing a sidebar view) should be fixed now or explicitly carried as a documented historical artifact.

Exit criteria:

- Host-side session actions work without the UI owning backend concerns.
- Snapshot and incremental update semantics are documented and tested.
- Session restore and model preference hydration behave deterministically.

### Phase 2: Rebuild the Minimal Sidebar Shell

Goal: bring back a usable sessions UI with the smallest possible surface area.

- Render a basic transcript list, composer, session switcher, and status/error area.
- Wire `send`, `requestSnapshot`, `newSession`, and `openSession` end to end.
- Theme the shell with VS Code tokens and verify light, dark, and high-contrast behavior.
- Keep the implementation simple. If a framework change is approved, land it here only once the replacement shell already exists in the same phase.
- Add focused tests for the webview bridge and minimal state handling.

Exit criteria:

- The sidebar opens a real webview UI rather than a placeholder.
- A typed message from the composer reaches the host and the host can echo or stream data back.
- The shell is theme-safe and keyboard-usable.

### Phase 3: Transcript, Streaming, and Error Surfaces

Goal: recover the core chat experience.

- Stream assistant output into the transcript.
- Render tool calls, reasoning blocks, error states, and file-edit cards.
- Support snapshot recovery if the webview misses updates.
- Add diff-opening integration for file edit cards.
- Introduce virtualization only if transcript length makes it necessary and the chosen UI stack supports it cleanly.
- Add integration tests around streaming, patch ordering, and transcript recovery.

Exit criteria:

- A complete PI session can be driven from the sidebar.
- Streaming and reconnect behavior are reliable under reload or focus changes.
- Tool and error output are visible without leaving the transcript.

### Phase 4: Composer and Attachment UX

Goal: recover the high-value interaction model.

- Preserve the native attachments view as the reliable drop target.
- Support attach via Explorer context menu, file picker, pasted paths, and the native tray flow.
- Add queue-while-streaming, interrupt, and edit-and-resend.
- Add tooltips, keyboard shortcuts, and message-level context actions only after the core composer flow is stable.
- Verify accessibility and focus handling.

Exit criteria:

- Users can attach files through every supported native path.
- Composer interactions remain responsive while streaming.
- Edit, resend, queue, and interrupt flows are tested and reliable.

### Phase 5: Transparency Features

Goal: implement the differentiators only after the baseline chat flow is solid.

- Nested transcript sections for subagent work.
- Expandable tool detail cards with arguments, results, and timing.
- Inline approval cards instead of modal interruptions.
- Live context inspector for currently attached files or snippets.
- Developer diagnostics behind an explicit toggle.

Exit criteria:

- A user can inspect what the agent did, on which inputs, and with what result from the transcript alone.
- Transparency features do not destabilize the core session flow.

### Phase 6: Hardening and Rollout

Goal: remove migration debt and verify the system as a product, not just as a demo.

- Delete dead entry points, unused assets, and orphaned migration code.
- Update README and any contributor docs that describe the extension surface or startup flow.
- Re-check document drift so this plan matches the actual implementation.
- Run the validation matrix below before calling the migration complete.

Exit criteria:

- The implemented surface matches the documented surface.
- No stale entry points or phantom files remain in the build.
- Validation passes across supported themes and core workflows.

## Validation Matrix

- `npm run build`
- `npm test`
- Activate extension and open the sessions view
- Create a session, reopen an existing session, and restore after reload
- Send a message and verify streamed response rendering
- Interrupt a response mid-stream and verify backend cancellation
- Queue multiple messages while a response is still streaming
- Edit and resend a prior user message
- Attach from Explorer, file picker, and native attachments view
- Open a file diff from a transcript card
- Verify light, dark, and high-contrast themes
- Verify focus order, keyboard send behavior, and basic screen reader labeling

## First Milestone

The smallest slice worth landing is:

1. The extension builds again.
2. The sessions view renders a minimal sidebar shell.
3. A composer message reaches the host and a response comes back.
4. A file added through the native attachments path appears in the composer flow.
5. A second message can be queued while the first one is still streaming.

If those five checks are not true, the migration is not yet on stable ground.
