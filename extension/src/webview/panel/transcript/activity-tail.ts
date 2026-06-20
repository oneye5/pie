/**
 * Compact "last few rows" live-activity tail derivation.
 *
 * Extends {@link TurnActivityState} with a bounded, terminal-style preview of
 * what the agent is producing right now: the tail of streaming reasoning/reply
 * text, the input + streaming output of the running tool, or the live activity
 * inside a running subagent.
 *
 * All source data already lives in the projected transcript snapshot — the
 * streaming assistant message's `parts` (text/reasoning), the running
 * tool call's `result` (the `partialResult` pushed by `tool.progress`, which
 * `bash` populates as stdout streams), and the subagent tool call's `result`
 * (the live `SubagentResult` with `streamingText`/`runningTools`). No host or
 * protocol changes are required; this is a pure webview-side projection that
 * re-derives on every posted snapshot (~6×/sec via the 150ms streaming debounce).
 */

import type { ChatMessagePart, ToolCall } from '../../../shared/protocol';
import { normalizeToolCallName } from '../../../shared/tool-call-analysis';
import { getToolCallPresentation } from '../tool-call-summary';
import { textFromToolResult } from './highlight';
import {
  getRenderableSubagentResultFromToolCall,
  type SubagentSingleResult,
} from './subagent';

/** Maximum number of tail content lines rendered in the compact activity block. */
export const ACTIVITY_TAIL_MAX_LINES = 2;
/** Maximum characters of streaming text/reasoning considered for the tail. */
export const ACTIVITY_TAIL_MAX_CHARS = 140;
/** Soft cap for a single rendered line before CSS ellipsis takes over. */
export const ACTIVITY_TAIL_LINE_MAX_CHARS = 90;
/** Estimated rendered height of a single tail row, in px (matches CSS line-height). */
export const ACTIVITY_TAIL_ROW_HEIGHT_PX = 13;

export interface TurnActivityTail {
  /** Semantic kind; drives styling (e.g. reasoning renders muted/italic). */
  kind: 'reasoning' | 'text' | 'tool' | 'subagent';
  /** Optional one-line input shown under the header (e.g. a bash command, subagent task). */
  inputLine?: string;
  /** Tail content lines, already clipped to {@link ACTIVITY_TAIL_MAX_LINES}. Newest at the bottom. */
  lines: string[];
  /** True when more content exists above the shown lines (renders the `…` separator). */
  truncated: boolean;
  /** Show a blinking cursor indicating live streaming/execution. */
  cursor: boolean;
}

/** A derived tail plus the header label that should replace the strip's default label. */
export interface DerivedActivityTail {
  tail: TurnActivityTail;
  label: string;
}

function takeLastChars(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(text.length - max);
}

function clampLines(lines: string[], max: number): { lines: string[]; truncated: boolean } {
  if (lines.length <= max) return { lines, truncated: false };
  return { lines: lines.slice(lines.length - max), truncated: true };
}

function clampToLine(text: string, max = ACTIVITY_TAIL_LINE_MAX_CHARS): string {
  const single = text.replace(/\s+/g, ' ').trim();
  if (single.length <= max) return single;
  return `${single.slice(0, max - 1).trimEnd()}…`;
}

/** Split accumulated output text into display lines, dropping trailing blank noise. */
function outputLines(text: string): string[] {
  if (text.length === 0) return [];
  return text.replace(/\n+$/, '').split('\n');
}

/**
 * True when the tool result carries the SDK's own truncation metadata
 * (e.g. bash `details.truncation.truncated` when output exceeded the
 * OutputAccumulator's line/byte cap). Used so the `…` separator reflects hidden
 * output even when our own line cap hasn't kicked in.
 */
function isSdkResultTruncated(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false;
  const details = (result as { details?: unknown }).details;
  if (!details || typeof details !== 'object') return false;
  const truncation = (details as { truncation?: { truncated?: unknown } }).truncation;
  return Boolean(truncation?.truncated);
}

/**
 * Derive a live tail for the currently-streaming assistant message.
 * Selects the most recently grown text/reasoning segment so the tail mirrors
 * what the model is emitting *right now* (reasoning while thinking tokens
 * stream, reply text while answer tokens stream).
 */
export function deriveStreamingTail(
  parts: ChatMessagePart[] | undefined,
): DerivedActivityTail | null {
  if (!parts || parts.length === 0) return null;

  // Find the most recently appended text/reasoning segment — that is the one
  // actively growing, so its tail is the freshest signal.
  let target: Extract<ChatMessagePart, { kind: 'text' | 'reasoning' }> | undefined;
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const part = parts[i];
    if (part?.kind === 'text' || part?.kind === 'reasoning') {
      target = part;
      break;
    }
  }
  if (!target) return null;

  const isReasoning = target.kind === 'reasoning';
  const full = target.text;
  const tailText = takeLastChars(full, ACTIVITY_TAIL_MAX_CHARS);
  const split = tailText.split('\n');
  const { lines, truncated } = clampLines(split, ACTIVITY_TAIL_MAX_LINES);

  // Drop a trailing empty line (common when deltas end mid-newline) so the
  // cursor sits flush against real content.
  const cleaned = lines.length > 0 && lines[lines.length - 1]!.trim() === ''
    ? lines.slice(0, -1)
    : lines;
  if (cleaned.length === 0) return null;

  const kind = isReasoning ? 'reasoning' : 'text';
  return {
    label: isReasoning ? 'reasoning' : 'responding',
    tail: {
      kind,
      lines: cleaned,
      truncated: truncated || full.length > tailText.length,
      cursor: true,
    },
  };
}

