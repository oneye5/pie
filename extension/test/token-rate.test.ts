import assert from 'node:assert/strict';
import test from 'node:test';

import type { ChatMessage } from '../src/shared/protocol';
import {
  createTokenRateAccumulator,
  tickTokenRate,
  WINDOW_MS,
} from '../src/webview/panel/composer/use-token-rate';

const BASE_NOW = 1_700_000_0000;

function streamingMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'm1',
    role: 'assistant',
    createdAt: '2026-01-01T00:00:00.000Z',
    markdown: '',
    status: 'streaming',
    toolCalls: [],
    ...overrides,
  };
}

function setContent(message: ChatMessage, chars: number): ChatMessage {
  // chars/4 token heuristic -> use repeated chars so token count is deterministic.
  return { ...message, markdown: 'a'.repeat(chars) };
}

/** Drive the accumulator through a series of (transcript, nowMs) ticks. */
function runTicks(
  ticks: Array<{ transcript: ChatMessage[]; now: number }>,
) {
  const acc = createTokenRateAccumulator(BASE_NOW);
  let state = tickTokenRate(acc, ticks[0]!.transcript, ticks[0]!.now);
  for (let i = 1; i < ticks.length; i += 1) {
    state = tickTokenRate(acc, ticks[i]!.transcript, ticks[i]!.now);
  }
  return { acc, state };
}

test('idle: no streaming message shows a paused "measuring" placeholder with no rate', () => {
  const { state } = runTicks([{ transcript: [], now: BASE_NOW }]);
  assert.equal(state.state, 'paused');
  assert.equal(state.label, '—');
  assert.equal(state.paused, true);
  assert.match(state.tooltip, /Waiting for the model/);
});

test('generating: rate is output tokens divided by generation time, excluding pre-first-token latency', () => {
  const m = streamingMessage();
  // Empty -> paused (TTFT excluded); then 100 tokens/s for 2s -> ~100 tok/s.
  const { state } = runTicks([
    { transcript: [setContent(m, 0)], now: BASE_NOW },          // empty -> paused
    { transcript: [setContent(m, 400)], now: BASE_NOW + 1000 }, // 100 tokens -> sample 1
    { transcript: [setContent(m, 800)], now: BASE_NOW + 2000 }, // 200 tokens -> sample 2, rate=100 tok/s
  ]);
  assert.equal(state.state, 'generating');
  assert.equal(state.paused, false);
  assert.match(state.label!, /tok\/s/);
  const rate = Number.parseFloat(state.label!.replace(/[^\d.]/g, ''));
  assert.ok(rate >= 90 && rate <= 110, `expected ~100 tok/s, got ${rate}`);
});

test('tool call running pauses the clock: rate holds its last value and is marked paused', () => {
  const m = streamingMessage();
  // 2s of generation at 200 tokens/s -> ~200 tok/s.
  const { acc, state: afterGen } = runTicks([
    { transcript: [setContent(m, 0)], now: BASE_NOW },           // empty -> paused
    { transcript: [setContent(m, 800)], now: BASE_NOW + 1000 },  // 200 tokens -> sample 1
    { transcript: [setContent(m, 1600)], now: BASE_NOW + 2000 }, // 400 tokens -> sample 2, rate=200 tok/s
  ]);
  assert.equal(afterGen.state, 'generating');
  const genRate = Number.parseFloat(afterGen.label!.replace(/[^\d.]/g, ''));

  // A tool call starts running on the streaming message; generation is blocked.
  const blocked = setContent(
    { ...m, toolCalls: [{ id: 't1', name: 'bash', input: {}, status: 'running' }] },
    1600,
  );
  // Simulate a long tool call (5s wall-clock) — the clock must NOT advance.
  const blockedState = tickTokenRate(acc, [blocked], BASE_NOW + 7000);
  assert.equal(blockedState.state, 'paused');
  assert.equal(blockedState.paused, true);
  assert.match(blockedState.label!, /⏸/);
  assert.match(blockedState.tooltip, /tool running/);
  // Generation clock frozen during the tool call.
  assert.equal(acc.genMs, 2000);

  // Rate held at the pre-pause value (~200 tok/s), not diluted by the 5s tool call.
  const heldRate = Number.parseFloat(blockedState.label!.replace(/[^\d.]/g, ''));
  assert.equal(heldRate, genRate);
});

