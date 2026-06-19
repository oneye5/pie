# Status Indicator UI Mockup Description

## Tone name

**Quiet instrumentation panel** — a compact VS Code-native interface with instrument-style status chips instead of mixed dots and loose text. The design should feel precise, low-noise, and durable in light/dark/high-contrast themes.

## Typography plan

- **Display/status typography:** the user's VS Code editor monospace font via `--vscode-editor-font-family`; 10px, 700 weight, 0.12em tracking, uppercase for status chips and compact metadata.
- **Body typography:** the user's VS Code UI font via `--vscode-font-family`; existing 12–13px panel text preserved for theme consistency and readability.
- **Hierarchy:** status labels use dense monospace instrumentation; message bodies remain softer and more readable.

## Chat-turn refinements

### Assistant turn shell

Every assistant turn gets a stable card that appears immediately after user send — before the first model byte. The shell reserves vertical room so phase changes (pruning → starting model → thinking → streaming) do not jump the transcript.

- The shell uses `--message-assistant-width` (88%) for stable width during streaming, preventing token-by-token horizontal growth.
- A `current-turn` CSS class marks the active turn, providing a hook for activity strip positioning.
- A `has-activity` CSS class reserves `--turn-activity-min-height` (28px) for the activity strip.

### Turn activity strip

A compact inline status row inside the assistant turn, reusing the existing status-chip visual language:

- Small dot, monospace uppercase label, subtle tone surface, and optional compact detail text.
- Stable `min-height: var(--turn-activity-min-height)` so phase changes from `pruning` → `starting model` → `thinking` do not change row shape.
- One subtle underline/dot pulse animation per strip.
- Clear ARIA `role="status"` text while keeping the decorative animation hidden from assistive tech.
- Standalone variant for pre-assistant states (no assistant message shell yet).
- Inline variant rendered inside the assistant turn when a shell exists.

### Code-block controls

Code blocks rendered from markdown get lightweight affordances after sanitized render:

- Language label (when detected from fenced code block info string).
- Copy button using the existing status-chip shell pattern.
- Collapse/expand for blocks exceeding 20 lines, with a `Show more` / `Show less` toggle.

### Failure and recovery affordances

Failed or interrupted assistant turns expose clear recovery paths:

- Copy-detail button on message-level error blocks matching failed tool/subagent chip copy behavior.
- `Retry from previous prompt` action for interrupted/errored turns.
- `Edit previous prompt` action for user-side recovery.
- When the previous user message is outside the loaded transcript window, show a disabled explanation: `Load older messages to retry`.

## Color palette

- **Dominant:** VS Code surfaces (`--vscode-sideBar-background`, `--vscode-editor-background`) layered with subtle alpha mixes.
- **Accent:** `--panel-accent` for running/active instrumentation.
- **Danger:** `--panel-danger` for failed/error states.
- **Warning:** `--panel-warning` for interrupted states.
- **Success:** `--panel-success` reserved for copy confirmation and completion semantics.
- **Background treatment:** faint inset borders and translucent status surfaces rather than loud fills, so the UI adapts to any VS Code theme.

## Motion philosophy

- One high-signal animation only: running statuses breathe with a subtle dot glow.
- Hover transitions stay under 150ms and only adjust surface, border, and lift.

## Spatial composition plan

- Replace the inconsistent subagent dot/text mix with a single chip system: same height, radius, padding, gap, tone dot, label, and copy-confirmation behavior across subagent, tool-call, and message-level status indicators.
- Keep tool-call headers compact but more intentional: improved card radius, inset border, subtle raised surfaces, and consistent hover/focus affordances.
- Preserve existing reserved tool-call status column width so collapsed rows stay aligned.

## Key visual details

- Status chips have an inset outline, soft translucent tone surface, and a 5px signal dot.
- Failed/error chips are clickable when detail is available and expose copy confirmation with the same chip shell rather than changing layout.
- Message error/interrupted badges share the chip language but scale slightly for header readability.
- Tool-call and subagent cards get refined surfaces, subtle shadows, and cleaner nested thread gutters without introducing heavy decoration.
- Clickable error chips expose keyboard focus, Enter/Space copy behavior, and visible focus rings while preserving row expand/collapse interactions.

## Chat-turn refinements

### Stable assistant shell
- The active assistant turn gets an immediate stable visual shell after the user sends a message, before any model output arrives. This prevents a blank-to-card layout jump.
- While streaming, the assistant bubble uses a stable width: `var(--message-assistant-width, 88%)` with `max-width: 100%` instead of content-fit sizing. The width never grows horizontally token-by-token.
- Completed short replies remain visually compact, but streaming messages are never allowed to grow horizontally mid-stream.
- Current-turn status states (`streaming`, `current-turn`, `has-activity`) are emitted as classes on the assistant message container.

### Turn activity strip
- A compact activity strip lives inside the current assistant turn shell, showing structured phase information such as `pruning`, `starting model`, `thinking`, `running tool`, and `streaming`.
- The strip uses the existing status-chip language: small dot, monospace uppercase label, subtle tone surface, and compact detail text.
- A stable `var(--turn-activity-min-height, 22px)` is reserved for the strip so phase changes do not cause vertical snapping.
- For empty transcripts or pre-assistant states without a message shell, a standalone typing indicator row is still available as a fallback.
- ARIA `role="status"` is exposed on the current phase while decorative animations remain hidden from assistive technology.

### Code-block controls
- Every code block rendered via the markdown pipeline gets a language label (when available from the fenced block info string) and a Copy button.
- Long code blocks (threshold determined by a token height check) are collapsed with an expand control.
- No heavyweight syntax-highlighting library is added in this pass — the UI relies on VS Code's built-in code-block colors.
- Copy confirmation uses the standard chip shell rather than changing layout.

### Recovery affordances
- Failed or interrupted assistant turns expose an explicit recovery action near the error: `Retry from previous prompt` or `Edit previous prompt`.
- Failed-send draft content is preserved/restored with a concise notice, avoiding the global notice banner.
- Error detail text keeps the existing truncation/More/Dismiss behavior and adds a copy-detail affordance matching failed tool/subagent chips.
- Retry/edit actions respect transcript windowing: if the previous user message is not in `transcriptWindow`, a disabled explanation such as `Load older messages to retry` is shown instead.

### Motion durations
- Status chip animations use `var(--status-chip-motion-duration, 2.1s)` for consistent pace across tool-call, subagent, and message-level status indicators.
- The message-glow-pulse animation (running indicator beneath assistant turns) uses `var(--message-glow-duration, 4s)` for a calmer, less frantic pulse.
- Height animations are avoided inside virtualized rows; only opacity, transform, and color transitions are used.
- Hover transitions stay under 150ms and only adjust surface, border, and lift.

### Width tokens
- `--message-assistant-width: 88%` — default stable width for assistant bubbles.
- `--message-assistant-width-narrow: 94%` — wider variant for narrow sidebar scenarios where 88% would clip content excessively.
- `--turn-activity-min-height: 22px` — reserved height for the activity strip so phase changes don't rearrange the transcript.
- `--status-chip-motion-duration: 2.1s` — consistent pulse/glow animation timing for all status chips.
- `--message-glow-duration: 4s` — slower, calmer glow-cycle for the running indicator line.
