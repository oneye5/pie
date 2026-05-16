import test from 'node:test';
import assert from 'node:assert/strict';

import { assistantReplyMeta, formatThinkingLevelLabel } from '../src/webview/panel/transcript/header';
import type { ChatMessage } from '../src/shared/protocol';

function assistantMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'assistant-1',
    role: 'assistant',
    createdAt: '2026-01-01T00:00:00.000Z',
    markdown: 'Reply',
    status: 'completed',
    ...overrides,
  };
}

test('assistantReplyMeta returns compact inline assistant metadata', () => {
  const meta = assistantReplyMeta(assistantMessage({
    modelId: 'claude-sonnet-4.6',
    thinkingLevel: 'high',
  }));

  assert.deepEqual(meta, {
    model: 'claude-sonnet-4.6',
    reasoning: 'high',
    compactText: 'claude-sonnet-4.6 high',
  });
});

test('assistantReplyMeta omits missing pieces instead of rendering placeholders', () => {
  assert.deepEqual(
    assistantReplyMeta(assistantMessage({ modelId: 'claude-sonnet-4.6' })),
    {
      model: 'claude-sonnet-4.6',
      reasoning: null,
      compactText: 'claude-sonnet-4.6',
    },
  );

  assert.deepEqual(
    assistantReplyMeta(assistantMessage({ thinkingLevel: 'xhigh' })),
    {
      model: null,
      reasoning: 'max',
      compactText: 'max',
    },
  );
});

test('assistantReplyMeta returns null when no assistant header metadata exists', () => {
  assert.equal(assistantReplyMeta(assistantMessage()), null);
  assert.equal(
    assistantReplyMeta({
      id: 'user-1',
      role: 'user',
      createdAt: '2026-01-01T00:00:00.000Z',
      markdown: 'Prompt',
      status: 'completed',
      modelId: 'claude-sonnet-4.6',
      thinkingLevel: 'high',
    }),
    null,
  );
});

test('formatThinkingLevelLabel uses lower-case compact transcript labels', () => {
  assert.equal(formatThinkingLevelLabel('minimal'), 'minimal');
  assert.equal(formatThinkingLevelLabel('high'), 'high');
  assert.equal(formatThinkingLevelLabel('xhigh'), 'max');
  assert.equal(formatThinkingLevelLabel(undefined), null);
});
