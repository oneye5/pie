import assert from 'node:assert/strict';
import test from 'node:test';

import type { ChatMessage } from '../src/shared/protocol';
import { buildTurnLatencyState } from '../src/webview/panel/composer/use-turn-latency';

function assistantMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'm1',
    role: 'assistant',
    createdAt: '2026-01-01T00:00:00.000Z',
    markdown: 'Done',
    status: 'completed',
    toolCalls: [],
    ...overrides,
  };
}

test('buildTurnLatencyState is idle when no finished assistant turn carries latency', () => {
  assert.equal(buildTurnLatencyState([]).label, '');
  assert.equal(buildTurnLatencyState([assistantMessage({ status: 'streaming' })]).label, '');
  // Finished but no latency fields (e.g. recorded before tracking existed).
  assert.equal(buildTurnLatencyState([assistantMessage({ turnLatencyMs: undefined })]).label, '');
});

test('buildTurnLatencyState shows the most recent finished turn breakdown', () => {
  const transcript: ChatMessage[] = [
    assistantMessage({ id: 'old', turnLatencyMs: 3_000, overheadMs: 200, providerLatencyMs: 2_800 }),
    assistantMessage({ id: 'latest', turnLatencyMs: 1_200, overheadMs: 100, providerLatencyMs: 1_100 }),
  ];
  const state = buildTurnLatencyState(transcript);
  assert.equal(state.state, 'last');
  assert.equal(state.label, '↑ 1.2s');
  assert.ok(state.tooltip.includes('1.2s'));
  assert.ok(state.tooltip.includes('our overhead: 0.1s'));
  assert.ok(state.tooltip.includes('provider: 1.1s'));
});

test('buildTurnLatencyState skips streaming turns and uses the last finished one', () => {
  const transcript: ChatMessage[] = [
    assistantMessage({ id: 'finished', turnLatencyMs: 800, overheadMs: 80, providerLatencyMs: 720 }),
    assistantMessage({ id: 'streaming', status: 'streaming', markdown: '', turnLatencyMs: undefined }),
  ];
  const state = buildTurnLatencyState(transcript);
  assert.equal(state.label, '↑ 0.8s');
});

test('buildTurnLatencyState renders sub-second and missing-component values', () => {
  const state = buildTurnLatencyState([
    assistantMessage({ turnLatencyMs: 250, overheadMs: undefined, providerLatencyMs: 220 }),
  ]);
  assert.equal(state.label, '↑ 0.3s');
  assert.ok(state.tooltip.includes('our overhead: —'));
  assert.ok(state.tooltip.includes('provider: 0.2s'));
});
