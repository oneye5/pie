import type { ChatMessage, ToolCall } from './protocol';
import { isRecord } from './type-guards';
import { estimateTextTokens } from './tokenize';
import {
  getRenderableSubagentResultFromToolCall,
  type SubagentSingleResult,
} from './subagent-result';
import {
  computeTurnLatencyStats,
  formatAvgTimeToFirstToken,
  formatTurnLatencyTooltipLines,
  type TurnLatencyStats,
} from './turn-latency';

/**
 * Live "average tokens per second" measurement.
 *
 * Originally webview-local; now shared so the **host** measures every running
 * session (including ones that are not the active/selected tab) using the
 * transcripts it already holds (`transcript.bySession`). The webview simply
 * displays the pre-computed rate for its active session. This fixes the old
 * behaviour where switching off a session froze its accumulator and switching
 * back restarted the average from the selection point.
 *
 * The generation clock advances while the model (or any running subagent) is
 * actively producing output. A rolling window of (generation-time,
 * cumulative-output-tokens) samples over the last {@link WINDOW_MS} of
 * *generation* time (not wall-clock) yields the displayed rate. Because the
 * time axis is generation-time, every paused span — including time spent in
 * tool calls and between turns — is excluded from both the numerator's token
 * production and the denominator's elapsed time automatically.
 *
 * Subagent output is included in the aggregate: the indicator reflects the
 * sum of live output tokens across the main session and every running
 * subagent, so four parallel subagents each averaging 60 tok/s read as
 * ~240 tok/s.
 *
 * Pure with respect to the accumulator (mutates `acc` in place) and takes
 * `now` as a parameter, so it is straightforward to unit-test and safe to run
 * in the extension host.
 */

/** Measurement tick interval (ms). Imported by the host `TokenRateService`. */
export const TICK_MS = 200;
/** Rolling window length, measured in generation-time (excludes pauses). */
export const WINDOW_MS = 60_000;
/**
 * No-growth grace before the clock pauses. Catches stalls the explicit tool/
 * turn signals miss (network stalls, anything else that pauses the underlying
 * LLM) without falsely pausing on slow-but-active generation.
 */
const STALL_GRACE_MS = 1_000;
/** Minimum generation-time span before a rate is shown (avoids a noisy first reading). */
const MIN_RATE_SPAN_MS = 300;
/** Cap on retained samples to bound memory (~72s at 200ms ticks). */
const MAX_SAMPLES = 360;

export interface TokenRateIndicatorState {
  /** Compact label e.g. "42 tok/s · 1.3s" (rate · avg time to first token); "—" when idle or measuring. */
  label: string;
  ariaLabel: string;
  tooltip: string;
  /** 'idle' (no session selected) | 'generating' | 'paused'. */
  state: 'idle' | 'generating' | 'paused';
  /** True while the generation clock is frozen (tool running / between turns / stall). */
  paused: boolean;
}

export const IDLE_STATE: TokenRateIndicatorState = {
  label: '—',
  ariaLabel: 'Generation rate: idle.',
  tooltip: 'No active generation.',
  state: 'idle',
  paused: false,
};

interface Sample {
  /** Generation-clock value (ms) at the sample. */
  genMs: number;
  /** Cumulative estimated output tokens produced since the run began. */
  tokens: number;
}

export interface Accumulator {
  /** Generation clock — advances only while generating. */
  genMs: number;
  /** Cumulative estimated output tokens (continuous across turns within a run). */
  cumTokens: number;
  samples: Sample[];
  /** Wall-time of the last tick, for computing per-tick elapsed. */
  lastWall: number;
  /** Wall-time when the main assistant's output last grew, for stall/grace detection. */
  lastMainGrowthWall: number;
  /** Wall-time when a running subagent's output last grew, for stall/grace detection. */
  lastSubagentGrowthWall: number;
  /**
   * Last estimated output tokens per streaming assistant message id. Per-id (not a
   * single value) so a continuation — the same canonical message id re-streaming
   * after a tool call — only counts its NEW output, not the whole accumulated
   * message again. Mirrors the `subagentTokens` map (which is keyed per-result,
   * `${toolCallId}#${resultIndex}`, so parallel results don't collide). A single
   * value would reset to 0 while the message is briefly not streaming and
   * re-count the entire message on every continuation, exploding `cumTokens`
   * across a tool-heavy turn.
   */
  lastContentTokensById: Map<string, number>;
  /** Last estimated output tokens per running subagent result.
   *
   * Keyed by `${toolCallId}#${resultIndex}` rather than toolCallId alone: a
   * *parallel* subagent call is one tool call whose `results` array holds one
   * entry per task, all sharing the same toolCallId. Keying by toolCallId alone
   * made every parallel result clobber the same entry each tick, so the delta
   * was computed as the difference between different subagents' cumulative
   * counts — inflating the rate whenever the results had disparate output. The
   * result index is stable because the subagent extension seeds a fixed-size
   * results array and updates entries in place by task index. */
  subagentTokens: Map<string, number>;
}

