import { useEffect, useRef, useState } from 'preact/hooks';

import type { ChatMessage } from '../../../shared/protocol';
import { estimateTextTokens } from '../system-prompt-tokens';

/**
 * Live "average tokens per second" indicator.
 *
 * Measured entirely in the webview — STATE_CONTRACT.md § Webview-Local State
 * explicitly allows "token-rate measurement state" as ephemeral UI telemetry,
 * so no protocol/reducer changes are needed and the reducer stays pure.
 *
 * The generation clock advances ONLY while the model is actively producing
 * output: a streaming assistant message exists, no tool call on it is
 * `running`, and content grew within a short grace window. The clock freezes
 * (pauses) during tool execution, between turns, and during output stalls — so
 * the averaged rate reflects true generation speed, never blocked time.
 *
 * A rolling window of (generation-time, cumulative-output-tokens) samples over
 * the last {@link WINDOW_MS} of *generation* time (not wall-clock) yields the
 * displayed rate. Because the time axis is generation-time, every paused span
 * is excluded from both the numerator's token production and the denominator's
 * elapsed time automatically.
 */

const TICK_MS = 200;
/** Rolling window length, measured in generation-time (excludes pauses). */
export const WINDOW_MS = 10_000;
/**
 * No-growth grace before the clock pauses. Catches stalls the explicit tool/
 * turn signals miss (network stalls, anything else that pauses the underlying
 * LLM) without falsely pausing on slow-but-active generation.
 */
const STALL_GRACE_MS = 1_000;
/** Minimum generation-time span before a rate is shown (avoids a noisy first reading). */
const MIN_RATE_SPAN_MS = 300;
/** Cap on retained samples to bound memory (~48s at 200ms ticks). */
const MAX_SAMPLES = 240;

export interface TokenRateIndicatorState {
  /** Compact label e.g. "42 tok/s"; null hides the chip (idle). */
  label: string | null;
  ariaLabel: string;
  tooltip: string;
  /** 'idle' (chip hidden) | 'generating' | 'paused'. */
  state: 'idle' | 'generating' | 'paused';
  /** True while the generation clock is frozen (tool running / between turns / stall). */
  paused: boolean;
}