/**
 * Derive a live tail for a single running (non-subagent) tool call: the tool's
 * one-line input plus the tail of its streaming `partialResult` output.
 */
export function deriveToolTail(toolCall: ToolCall): DerivedActivityTail | null {
  const presentation = getToolCallPresentation(toolCall);
  const inputLine = presentation.summary?.trim() || undefined;

  const resultText = textFromToolResult(toolCall.result) ?? '';
  const allLines = outputLines(resultText);
  const { lines, truncated } = clampLines(allLines, ACTIVITY_TAIL_MAX_LINES);
  const sdkTruncated = isSdkResultTruncated(toolCall.result);

  const hasBody = Boolean(inputLine) || lines.length > 0;
  if (!hasBody) return null;

  return {
    label: toolCall.name,
    tail: {
      kind: 'tool',
      inputLine,
      lines,
      truncated: truncated || sdkTruncated,
      cursor: true,
    },
  };
}

function subagentSingleResultRunning(result: SubagentSingleResult): boolean {
  return result.exitCode === -1 || (result.runningTools?.length ?? 0) > 0;
}

/** One compact activity line describing what a running subagent is doing right now. */
function subagentActivityLine(result: SubagentSingleResult, prefixAgent: boolean): string | null {
  const tools = result.runningTools?.filter(Boolean);
  if (tools && tools.length > 0) {
    const toolList = tools.join(' · ');
    return prefixAgent ? `${result.agent}: → ${toolList}` : `→ ${toolList}`;
  }

  const stream = result.streamingText?.trim();
  if (stream) {
    const parts = stream.split('\n').map((s) => s.trim()).filter(Boolean);
    const last = parts[parts.length - 1];
    if (last) {
      return clampToLine(prefixAgent ? `${result.agent}: ${last}` : last);
    }
  }

  return prefixAgent ? `${result.agent}: …` : '…';
}

/**
 * Derive a live tail for a running `subagent` tool call by peeking into its
 * live {@link SubagentResult}: the task plus the most recent activity of each
 * still-running sub-result (running tools, or the tail of streaming text).
 */
export function deriveSubagentTail(toolCall: ToolCall): DerivedActivityTail | null {
  const sub = getRenderableSubagentResultFromToolCall(toolCall);
  if (!sub) return null;

  const running = sub.results.filter(subagentSingleResultRunning);
  if (running.length === 0) return null;

  const primary = running[0]!;
  const taskText = primary.task?.trim();
  const inputLine = taskText ? clampToLine(taskText) : undefined;

  const prefixAgent = running.length > 1;
  const all: string[] = [];
  for (const result of running) {
    const line = subagentActivityLine(result, prefixAgent);
    if (line) all.push(line);
    if (all.length >= ACTIVITY_TAIL_MAX_LINES) break;
  }

  const { lines, truncated } = clampLines(all, ACTIVITY_TAIL_MAX_LINES);

  const label = primary.agent?.trim() || 'subagent';
  return {
    label,
    tail: {
      kind: 'subagent',
      inputLine,
      lines,
      truncated,
      cursor: true,
    },
  };
}

/**
 * Route a single running tool call to the right tail derivation (subagent vs
 * generic tool). Returns null when no meaningful tail can be derived.
 */
export function deriveRunningToolTail(toolCall: ToolCall): DerivedActivityTail | null {
  if (normalizeToolCallName(toolCall.name) === 'subagent') {
    return deriveSubagentTail(toolCall);
  }
  return deriveToolTail(toolCall);
}

/**
 * Build a per-tool summary tail for the multi-tool case (e.g. parallel
 * tool calls). Each running tool renders as a compact `→ <name>` line.
 */
export function deriveMultiToolTail(toolCalls: readonly ToolCall[]): DerivedActivityTail {
  const all = toolCalls.map((tc) => `→ ${tc.name}`);
  const { lines, truncated } = clampLines(all, ACTIVITY_TAIL_MAX_LINES);
  return {
    label: `running ${toolCalls.length} tools`,
    tail: { kind: 'tool', lines, truncated, cursor: true },
  };
}

/**
 * Rough rendered height of a tail, used by the virtualizer's size estimate so
 * initial layout is close before ResizeObserver re-measures the real height.
 * The compact layout keeps the input line + up to two content lines + a
 * blinking cursor; the truncation separator is a CSS fade, not a row.
 */
export function estimateActivityTailHeight(tail: TurnActivityTail | null | undefined): number {
  if (!tail) return 0;
  const rows =
    tail.lines.length +
    (tail.inputLine ? 1 : 0) +
    (tail.cursor ? 1 : 0);
  return rows * ACTIVITY_TAIL_ROW_HEIGHT_PX + 4;
}