test('between turns pauses the clock until the next streaming message produces output', () => {
  const m = streamingMessage();
  const { acc, state: afterGen } = runTicks([
    { transcript: [setContent(m, 0)], now: BASE_NOW },
    { transcript: [setContent(m, 400)], now: BASE_NOW + 1000 },
  ]);
  assert.equal(afterGen.state, 'generating');

  // Previous message completed; no streaming message yet (between turns).
  const betweenState = tickTokenRate(acc, [], BASE_NOW + 2000);
  assert.equal(betweenState.state, 'paused');
  assert.match(betweenState.tooltip, /between turns/);
  assert.equal(acc.genMs, 1000); // clock frozen during the gap

  // Next turn begins streaming; until it produces output it stays paused...
  const m2 = streamingMessage({ id: 'm2' });
  const beforeOutput = tickTokenRate(acc, [setContent(m2, 0)], BASE_NOW + 3000);
  assert.equal(beforeOutput.state, 'paused');

  // ...and once output flows, generation resumes with cumTokens continuous.
  const resumed = tickTokenRate(acc, [setContent(m2, 400)], BASE_NOW + 4000);
  assert.equal(resumed.state, 'generating');
  // 100 tokens from turn 1 + 100 tokens from turn 2 = 200 cumulative.
  assert.equal(acc.cumTokens, 200);
});

test('output stall beyond the grace window pauses the clock (catches non-tool pauses)', () => {
  const m = streamingMessage();
  // 1s generation -> 100 tokens, then stop growing for longer than the grace window.
  const acc = createTokenRateAccumulator(BASE_NOW);
  tickTokenRate(acc, [setContent(m, 0)], BASE_NOW);
  tickTokenRate(acc, [setContent(m, 400)], BASE_NOW + 1000); // generating
  // No growth for 2s (> 1s grace) while a streaming message still exists.
  const stalled = tickTokenRate(acc, [setContent(m, 400)], BASE_NOW + 3000);
  assert.equal(stalled.state, 'paused');
  assert.match(stalled.tooltip, /waiting for output/);
});

test('rolling window averages only the last WINDOW_MS of generation time', () => {
  const m = streamingMessage();
  const acc = createTokenRateAccumulator(BASE_NOW);
  // Generate 40 tokens/s for 15s of generation (beyond the 10s window), so the
  // oldest samples age out of the window. 40 tok/s = 10 chars/ms... use 4 chars
  // (1 token) every 25ms of wall-clock -> 40 tok/s.
  tickTokenRate(acc, [setContent(m, 0)], BASE_NOW);
  let chars = 0;
  for (let ms = 200; ms <= 15_000; ms += 200) {
    chars += 4 * 200 / 25; // 200ms * (1 token / 25ms) = 8 tokens per tick
    tickTokenRate(acc, [setContent(m, Math.round(chars))], BASE_NOW + ms);
  }
  const rate = acc.samples.length >= 2
    ? (acc.samples[acc.samples.length - 1]!.tokens - acc.samples[0]!.tokens)
      / ((acc.samples[acc.samples.length - 1]!.genMs - acc.samples[0]!.genMs) / 1000)
    : 0;
  assert.ok(rate >= 35 && rate <= 45, `expected ~40 tok/s over the window, got ${rate}`);
  // Window span never exceeds WINDOW_MS in generation-time.
  const span = acc.samples[acc.samples.length - 1]!.genMs - acc.samples[0]!.genMs;
  assert.ok(span <= WINDOW_MS + 200, `window span ${span} exceeded ${WINDOW_MS}ms`);
});

test('per-turn time-to-first-token is excluded: an empty new turn pauses the clock even without a tool-call gap', () => {
  const m1 = streamingMessage({ id: 'm1' });
  const acc = createTokenRateAccumulator(BASE_NOW);
  tickTokenRate(acc, [setContent(m1, 0)], BASE_NOW);            // empty -> paused
  tickTokenRate(acc, [setContent(m1, 400)], BASE_NOW + 1000);  // 100 tokens -> generating, genMs=1000
  assert.equal(acc.genMs, 1000);

  // A second turn begins streaming while still inside the grace window of m1's
  // last growth (no tool call between turns). The clock must NOT advance during
  // m2's time-to-first-token.
  const m2 = streamingMessage({ id: 'm2' });
  const waiting = tickTokenRate(acc, [setContent(m2, 0)], BASE_NOW + 1100);
  assert.equal(waiting.state, 'paused');
  assert.equal(acc.genMs, 1000); // frozen during m2's TTFT

  // Once m2 produces output, generation resumes.
  const resumed = tickTokenRate(acc, [setContent(m2, 400)], BASE_NOW + 2100);
  assert.equal(resumed.state, 'generating');
});

test('a fresh accumulator resets the rolling window for a new run', () => {
  const m = streamingMessage();
  const acc = createTokenRateAccumulator(BASE_NOW);
  tickTokenRate(acc, [setContent(m, 0)], BASE_NOW);
  tickTokenRate(acc, [setContent(m, 400)], BASE_NOW + 1000); // ~100 tok/s

  const fresh = createTokenRateAccumulator(BASE_NOW + 60_000);
  const state = tickTokenRate(fresh, [setContent(streamingMessage(), 0)], BASE_NOW + 60_000);
  assert.equal(fresh.genMs, 0);
  assert.equal(fresh.cumTokens, 0);
  assert.equal(fresh.samples.length, 0);
  assert.equal(state.state, 'paused'); // nothing produced yet
});