const IDLE_STATE: TokenRateIndicatorState = {
  label: null,
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

interface Accumulator {
  /** Generation clock — advances only while generating. */
  genMs: number;
  /** Cumulative estimated output tokens (continuous across turns within a run). */
  cumTokens: number;
  samples: Sample[];
  /** Wall-time of the last tick, for computing per-tick elapsed. */
  lastWall: number;
  /** Wall-time when output content last grew, for stall/grace detection. */
  lastGrowthWall: number;
  /** Streaming message id seen at the last tick, for turn-transition handling. */
  lastStreamingId: string | null;
  /** Estimated output tokens of the current streaming message at the last tick. */
  lastContentTokens: number;
}

function createAccumulator(now: number): Accumulator {
  return {
    genMs: 0,
    cumTokens: 0,
    samples: [],
    lastWall: now,
    // 0 = "never grew": the clock stays paused until the first output token
    // arrives, so time-to-first-token is excluded from generation time.
    lastGrowthWall: 0,
    lastStreamingId: null,
    lastContentTokens: 0,
  };
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

/** Estimated output tokens for a message: text + reasoning, via the chars/4 heuristic. */
function estimatedOutputTokens(message: ChatMessage | null): number {
  if (!message) return 0;
  return estimateTextTokens(message.markdown ?? '') + estimateTextTokens(message.thinking ?? '');
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
): TokenRateIndicatorState {
  const rate = computeRate(acc.samples);
  const genSec = Math.round(acc.genMs / 1000);
  const windowSpanMs = acc.samples.length >= 2
    ? acc.samples[acc.samples.length - 1].genMs - acc.samples[0].genMs
    : 0;
  const windowSec = Math.round(Math.min(windowSpanMs, WINDOW_MS) / 1000);

  if (generating) {
    if (rate === null) {
      return {
        label: '—',
        ariaLabel: 'Generation rate: measuring.',
        tooltip: 'Measuring generation rate…',
        state: 'generating',
        paused: false,
      };
    }
    const num = formatRate(rate);
    return {
      label: `${num} tok/s`,
      ariaLabel: `Generation rate: ${num} tokens per second.`,
      tooltip: [
        `Generation rate: ${num} tok/s`,
        `Average over the last ${windowSec}s of generation.`,
        `${acc.cumTokens} output tokens in ${genSec}s of generation time.`,
        'Clock pauses during tool calls and output stalls.',
      ].join('\n'),
      state: 'generating',
      paused: false,
    };
  }

  const reason = describePauseReason(streaming, toolBlocked);
  if (rate === null) {
    return {
      label: '—',
      ariaLabel: `Generation paused (${reason}).`,
      tooltip: `Generation paused (${reason}). Waiting for the model to produce output.`,
      state: 'paused',
      paused: true,
    };
  }
  const num = formatRate(rate);
  return {
    label: `⏸ ${num} tok/s`,
    ariaLabel: `Generation paused (${reason}). Last rate ${num} tokens per second.`,
    tooltip: [
      `Generation paused (${reason}).`,
      `Last rate: ${num} tok/s`,
      `${acc.cumTokens} output tokens in ${genSec}s of generation time.`,
      'Clock resumes when the model produces output again.',
    ].join('\n'),
    state: 'paused',
    paused: true,
  };
}

/**
 * Advance the accumulator one tick and return the indicator state to display.
 * Pure with respect to the accumulator (mutates `acc` in place) — no React state
 * is touched here, so it is straightforward to unit-test.
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

  if (streamingId === acc.lastStreamingId) {
    const delta = currentTokens - acc.lastContentTokens;
    if (delta > 0) {
      acc.cumTokens += delta;
      acc.lastGrowthWall = now;
    }
  } else {
    // Turn transition: a new streaming message appeared. Count its
    // already-present content as new tokens (captures deltas that arrived
    // between ticks). We deliberately do NOT prime the growth grace for an
    // empty message — resetting lastGrowthWall keeps the clock paused until
    // output actually flows, so per-turn time-to-first-token is excluded just
    // like the run's first message.
    if (streamingId !== null) {
      if (currentTokens > 0) {
        acc.cumTokens += currentTokens;
        acc.lastGrowthWall = now;
      } else {
        acc.lastGrowthWall = 0;
      }
    }
    acc.lastStreamingId = streamingId;
  }
  acc.lastContentTokens = currentTokens;

  const withinGrace = now - acc.lastGrowthWall <= STALL_GRACE_MS;
  const generating = streaming !== null && !toolBlocked && withinGrace;

  const elapsed = Math.max(0, now - acc.lastWall);
  if (generating) {
    acc.genMs += elapsed;
    acc.samples.push({ genMs: acc.genMs, tokens: acc.cumTokens });
    trimWindow(acc);
  }
  acc.lastWall = now;

  return buildState(acc, generating, streaming, toolBlocked);
}

/** Create a fresh accumulator (for tests / explicit reset). */
export function createTokenRateAccumulator(now: number = Date.now()): Accumulator {
  return createAccumulator(now);
}

export function useTokenRateIndicator({
  transcript,
  busy,
  sessionPath,
}: {
  transcript: ChatMessage[];
  busy: boolean;
  sessionPath: string | null;
}): TokenRateIndicatorState {
  const transcriptRef = useRef(transcript);
  transcriptRef.current = transcript;
  const lastStateRef = useRef<TokenRateIndicatorState>(IDLE_STATE);
  const [display, setDisplay] = useState<TokenRateIndicatorState>(IDLE_STATE);

  useEffect(() => {
    if (!busy) {
      lastStateRef.current = IDLE_STATE;
      setDisplay(IDLE_STATE);
      return;
    }

    // New run (or session switch while busy): start from a fresh accumulator so
    // the rolling window reflects only the current run's generation.
    const acc = createAccumulator(Date.now());

    const apply = (next: TokenRateIndicatorState): void => {
      const prev = lastStateRef.current;
      if (
        prev.label === next.label
        && prev.state === next.state
        && prev.tooltip === next.tooltip
        && prev.ariaLabel === next.ariaLabel
      ) {
        return;
      }
      lastStateRef.current = next;
      setDisplay(next);
    };

    apply(tickTokenRate(acc, transcriptRef.current));
    const id = setInterval(() => {
      apply(tickTokenRate(acc, transcriptRef.current));
    }, TICK_MS);
    return () => clearInterval(id);
  }, [busy, sessionPath]);

  return display;
}
