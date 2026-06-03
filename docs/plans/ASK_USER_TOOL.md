# Plan: `ask_user` tool — agent-initiated clarification questions in the pie UI

## Goal

Give agents a structured way to ask the user a question with a few suggested options **plus** a free-form "write your own" answer, the way OpenCode / Copilot Chat do. The question must appear in the pie VS Code extension panel, block the agent until the user responds, and route the answer back to the agent as the tool result.

## Background — what already exists

The required plumbing is **almost entirely already in place**. Do not re-invent it.

- **pi RPC (upstream)** already defines an `extension_ui_request` / `extension_ui_response` sub-protocol on top of the normal RPC stream. Methods: `select`, `confirm`, `input`, `editor`, plus fire-and-forget `notify`/`setStatus`/`setWidget`. See:
  - `C:\Users\ocjla\AppData\Roaming\npm\node_modules\@mariozechner\pi-coding-agent\docs\rpc.md` §"Extension UI Protocol"
  - `C:\Users\ocjla\AppData\Roaming\npm\node_modules\@mariozechner\pi-coding-agent\docs\extensions.md` §"Custom UI" / "Dialog methods"
- **pie backend** already relays these requests/responses end-to-end:
  - `extension/src/backend/extension-ui-bridge.ts` — bridges pi stdio ↔ pie protocol.
  - `extension/src/backend/request-handler.ts`, `server.ts`, `server-types.ts` — wiring.
  - `extension/src/host/backend/client.ts`, `extension/src/host/extension-host.ts`, `extension/src/host/session-service/event-dispatch.ts` — host-side fan-out.
  - `extension/src/shared/protocol.ts` — defines `ExtensionUIRequestPayload` / `ExtensionUIResponsePayload` and the `extensionUiResponse` webview→host message.
- **pie webview** already renders dialogs:
  - `extension/src/webview/panel/extension-ui-prompt.tsx` — `ConfirmPrompt`, `SelectPrompt`, `InputPrompt`, countdown hook, full styling already done.
  - Dev fixture: `extension/src/webview/panel/dev-fixtures.ts` (`/?state=extension-ui`) for manual visual QA via `npm run webview:dev`.

What is **missing**:
1. The agent has no advertised tool that maps cleanly to "ask the user a question". `ctx.ui.select()` etc. are extension primitives, not LLM-callable tools.
2. `SelectPrompt` does not support a free-form alternative inline — picking "write my own" today would require a two-dialog UX.

## Design

### Approach

Add a new pi extension at `extensions/ask-user/` that registers a single tool `ask_user`. The tool's `execute()` calls `ctx.ui.select()` (which pi serializes as `extension_ui_request` → pie webview), and if the user picked the "write your own" sentinel, follows up with `ctx.ui.input()`. The tool returns the chosen / typed answer as text content so it is folded back into the agent's context as a normal tool result.

Optionally — and recommended for UX parity with Copilot/OpenCode — enhance pie's `SelectPrompt` to render an inline text field when a sentinel option string is present, so the user can pick a preset *or* type a custom answer in one dialog instead of two.

This split keeps the agent-facing contract pure pi (works in `pi` TUI too, just renders as a TUI select then input) while letting pie offer richer UX.

### Tool contract

```ts
// extensions/ask-user/src/types.ts
import type { Static } from "typebox";
import { Type } from "typebox";

export const askUserSchema = Type.Object({
  question: Type.String({
    description: "The question to present to the user. One sentence, focused.",
  }),
  options: Type.Array(
    Type.String({ description: "A suggested short answer (~1–6 words)." }),
    { minItems: 0, maxItems: 6, description: "Preset answers the user can pick in one click." },
  ),
  allowCustom: Type.Optional(Type.Boolean({
    default: true,
    description: "Whether the user may type a free-form answer instead of picking an option.",
  })),
  context: Type.Optional(Type.String({
    description: "Optional one-paragraph rationale shown under the question.",
  })),
});

export type AskUserInput = Static<typeof askUserSchema>;
```

Tool result shape:

```ts
{
  content: [{ type: "text", text: <answer string, or "[user cancelled]"> }],
  details: { answer: string; source: "option" | "custom" | "cancelled"; cancelled: boolean },
  isError: false, // even cancellation is not an error — agent decides what to do
}
```

### Sentinel for "write your own"

Use a single fixed sentinel string the extension prepends/appends to `options[]` when `allowCustom !== false`:

```
const CUSTOM_SENTINEL = "✎ Write my own answer…";
```

- pi TUI: renders as a normal extra option. Picking it triggers `ctx.ui.input()` follow-up. Works today, no pi-side changes.
- pie webview (enhanced): `SelectPrompt` detects the sentinel and renders an inline `<input>` row below the option buttons instead of a clickable button. Submitting that input returns its value directly via one `extension_ui_response`, skipping the follow-up dialog entirely.

The sentinel is exported from the extension so both ends agree. Choose a distinctive unicode prefix so it never collides with a real answer.