export function createAccumulator(now: number): Accumulator {
  return {
    genMs: 0,
    cumTokens: 0,
    samples: [],
    lastWall: now,
    // 0 = "never grew": the clock stays paused until the first output token
    // arrives, so time-to-first-token is excluded from generation time.
    lastMainGrowthWall: 0,
    lastSubagentGrowthWall: 0,
    lastContentTokensById: new Map(),
    subagentTokens: new Map(),
  };
}

/** Bound on retained per-id content-token snapshots (defensive; a run rarely has more than a few dozen distinct streaming message ids). */
const MAX_CONTENT_TOKEN_ENTRIES = 64;

function pruneContentTokenMap(acc: Accumulator, keepId: string): void {
  if (acc.lastContentTokensById.size <= MAX_CONTENT_TOKEN_ENTRIES) {
    return;
  }
  // Keep only the live streaming id; finished turns' ids never re-stream.
  for (const id of acc.lastContentTokensById.keys()) {
    if (id !== keepId) {
      acc.lastContentTokensById.delete(id);
    }
  }
}

function findStreamingMessage(transcript: ChatMessage[]): ChatMessage | null {
  for (let i = transcript.length - 1; i >= 0; i -= 1) {
    const message = transcript[i];
    if (message.role === 'assistant' && message.status === 'streaming') {
      return message;
    }
  }
  return null;
}

function hasRunningToolCall(message: ChatMessage | null): boolean {
  if (!message?.toolCalls?.length) return false;
  return message.toolCalls.some((tc) => tc.status === 'running');
}

/** Estimated output tokens for a message: text + reasoning, via the cl100k_base tokenizer. */
function estimatedOutputTokens(message: ChatMessage | null): number {
  if (!message) return 0;
  return estimateTextTokens(message.markdown ?? '') + estimateTextTokens(message.thinking ?? '');
}

function isSubagentRunning(result: SubagentSingleResult): boolean {
  return result.exitCode === -1 || (result.runningTools?.length ?? 0) > 0;
}

function estimatedSubagentOutputTokens(result: SubagentSingleResult): number {
  let tokens = 0;
  if (Array.isArray(result.messages)) {
    for (const msg of result.messages) {
      if (msg.role !== 'assistant') continue;
      if (typeof msg.content === 'string') {
        tokens += estimateTextTokens(msg.content);
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (isRecord(part)) {
            if (part.type === 'text' && typeof part.text === 'string') {
              tokens += estimateTextTokens(part.text);
            } else if (part.type === 'thinking' && typeof part.thinking === 'string') {
              tokens += estimateTextTokens(part.thinking);
            }
          }
        }
      }
    }
  }
  if (typeof result.streamingText === 'string') {
    tokens += estimateTextTokens(result.streamingText);
  }
  return tokens;
}

interface RunningSubagent {
  toolCallId: string;
  /** Position within the parent call's `results` array — disambiguates the
   * multiple results of a parallel/chain subagent call (shared toolCallId). */
  resultIndex: number;
  result: SubagentSingleResult;
}

function findRunningSubagents(transcript: ChatMessage[]): RunningSubagent[] {
  const running: RunningSubagent[] = [];
  for (const message of transcript) {
    for (const toolCall of message.toolCalls ?? []) {
      if (toolCall.name !== 'subagent') continue;
      const subagentResult = getRenderableSubagentResultFromToolCall(toolCall as ToolCall);
      if (!subagentResult) continue;
      subagentResult.results.forEach((single, index) => {
        if (isSubagentRunning(single)) {
          running.push({ toolCallId: toolCall.id, resultIndex: index, result: single });
        }
      });
    }
  }
  return running;
}

