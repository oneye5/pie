/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { ToolCall } from '../../../shared/protocol';
import { isEmptyToolCallInput } from '../../../shared/chat-message-parts';
import { normalizeToolCallName } from '../../../shared/tool-call-analysis';
import { cx } from '../utils/cx';
import { getToolCallPresentation } from '../tool-call-summary';
import { looksLikePathToken, splitQuotedToken, unwrapQuotedToken } from '../utils/looks-like-path-token';

import { useContext, useEffect, useRef, useState } from 'preact/hooks';

import { ClickablePathButton } from '../file-path';
import { CollapsibleChevron } from '../components/chevron';
import { ResizeHandle } from '../components/resize-handle';
import { ResizablePre } from '../components/resizable-pre';
import { useResizableHeight } from '../components/use-resizable-height';
import { formatDuration } from './header';
import {
  formatValueAsHighlightedYaml,
  highlightToolResultText,
  isTextOnlyToolResult,
  languageForToolInput,
  textFromToolResult,
} from './highlight';
import { StatusChip } from './status-chip';
import { TurnActiveContext } from './turn-active-context';
import { useCollapsibleOpen } from './use-collapsible-open';

interface ToolCallCardProps {
  toolCall: ToolCall;
  autoExpand: boolean;
  className?: string;
  workingDirectory: string | null;
  onOpenFile: (path: string) => void;
  onContextMenu: (e: MouseEvent) => void;
}

interface ToolCallHeaderProps {
  open: boolean;
  name: string;
  nameTitle?: string;
  status: ToolCall['status'];
  summary: string | null;
  summaryPath?: string;
  summaryModel?: ToolCallHeaderSummaryModel;
  sizeHint?: string;
  errorDetail?: string;
  durationMs?: number;
  onOpenFile: (path: string) => void;
}

interface ToolCallHeaderPathSummaryModel {
  kind: 'path';
  text: string;
  title?: string;
}

interface ToolCallHeaderTextSummaryModel {
  kind: 'text';
  text: string;
}

interface ToolCallHeaderCommandSummaryModel {
  kind: 'command';
  command: string;
  title: string;
  prefix?: string;
  detail?: string;
  pathLeadingQuote?: string;
  pathText?: string;
  pathTrailingQuote?: string;
  suffix?: string;
}

type ToolCallHeaderSummaryModel =
  | ToolCallHeaderPathSummaryModel
  | ToolCallHeaderTextSummaryModel
  | ToolCallHeaderCommandSummaryModel;

const SHELL_WRAPPER_TOKENS = new Set([
  'builtin',
  'command',
  'env',
  'exec',
  'nohup',
  'sudo',
  'time',
]);

export function formatToolCallResultForDisplay(toolCall: Pick<ToolCall, 'name' | 'result'>): string {
  if (toolCall.result === undefined) {
    return '';
  }

  const readableText = textFromToolResult(toolCall.result);
  return readableText ?? JSON.stringify(toolCall.result, null, 2);
}

import { isRecord } from '../../../shared/type-guards';