## Implementation steps

### 1. New pi extension: `extensions/ask-user/`

Mirror the layout of `extensions/safeguard/` (single-purpose, has tests).

```
extensions/ask-user/
  package.json            # name "ask-user", pi.extensions: ["./src/index.ts"]
  tsconfig.json           # copy from safeguard
  src/
    index.ts              # factory, registerTool
    types.ts              # schema + sentinel constant + AskUserInput
    ask.ts                # core execute() — pure-ish, takes a small UI port for testability
  test/
    ask.test.ts           # vitest, mocks the UI port
```

`src/index.ts` skeleton:

```ts
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { askUserSchema, CUSTOM_SENTINEL } from "./types";
import { runAsk } from "./ask";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "ask_user",
    label: "Ask user",
    description:
      "Ask the user a clarifying question with a few preset answers and an optional free-form reply. " +
      "Use only for decisions you genuinely cannot make on your own (ambiguous intent, irreversible choices, " +
      "missing key context). Do NOT use for routine progress updates.",
    promptSnippet:
      "Ask the user a clarifying question; pauses the agent until the user picks an option or types a reply.",
    promptGuidelines: [
      "Use ask_user only when you cannot reasonably proceed without a user decision.",
      "Prefer offering 2–4 concrete options over open-ended questions.",
      "Never use ask_user for status updates or to ask permission for already-described actions.",
    ],
    parameters: askUserSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return runAsk(params, { ui: ctx.ui, signal });
    },
  });
}
```

`src/ask.ts`:

```ts
import type { AskUserInput } from "./types";
import { CUSTOM_SENTINEL } from "./types";

export interface AskPort {
  ui: {
    select(title: string, options: string[], opts?: { timeout?: number; signal?: AbortSignal }): Promise<string | undefined>;
    input(title: string, placeholder?: string, opts?: { timeout?: number; signal?: AbortSignal }): Promise<string | undefined>;
  };
  signal?: AbortSignal;
}

export async function runAsk(input: AskUserInput, port: AskPort) {
  const allowCustom = input.allowCustom !== false;
  const title = input.context ? `${input.question}\n\n${input.context}` : input.question;
  const options = [...input.options];
  if (allowCustom) options.push(CUSTOM_SENTINEL);

  const picked = await port.ui.select(title, options, { signal: port.signal });
  if (picked === undefined) return cancelled();

  if (picked !== CUSTOM_SENTINEL) return answered(picked, "option");

  const custom = await port.ui.input("Your answer", undefined, { signal: port.signal });
  if (!custom || !custom.trim()) return cancelled();
  return answered(custom.trim(), "custom");
}

function answered(answer: string, source: "option" | "custom") {
  return {
    content: [{ type: "text" as const, text: answer }],
    details: { answer, source, cancelled: false },
  };
}
function cancelled() {
  return {
    content: [{ type: "text" as const, text: "[user cancelled the question]" }],
    details: { answer: "", source: "cancelled" as const, cancelled: true },
  };
}
```

Tests (`test/ask.test.ts`) cover: picks an option, picks sentinel then types custom, picks sentinel then cancels input, cancels select dialog, custom-disabled path. Use a fake `AskPort` — no pi runtime needed. Add the package id to the root `npm run test` runner per AGENTS.md (`ask-user`).

Register the extension globally by placing it under `~/.pi/agent/extensions/` *or* (preferred for this repo) by adding the project path to `settings.json` under `extensions: [...]`, the same way other custom extensions are wired. Verify against the existing `extensions/subagent` entry as the canonical example.

### 2. (Optional but recommended) pie `SelectPrompt` enhancement

Add inline custom-answer support to `SelectPrompt` in `extension/src/webview/panel/extension-ui-prompt.tsx`.

Detection: import `CUSTOM_SENTINEL` from a shared constant (duplicate the string literal in `extension/src/shared/` to avoid an extension→webview dependency on the `ask-user` package; document that the two must stay in sync, or expose a small `extension/src/shared/ask-user-sentinel.ts` and re-export it from the extension).

Behavior when `options.includes(SENTINEL)`:
- Render the non-sentinel options as the existing buttons.
- Render a labeled `<input>` (and Send button) inline at the bottom, plus the Cancel button.
- On Enter / Send: respond with `{ id, value: <typed text> }` — same shape as picking an option. Because the typed value isn't equal to the sentinel, the extension's `runAsk` short-circuits into the "option" branch and treats it as the answer in **one** round-trip. (The follow-up `ctx.ui.input()` never fires.)
- Picking any preset option still works as before.

Keep keyboard behavior: Escape cancels, Enter in the input submits, arrow keys focus through buttons (current SelectPrompt has minimal focus handling — preserve at least the existing baseline).

Update the `/?state=extension-ui` dev fixture in `extension/src/webview/panel/dev-fixtures.ts` to include an `ask_user`-shaped select request with the sentinel option so the new path is visible under `npm run webview:dev`.