function computeSubagentDelta(
  acc: Accumulator,
  running: RunningSubagent[],
): number {
  let delta = 0;
  const seenIds = new Set<string>();

  for (const { toolCallId, resultIndex, result } of running) {
    // Composite key: a parallel call shares one toolCallId across all its
    // results, so the index is required to track each result's own growth.
    const key = `${toolCallId}#${resultIndex}`;
    seenIds.add(key);
    const current = estimatedSubagentOutputTokens(result);
    const previous = acc.subagentTokens.get(key) ?? 0;
    delta += Math.max(0, current - previous);
    acc.subagentTokens.set(key, current);
  }

  // Drop snapshots for subagent results that are no longer running so the map
  // stays bounded over long sessions and a completed result doesn't anchor the
  // snapshot if the same key were ever reused.
  for (const id of acc.subagentTokens.keys()) {
    if (!seenIds.has(id)) {
      acc.subagentTokens.delete(id);
    }
  }

  return delta;
}

function formatRate(rate: number): string {
  if (!Number.isFinite(rate) || rate <= 0) return '0';
  if (rate >= 10) return String(Math.round(rate));
  return rate.toFixed(1);
}

function computeRate(samples: Sample[]): number | null {
  if (samples.length < 2) return null;
  const oldest = samples[0];
  const newest = samples[samples.length - 1];
  const spanMs = newest.genMs - oldest.genMs;
  if (spanMs < MIN_RATE_SPAN_MS) return null;
  const spanTokens = newest.tokens - oldest.tokens;
  return spanTokens / (spanMs / 1000);
}

function trimWindow(acc: Accumulator): void {
  const cutoff = acc.genMs - WINDOW_MS;
  while (acc.samples.length > 1 && acc.samples[0].genMs < cutoff) {
    acc.samples.shift();
  }
  if (acc.samples.length > MAX_SAMPLES) {
    acc.samples.splice(0, acc.samples.length - MAX_SAMPLES);
  }
}

function describePauseReason(message: ChatMessage | null, toolBlocked: boolean): string {
  if (toolBlocked) return 'tool running';
  if (!message) return 'between turns';
  return 'waiting for output';
}

function buildState(
  acc: Accumulator,
  generating: boolean,
  streaming: ChatMessage | null,
  toolBlocked: boolean,
  stats: TurnLatencyStats,
): TokenRateIndicatorState {
  const rate = computeRate(acc.samples);
  const genSec = Math.round(acc.genMs / 1000);
  const windowSpanMs = acc.samples.length >= 2
    ? acc.samples[acc.samples.length - 1].genMs - acc.samples[0].genMs
    : 0;
  const windowSec = Math.round(Math.min(windowSpanMs, WINDOW_MS) / 1000);

  // Time-to-first-token is surfaced INLINE on the speed chip (always visible,
  // not just on hover) as ` · 1.3s` appended to the rate label. The latency
  // breakdown is appended to the tooltip for context. No measured turns yet
  // -> ttft is null and latencyLines is empty -> the label and tooltip stay
  // concise.
  const ttft = formatAvgTimeToFirstToken(stats);
  const latencyLines = formatTurnLatencyTooltipLines(stats);
  const withTtft = (label: string) => (ttft !== null ? `${label} · ${ttft}` : label);
  const ttftAria = ttft !== null ? ` Average time to first token ${ttft}.` : '';
  const withLatency = (lines: string[]): string => (
    latencyLines.length > 0 ? [...lines, ...latencyLines].join('\n') : lines.join('\n')
  );

  if (generating) {
    if (rate === null) {
      return {
        label: withTtft('—'),
        ariaLabel: `Generation rate: measuring.${ttftAria}`,
        tooltip: withLatency(['Measuring generation rate…']),
        state: 'generating',
        paused: false,
      };
    }
    const num = formatRate(rate);
    return {
      label: withTtft(`${num} tok/s`),
      ariaLabel: `Generation rate: ${num} tokens per second.${ttftAria}`,
      tooltip: withLatency([
        `Generation rate: ${num} tok/s`,
        `Average over the last ${windowSec}s of generation.`,
        `${acc.cumTokens} output tokens in ${genSec}s of generation time.`,
        'Includes output from running subagents.',
        'Clock pauses during tool calls and output stalls.',
      ]),
      state: 'generating',
      paused: false,
    };
  }

  const reason = describePauseReason(streaming, toolBlocked);
  if (rate === null) {
    return {
      label: withTtft('—'),
      ariaLabel: `Generation paused (${reason}).${ttftAria}`,
      tooltip: withLatency([
        `Generation paused (${reason}).`,
        'Waiting for the model to produce output.',
      ]),
      state: 'paused',
      paused: true,
    };
  }
  const num = formatRate(rate);
  return {
    label: withTtft(`⏸ ${num} tok/s`),
    ariaLabel: `Generation paused (${reason}). Last rate ${num} tokens per second.${ttftAria}`,
    tooltip: withLatency([
      `Generation paused (${reason}).`,
      `Last rate: ${num} tok/s`,
      `${acc.cumTokens} output tokens in ${genSec}s of generation time.`,
      'Includes output from running subagents.',
      'Clock resumes when the model produces output again.',
    ]),
    state: 'paused',
    paused: true,
  };
}