function normalizeInlineText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function tokenizeShellSnippet(value: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;

  for (const char of value) {
    if (quote) {
      current += char;
      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}

function isCommandSummaryTool(name: string): boolean {
  const normalizedName = normalizeToolCallName(name);
  return normalizedName === 'bash'
    || normalizedName === 'cmd'
    || normalizedName === 'powershell'
    || normalizedName === 'shell'
    || normalizedName === 'sh';
}

function isShellAssignmentToken(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(unwrapQuotedToken(value));
}


function createCommandSummaryModel(commandText: string): ToolCallHeaderCommandSummaryModel | null {
  const normalized = normalizeInlineText(commandText);
  if (!normalized) {
    return null;
  }

  const tokens = tokenizeShellSnippet(normalized);
  if (tokens.length === 0) {
    return null;
  }

  let commandIndex = 0;
  while (commandIndex < tokens.length - 1) {
    const token = unwrapQuotedToken(tokens[commandIndex] ?? '');
    if (SHELL_WRAPPER_TOKENS.has(token) || isShellAssignmentToken(token)) {
      commandIndex += 1;
      continue;
    }
    break;
  }

  const prefix = tokens.slice(0, commandIndex).join(' ');
  const command = tokens[commandIndex] ?? tokens[0];
  const remainder = tokens.slice(commandIndex + 1);
  const pathIndex = remainder.findIndex(looksLikePathToken);
  const detail = (pathIndex >= 0 ? remainder.slice(0, pathIndex) : remainder).join(' ');
  const pathToken = pathIndex >= 0 ? remainder[pathIndex] : undefined;
  const splitPath = pathToken ? splitQuotedToken(pathToken) : null;
  const suffix = pathIndex >= 0 ? remainder.slice(pathIndex + 1).join(' ') : undefined;

  return {
    kind: 'command',
    command,
    title: normalized,
    ...(prefix ? { prefix } : {}),
    ...(detail ? { detail } : {}),
    ...(splitPath?.leadingQuote ? { pathLeadingQuote: splitPath.leadingQuote } : {}),
    ...(splitPath?.text ? { pathText: splitPath.text } : {}),
    ...(splitPath?.trailingQuote ? { pathTrailingQuote: splitPath.trailingQuote } : {}),
    ...(suffix ? { suffix } : {}),
  };
}

function extractCommandText(toolCall: ToolCall | undefined): string | null {
  if (!toolCall || !isCommandSummaryTool(toolCall.name) || !isRecord(toolCall.input)) {
    return null;
  }

  return typeof toolCall.input.command === 'string'
    ? normalizeInlineText(toolCall.input.command) || null
    : null;
}

function buildToolCallHeaderSummaryModel(
  name: string,
  summary: string | null,
  summaryPath?: string,
  toolCall?: ToolCall,
): ToolCallHeaderSummaryModel | null {
  const commandText = extractCommandText(toolCall);
  const commandSummary = commandText && isCommandSummaryTool(toolCall?.name ?? name)
    ? createCommandSummaryModel(commandText)
    : (!commandText && summary && isCommandSummaryTool(name)
      ? createCommandSummaryModel(summary)
      : null);

  if (commandSummary) {
    return commandSummary;
  }

  if (summary && (summaryPath || looksLikePathToken(summary))) {
    return {
      kind: 'path',
      text: summary,
      ...(summaryPath ? { title: summaryPath } : {}),
    };
  }

  return summary
    ? { kind: 'text', text: summary }
    : null;
}

function CollapsedSummary({
  model,
  summaryPath,
  onOpenFile,
}: {
  model: ToolCallHeaderSummaryModel;
  summaryPath?: string;
  onOpenFile: (path: string) => void;
}) {
  if (model.kind === 'text') {
    return (
      <span class="transcript-header-summary-mono block min-w-0 max-w-full flex-1 truncate" title={model.text}>
        {model.text}
      </span>
    );
  }

  if (model.kind === 'path') {
    return (
      <span class="block min-w-0 max-w-full flex-1" title={summaryPath ?? model.title ?? model.text}>
        <ClickablePathButton path={summaryPath ?? model.title ?? model.text} displayText={model.text} onOpenFile={onOpenFile} />
      </span>
    );
  }

  return (
    <span class="transcript-header-command-preview" title={model.title}>
      {model.prefix && <span class="transcript-header-command-prefix transcript-header-summary-subtle">{model.prefix}</span>}
      <span class="transcript-header-command-verb transcript-header-summary-command">{model.command}</span>
      {(model.detail || model.pathText || model.suffix) && (
        <span class="transcript-header-command-details">
          {model.detail && <span class="transcript-header-command-tail transcript-header-summary-mono">{model.detail}</span>}
          {model.pathLeadingQuote && <span class="transcript-header-command-tail transcript-header-summary-subtle">{model.pathLeadingQuote}</span>}
          {model.pathText && <ClickablePathButton path={model.pathText} displayText={model.pathText} />}
          {model.pathTrailingQuote && <span class="transcript-header-command-tail transcript-header-summary-subtle">{model.pathTrailingQuote}</span>}
          {model.suffix && <span class="transcript-header-command-tail transcript-header-summary-subtle">{model.suffix}</span>}
        </span>
      )}
    </span>
  );
}

/** Compact status indicator shown at the right of the tool-call header: a
 *  spinner while running, nothing once completed. Failed keeps the
 *  interactive "Failed" status chip (with copy-error affordance) rendered by
 *  the header, so it is intentionally absent here. Follows an "alert on
 *  failure, not on success" philosophy — completion is the expected/default
 *  state and gets no glyph, mirroring the subagent StatusIndicator. */
function ToolCallStatusGlyph({ status }: { status: ToolCall['status'] }) {
  if (status === 'running') {
    return (
      <span
        class="tool-call-status-spinner"
        role="img"
        aria-label="Running"
      />
    );
  }
  return null;
}

export function ToolCallHeader({ open, name, nameTitle, status, summary, summaryPath, summaryModel, sizeHint, errorDetail, durationMs, onOpenFile }: ToolCallHeaderProps) {
  const statusTone =
    status === 'failed' ? 'failed'
    : null;
  const statusLabel =
    status === 'failed' ? 'Failed'
    : null;
  const collapsedSummaryModel = summaryModel ?? buildToolCallHeaderSummaryModel(name, summary, summaryPath);
  const showSummary = !open && !!collapsedSummaryModel;
  const showSizeHint = !open && !!sizeHint;
  const durationLabel =
    status !== 'running' && typeof durationMs === 'number' && durationMs >= 0
      ? formatDuration(durationMs)
      : null;

  return (
    <div class="flex items-center gap-[7px] rounded-md px-2 py-[5px]">
      <div class={cx('flex min-w-0 flex-1 items-center gap-2', (showSummary || showSizeHint) && 'gap-1.5')}>
        <span class="transcript-header-title-mono min-w-0 flex-[0_1_auto] truncate" title={nameTitle}>{name}</span>
        {showSummary && collapsedSummaryModel ? (
          <CollapsedSummary model={collapsedSummaryModel} summaryPath={summaryPath} onOpenFile={onOpenFile} />
        ) : null}
        {showSizeHint && <span class="ml-auto block min-w-0 max-w-[var(--tool-call-size-column-width)] flex-[0_0_var(--tool-call-size-column-width)] truncate text-right font-mono text-[10px] text-muted/50">{sizeHint}</span>}
      </div>
      {durationLabel && <span class="ml-auto flex-none whitespace-nowrap font-mono text-[10px] text-muted/60 [font-variant-numeric:tabular-nums]" title="Tool execution time">{durationLabel}</span>}
      {status !== 'failed' && <ToolCallStatusGlyph status={status} />}
      {statusTone && statusLabel && (
        <StatusChip
          tone={statusTone}
          label={statusLabel}
          className="status-chip-fixed"
          copyText={errorDetail}
          copyAriaLabel={errorDetail ? 'Copy tool-call error detail' : undefined}
        />
      )}
      <CollapsibleChevron open={open} class="ml-0.5 shrink-0" />
    </div>
  );
}

function TerminalOutput({ text, running }: { text: string; running: boolean }) {
  const { scrollRef, height, startResize } = useResizableHeight<HTMLPreElement>();
  const stickToBottomRef = useRef(true);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 48;
  };

  // Keep the pane pinned to the latest output as it streams in, unless the
  // user has scrolled up to read earlier output.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [text]);

  return (
    <div class="resizable-scroll-area">
      <ResizeHandle edge="top" onMouseDown={startResize('top')} />
      <pre
        ref={scrollRef}
        class="tool-call-terminal-pre"
        onScroll={handleScroll}
        style={height ? { height: `${height}px`, maxHeight: 'none' } : undefined}
      >
        <code>{text}</code>
        {running && <span class="tool-call-terminal-cursor" aria-hidden="true" />}
      </pre>
      <ResizeHandle edge="bottom" onMouseDown={startResize('bottom')} />
    </div>
  );
}

interface ToolCallBodyProps {
  toolCall: ToolCall;
}

function ToolCallBody({ toolCall }: ToolCallBodyProps) {
  const isShell = isCommandSummaryTool(toolCall.name);
  const isRunning = toolCall.status === 'running';

  if (isShell) {
    const text = textFromToolResult(toolCall.result) ?? '';
    const details = (toolCall.result as
      | {
          details?: {
            truncation?: { truncated?: boolean; totalLines?: number; outputLines?: number };
            fullOutputPath?: string;
          };
        }
      | null
      | undefined)?.details;
    const truncation = details?.truncation;
    const command =
      toolCall.input && typeof toolCall.input === 'object' && typeof (toolCall.input as { command?: unknown }).command === 'string'
        ? (toolCall.input as { command: string }).command
        : undefined;

    return (
      <div class="tool-call-body tool-call-body-terminal" onClick={(e) => e.stopPropagation()}>
        {command && (
          <div class="tool-call-terminal-command hljs-scope" title={command}>
            <span class="tool-call-terminal-prompt" aria-hidden="true">$</span>
            <code class="hljs language-bash" dangerouslySetInnerHTML={{ __html: highlightToolResultText(command, 'bash') }} />
          </div>
        )}
        <div class="tool-call-terminal" data-running={isRunning ? 'true' : undefined}>
          {text ? (
            <TerminalOutput text={text} running={isRunning} />
          ) : (
            <div class="tool-call-terminal-empty">{isRunning ? 'Executing…' : '(no output)'}</div>
          )}
        </div>
        {truncation?.truncated && (
          <div class="tool-call-truncated" title={details?.fullOutputPath}>
            Output truncated — showing {truncation.outputLines ?? '?'} of {truncation.totalLines ?? '?'} lines.{details?.fullOutputPath ? ` Full log: ${details.fullOutputPath}` : ''}
          </div>
        )}
      </div>
    );
  }

  const resultText = textFromToolResult(toolCall.result);
  const resultIsTextOnly = isTextOnlyToolResult(toolCall.result);
  // Infer a highlight language for file-content tools (read/grep/glob/find/cat)
  // from the tool's input path. edit/write results are short confirmations,
  // so they fall through to plain/JSON-detect highlighting.
  const normalizedName = normalizeToolCallName(toolCall.name);
  const isFileContentTool =
    normalizedName === 'read'
    || normalizedName === 'cat'
    || normalizedName === 'grep'
    || normalizedName === 'glob'
    || normalizedName === 'find';
  const resultLanguageHint = isFileContentTool
    ? languageForToolInput(toolCall.name, toolCall.input)
    : undefined;

  return (
    <div class="tool-call-body" onClick={(e) => e.stopPropagation()}>
      <div class="tool-call-section">
        <div class="tool-call-section-label">Input</div>
        {isEmptyToolCallInput(toolCall.input) ? (
          <div class="tool-call-empty">(no input)</div>
        ) : (
          <pre class="tool-call-pre hljs-scope">
            <code class="hljs language-yaml" dangerouslySetInnerHTML={{ __html: formatValueAsHighlightedYaml(toolCall.input) }} />
          </pre>
        )}
      </div>
      {toolCall.result !== undefined && (
        <div class="tool-call-section">
          <div class="tool-call-section-label">Result</div>
          {resultIsTextOnly && resultText !== undefined ? (
            <ResizablePre class="tool-call-pre tool-call-pre-resizable hljs-scope" minHeight={80}>
              <code class="hljs" dangerouslySetInnerHTML={{ __html: highlightToolResultText(resultText, resultLanguageHint) }} />
            </ResizablePre>
          ) : (
            <ResizablePre class="tool-call-pre tool-call-pre-resizable hljs-scope" minHeight={80}>
              <code class="hljs language-yaml" dangerouslySetInnerHTML={{ __html: formatValueAsHighlightedYaml(toolCall.result) }} />
            </ResizablePre>
          )}
        </div>
      )}
    </div>
  );
}

/** Grace period (ms) a shell tool's auto-shown body stays expanded after the
 *  command finishes, so the user can read/skim the output even for instant
 *  commands. Only applies to the auto-opened shell path — manual opens are
 *  sticky and never auto-close. */
const TOOL_CALL_CLOSE_GRACE_MS = 1000;
/** Duration (ms) of the post-grace collapse animation. Must match the
 *  transition on `.tool-call-body-wrap` in styles/tool-call.css. */
const TOOL_CALL_CLOSE_TRANSITION_MS = 180;
/** How long (ms) the completion pulse highlight remains on the card. */
const TOOL_CALL_COMPLETION_PULSE_MS = 700;

export function ToolCallCard({
  toolCall,
  autoExpand,
  className,
  workingDirectory,
  onOpenFile,
  onContextMenu,
}: ToolCallCardProps) {
  const [open, setOpen] = useCollapsibleOpen(`tool:${toolCall.id}`, autoExpand);
  const presentation = getToolCallPresentation(toolCall, { workingDirectory });
  const isShell = isCommandSummaryTool(toolCall.name);
  const isRunning = toolCall.status === 'running';

  // ── Post-completion grace + animated close (shell auto-show path only) ──
  // Shell tools auto-show their body while running. When a quick command
  // finishes in a split second the body used to snap-unmount in one frame
  // (a flash/flicker). Instead, after running→completed/failed we keep the
  // body expanded for a grace period so the user can read the output, then
  // animate it closed. This only applies to the AUTO-shown path — manual
  // opens are sticky and never auto-close.
  const [lingering, setLingering] = useState(false);
  const [closing, setClosing] = useState(false);
  // Brief highlight pulse on the card when a tool call completes (all tools).
  const [justCompleted, setJustCompleted] = useState(false);
  // One-shot expand animation (symmetric with the post-grace close). Applied
  // to the wrapper on the first render the AUTO-shown body appears.
  const [expand, setExpand] = useState(false);

  const prevRunningRef = useRef(false);
  const graceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeFallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pulseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const expandTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Wall-clock completion time used to compute the remaining grace when the
  // close is deferred until the turn goes idle (see effect below).
  const completedAtRef = useRef<number | null>(null);
  // `busy` from the owning transcript: while the turn is still active the
  // auto-close is deferred. `undefined` (no provider, e.g. nested subagent
  // transcripts) keeps the legacy completion-relative grace.
  const turnActive = useContext(TurnActiveContext);

  const renderBodyRef = useRef(false);

  // Refs mirror the latest open/lingering/closing so the status-transition
  // effect (keyed on toolCall.status) always reads current values without
  // re-subscribing on every toggle.
  const openRef = useRef(open);
  openRef.current = open;
  const lingeringRef = useRef(lingering);
  lingeringRef.current = lingering;
  const closingRef = useRef(closing);
  closingRef.current = closing;

  // Shell tools stream their output live — show the terminal pane while
  // running even when collapsed, so users can watch execution unfold. The
  // `lingering` term keeps it expanded during the post-completion grace.
  const showBody = open || (isShell && isRunning) || lingering;

  // Detect running→completed/failed to (a) flash a completion pulse for all
  // tool calls, and (b) enter the lingering state for the auto-shown shell
  // body. The actual close is scheduled/deferred below based on turn activity.
  useEffect(() => {
    const wasRunning = prevRunningRef.current;
    const nowRunning = toolCall.status === 'running';
    prevRunningRef.current = nowRunning;

    const justCompleted = wasRunning && !nowRunning;

    if (justCompleted) {
      // Completion pulse applies to every tool call (not just shell).
      if (toolCall.status === 'completed') {
        setJustCompleted(true);
        if (pulseTimerRef.current) clearTimeout(pulseTimerRef.current);
        pulseTimerRef.current = setTimeout(() => {
          pulseTimerRef.current = null;
          setJustCompleted(false);
        }, TOOL_CALL_COMPLETION_PULSE_MS);
      }

      // Grace period only for the AUTO-shown shell body — never when the
      // user explicitly opened it (manual opens are sticky). Record the
      // completion time; the close itself is scheduled below.
      if (isShell && !openRef.current && !lingeringRef.current && !closingRef.current) {
        setLingering(true);
        completedAtRef.current = Date.now();
      }
    }

    // If the call returns to running, cancel any pending close so the
    // streaming body re-shows cleanly.
    if (!wasRunning && nowRunning) {
      setLingering(false);
      setClosing(false);
      completedAtRef.current = null;
      if (graceTimerRef.current) { clearTimeout(graceTimerRef.current); graceTimerRef.current = null; }
      if (closeFallbackTimerRef.current) { clearTimeout(closeFallbackTimerRef.current); closeFallbackTimerRef.current = null; }
      return;
    }

    // Schedule (or defer) the post-completion auto-close. The grace is
    // measured from completion so earlier tools close first, but the close
    // is HELD while the owning turn is still active (turnActive === true) to
    // avoid collapse→re-expand churn when the agent runs consecutive
    // commands. turnActive === undefined (no provider, e.g. nested subagent
    // transcripts) keeps the legacy completion-relative behaviour.
    const isLingering = justCompleted ? true : lingeringRef.current;
    const completedAt = completedAtRef.current;
    if (isLingering && !closingRef.current && !openRef.current && completedAt !== null) {
      const canClose = turnActive === undefined ? true : !turnActive;
      if (canClose) {
        const elapsed = Date.now() - completedAt;
        const remaining = Math.max(0, TOOL_CALL_CLOSE_GRACE_MS - elapsed);
        if (graceTimerRef.current) clearTimeout(graceTimerRef.current);
        graceTimerRef.current = setTimeout(() => {
          graceTimerRef.current = null;
          setLingering(false);
          setClosing(true);
          // Fallback in case transitionend doesn't fire (e.g. the tab was
          // backgrounded). The body must unmount eventually.
          if (closeFallbackTimerRef.current) clearTimeout(closeFallbackTimerRef.current);
          closeFallbackTimerRef.current = setTimeout(() => {
            closeFallbackTimerRef.current = null;
            setClosing(false);
          }, TOOL_CALL_CLOSE_TRANSITION_MS + 60);
        }, remaining);
      } else {
        // Turn still active: cancel any pending close so the body stays open
        // while the agent keeps producing.
        if (graceTimerRef.current) { clearTimeout(graceTimerRef.current); graceTimerRef.current = null; }
      }
    }
  }, [toolCall.status, isShell, turnActive]);

  // Cancel any pending auto-close when the user manually opens the body, so
  // an explicit expand is sticky.
  const cancelAutoClose = () => {
    if (graceTimerRef.current) { clearTimeout(graceTimerRef.current); graceTimerRef.current = null; }
    if (closeFallbackTimerRef.current) { clearTimeout(closeFallbackTimerRef.current); closeFallbackTimerRef.current = null; }
    setLingering(false);
    setClosing(false);
  };

  // Clear all timers on unmount.
  useEffect(() => () => {
    if (graceTimerRef.current) clearTimeout(graceTimerRef.current);
    if (closeFallbackTimerRef.current) clearTimeout(closeFallbackTimerRef.current);
    if (pulseTimerRef.current) clearTimeout(pulseTimerRef.current);
    if (expandTimerRef.current) clearTimeout(expandTimerRef.current);
  }, []);

  const errorDetail = toolCall.status === 'failed'
    ? (textFromToolResult(toolCall.result) ?? formatToolCallResultForDisplay(toolCall)) || undefined
    : undefined;
  const summaryModel = buildToolCallHeaderSummaryModel(
    toolCall.name,
    presentation.summary,
    presentation.summaryPath,
    toolCall,
  );

  const toggleOpen = () => {
    const opening = !openRef.current;
    setOpen((v) => !v);
    if (opening) cancelAutoClose();
  };

  const renderBody = showBody || closing;

  // One-shot expand animation for the AUTO-shown body (symmetric with the
  // post-grace close). When the body first appears while the card is
  // collapsed (!open — i.e. the auto-show path, not a manual open), apply the
  // `data-expand` flag so the wrapper's @keyframes grow-in runs. Cleared on
  // animationend (or a fallback timer if the event is missed).
  useEffect(() => {
    const wasRendered = renderBodyRef.current;
    renderBodyRef.current = renderBody;
    if (renderBody && !wasRendered && !openRef.current) {
      setExpand(true);
      if (expandTimerRef.current) clearTimeout(expandTimerRef.current);
      expandTimerRef.current = setTimeout(() => {
        expandTimerRef.current = null;
        setExpand(false);
      }, TOOL_CALL_CLOSE_TRANSITION_MS + 60);
    }
  }, [renderBody]);

  return (
    <div
      class={cx(
        'cursor-pointer select-none overflow-hidden rounded-xl border-l-2 border-l-transparent bg-card shadow-sm transition-all duration-150 hover:bg-control-hover hover:shadow-md',
        'forced-colors:border forced-colors:border-[ButtonText]',
        toolCall.status === 'failed' && 'border-l-danger/50',
        toolCall.status === 'completed' && 'border-l-success/60',
        justCompleted && 'tool-call-just-completed',
        presentation.variant === 'skill-load' && 'bg-accent/5 skill-load-glow',
        className,
      )}
      role="button"
      aria-expanded={open}
      aria-label="Toggle tool call details"
      tabIndex={0}
      onClick={toggleOpen}
      onContextMenu={(e) => { e.preventDefault(); onContextMenu(e as unknown as MouseEvent); }}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleOpen(); } }}
    >
      <ToolCallHeader
        open={open}
        name={presentation.name}
        status={toolCall.status}
        summary={presentation.summary}
        summaryPath={presentation.summaryPath}
        summaryModel={summaryModel ?? undefined}
        sizeHint={presentation.sizeHint}
        errorDetail={errorDetail}
        durationMs={toolCall.durationMs}
        onOpenFile={onOpenFile}
      />
      {renderBody && (
        <div
          class="tool-call-body-wrap"
          data-streaming={isRunning ? 'true' : undefined}
          data-expand={expand ? 'true' : undefined}
          data-closing={!showBody && closing ? 'true' : undefined}
          onTransitionEnd={(e) => {
            // Only react to transitions on the wrapper itself, not children.
            if (e.target !== e.currentTarget) return;
            if (closing && !showBody) {
              if (closeFallbackTimerRef.current) { clearTimeout(closeFallbackTimerRef.current); closeFallbackTimerRef.current = null; }
              setClosing(false);
            }
          }}
          onAnimationEnd={(e) => {
            // Only clear on the wrapper's own expand animation (ignore child
            // animations like the streaming cursor blink).
            if (e.animationName !== 'tool-call-body-expand') return;
            if (expandTimerRef.current) { clearTimeout(expandTimerRef.current); expandTimerRef.current = null; }
            setExpand(false);
          }}
        >
          <div class="tool-call-body-inner">
            <ToolCallBody toolCall={toolCall} />
          </div>
        </div>
      )}
    </div>
  );
}