### 3. Wiring & verification

- Build: `cd extension && npm run build` (per AGENTS.md, sync to installed extension).
- Webview QA: `cd extension && npm run webview:dev`, hit `/?state=extension-ui` in both `&theme=light` and `&theme=dark`, exercise the new ask_user fixture (pick preset, type custom, cancel).
- Tests: `npm run test -- --package ask-user` and `npm run test -- --package extension` (the latter for any added webview unit coverage).
- Manual end-to-end in pie: launch the panel, ask the agent something that should trigger clarification ("rename `foo` everywhere, but I'm not sure if I want camelCase or snake_case — use ask_user to confirm"), confirm the dialog appears, that picking an option resumes the agent, and that the tool result message in the transcript shows the chosen answer.

### 4. System prompt nudge (only if needed)

If the agent ignores the tool in practice, add a short bullet via `APPEND_SYSTEM.md` ("If you face an ambiguous decision that meaningfully affects the user's outcome and cannot be resolved by reading files, call `ask_user` with 2–4 concrete options before proceeding."). Prefer leaving this to the tool's `promptGuidelines` first and only fall back to `APPEND_SYSTEM.md` if behavior is poor.

## Out of scope

- Changes to upstream `pi` (its `extension_ui_request` schema). The sentinel-string approach exists precisely to avoid touching pi.
- A new top-level pie protocol message. Reuse the existing `extension_ui_request` / `extensionUiResponse` round trip.
- Persistence: cancelled / completed questions do not need any special session storage beyond the normal tool-call/tool-result entries pi already records.
- Multi-question batching / forms — `ask_user` is intentionally single-question. If a wizard is ever needed, that's a separate `ask_user_form` tool built on `ctx.ui.custom()` (TUI) + a new pie webview component.

## Acceptance criteria

1. A new package `extensions/ask-user/` exists, with tests passing under `npm run test -- --package ask-user`, and its id wired into the root test runner.
2. With the extension loaded, the agent can call `ask_user` and the pie panel shows a single dialog with the question, the preset options as buttons, and a "write your own" inline input (or, if the enhancement is deferred, a two-step select-then-input flow).
3. Submitting (button click, typing + Enter, or Cancel) resumes the agent and yields a normal `toolResult` message whose text content is the user's answer or `"[user cancelled the question]"`.
4. The `/?state=extension-ui` dev fixture demonstrates the new variant in both themes.
5. Building `extension/` succeeds and the live panel works against a real session.

## File-by-file checklist for the implementing agent

- [ ] `extensions/ask-user/package.json`, `tsconfig.json` — copy structure from `extensions/safeguard/`.
- [ ] `extensions/ask-user/src/types.ts` — schema + `CUSTOM_SENTINEL` + `AskUserInput`.
- [ ] `extensions/ask-user/src/ask.ts` — `runAsk()` with injected `AskPort`.
- [ ] `extensions/ask-user/src/index.ts` — `registerTool` wiring with description/promptSnippet/promptGuidelines.
- [ ] `extensions/ask-user/test/ask.test.ts` — 5 cases above.
- [ ] Root test runner registration (see `package.json` / runner script) for package id `ask-user`.
- [ ] `settings.json` (or `~/.pi/agent/extensions/`) entry so pi auto-loads the extension.
- [ ] `extension/src/shared/ask-user-sentinel.ts` — single source of truth for the sentinel string; re-export from the extension's `types.ts`.
- [ ] `extension/src/webview/panel/extension-ui-prompt.tsx` — extend `SelectPrompt` with inline custom-input rendering gated on sentinel presence.
- [ ] `extension/src/webview/panel/dev-fixtures.ts` — add an ask_user fixture.
- [ ] `cd extension && npm run build && npm run test && npm run typecheck`.
- [ ] Manual end-to-end smoke test in the installed VS Code panel.

## Risks & notes

- **Pi may disable the tool by default.** `pi.registerTool` adds the tool but the active set is controlled by `pi.setActiveTools()` / settings. Verify the new tool appears in `Available tools` in the system prompt after a session restart; if not, add it to the project's active tools list.
- **Sentinel collision.** Pick a string a real user would never type as a literal answer; the recommended `"✎ Write my own answer…"` is safe. Document it clearly.
- **Timeouts.** Do not pass a `timeout` from the tool — clarification questions should block indefinitely; the user is in charge. The agent loop is paused for the duration; this is intentional and matches `ctx.ui.select()` semantics.
- **Cancellation.** A cancelled dialog must produce a non-error tool result so the agent can recover gracefully (e.g., re-plan or ask differently) rather than aborting the turn.
- **STATE_CONTRACT compliance.** No new host state is required. The dialog request lives in the existing per-session extension-UI overlay channel; webview-local input value is allowed as "per-keystroke draft buffer inside an active input" per `docs/STATE_CONTRACT.md`. Do not add any host-store fields for this feature.