/**
 * Advance the accumulator one tick and return the indicator state to display.
 * Pure with respect to the accumulator (mutates `acc` in place) — takes `now`
 * as a parameter so it is straightforward to unit-test and safe to run in the
 * extension host.
 */
export function tickTokenRate(
  acc: Accumulator,
  transcript: ChatMessage[],
  now: number = Date.now(),
): TokenRateIndicatorState {
  const streaming = findStreamingMessage(transcript);
  const toolBlocked = hasRunningToolCall(streaming);
  const currentTokens = estimatedOutputTokens(streaming);
  const streamingId = streaming?.id ?? null;

  let mainDelta = 0;
  if (streamingId !== null) {
    // Per-id delta: a continuation (the same canonical message id re-streaming
    // after a tool call) only counts the output added since this id was last
    // seen, not the whole accumulated message. We deliberately leave the map
    // untouched while no message is streaming (between turns / during a tool),
    // so a continuation resumes from its last-known count instead of re-counting
    // its full content.
    const previous = acc.lastContentTokensById.get(streamingId) ?? 0;
    mainDelta = Math.max(0, currentTokens - previous);
    acc.lastContentTokensById.set(streamingId, currentTokens);
    pruneContentTokenMap(acc, streamingId);
    // Time-to-first-token exclusion: a streaming message that has produced no
    // output yet (and never has) keeps the clock paused until output flows, so
    // per-turn TTFT is excluded just like the run's first message. A
    // continuation that re-appears with content counts immediately.
    if (currentTokens === 0 && previous === 0) {
      acc.lastMainGrowthWall = 0;
    }
  }

  const runningSubagents = findRunningSubagents(transcript);
  const subagentDelta = computeSubagentDelta(acc, runningSubagents);

  const totalDelta = mainDelta + subagentDelta;
  if (totalDelta > 0) {
    acc.cumTokens += totalDelta;
  }
  if (mainDelta > 0) {
    acc.lastMainGrowthWall = now;
  }
  if (subagentDelta > 0) {
    acc.lastSubagentGrowthWall = now;
  }

  const mainWithinGrace = now - acc.lastMainGrowthWall <= STALL_GRACE_MS;
  const subagentWithinGrace = now - acc.lastSubagentGrowthWall <= STALL_GRACE_MS;
  const mainActive = streaming !== null && !toolBlocked;
  const subagentActive = runningSubagents.length > 0;
  // Any output this tick IS generation — the clock must advance and a sample must
  // be pushed so tokens are always accompanied by generation time. Without this,
  // tokens that arrive while the streaming message holds a running tool call
  // (or during any other non-generating tick) would be banked into `cumTokens`
  // without `genMs` advancing, then attributed to a later tick's tiny elapsed and
  // spike the rate. The grace/subagent terms keep the clock alive across brief
  // stalls and parallel subagent streams.
  const generating = totalDelta > 0 || (mainActive && mainWithinGrace) || (subagentActive && subagentWithinGrace);

  const elapsed = Math.max(0, now - acc.lastWall);
  if (generating) {
    acc.genMs += elapsed;
    acc.samples.push({ genMs: acc.genMs, tokens: acc.cumTokens });
    trimWindow(acc);
  }
  acc.lastWall = now;

  const latencyStats = computeTurnLatencyStats(transcript);
  return buildState(acc, generating, streaming, toolBlocked, latencyStats);
}

/** Create a fresh accumulator (for tests / explicit reset). */
export function createTokenRateAccumulator(now: number = Date.now()): Accumulator {
  return createAccumulator(now);
}

export function shouldResetForRun(existingRunId: string | null | undefined, runId: string | null): boolean {
  if (existingRunId === undefined) return true;
  if (existingRunId === null) return runId !== null;
  return runId !== null && runId !== existingRunId;
}
