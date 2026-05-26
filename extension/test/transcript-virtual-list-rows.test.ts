import assert from 'node:assert/strict';
import test from 'node:test';

import { buildTranscriptRows, estimateTranscriptRowSize } from '../src/webview/panel/transcript/virtual-list-rows';
import type { ChatMessage } from '../src/shared/protocol';

function makeMessage(id: string, role: ChatMessage['role']): ChatMessage {
  return {
    id,
    role,
    content: role === 'assistant' ? 'assistant reply' : 'user prompt',
    status: 'completed',
    parts: [],
    toolCalls: [],
    createdAt: '2026-05-16T00:00:00.000Z',
  } as unknown as ChatMessage;
}

test('buildTranscriptRows keeps system prompts, paging gaps, and messages in display order', () => {
  const rows = buildTranscriptRows({
    transcript: [
      makeMessage('user-1', 'user'),
      makeMessage('assistant-1', 'assistant'),
    ],
    systemPromptCount: 2,
    hasOlder: true,
    hasNewer: true,
    busy: false,
    hasPruningResult: false,
  });

  assert.deepEqual(
    rows.map((row) => row.kind),
    ['systemPrompts', 'topGap', 'message', 'message', 'bottomGap'],
  );
  assert.equal(rows[2]?.kind, 'message');
  assert.equal(rows[2]?.kind === 'message' ? rows[2].message.id : null, 'user-1');
  assert.equal(rows[3]?.kind === 'message' ? rows[3].message.id : null, 'assistant-1');
});

test('buildTranscriptRows omits optional system and gap rows when not needed', () => {
  const rows = buildTranscriptRows({
    transcript: [makeMessage('assistant-1', 'assistant')],
    systemPromptCount: 0,
    hasOlder: false,
    hasNewer: false,
    busy: false,
    hasPruningResult: false,
  });

  assert.deepEqual(rows.map((row) => row.kind), ['message']);
});

test('buildTranscriptRows shows systemPrompts row when hasPruningResult is true even with zero system prompts', () => {
  const rows = buildTranscriptRows({
    transcript: [makeMessage('user-1', 'user')],
    systemPromptCount: 0,
    hasOlder: false,
    hasNewer: false,
    busy: false,
    hasPruningResult: true,
  });

  assert.deepEqual(rows.map((row) => row.kind), ['systemPrompts', 'message']);
});

test('buildTranscriptRows shows standalone typingIndicator when busy and last message is user', () => {
  const rows = buildTranscriptRows({
    transcript: [
      makeMessage('user-1', 'user'),
    ],
    systemPromptCount: 0,
    hasOlder: false,
    hasNewer: false,
    busy: true,
    hasPruningResult: false,
  });

  assert.deepEqual(rows.map((row) => row.kind), ['message', 'typingIndicator']);
});

test('buildTranscriptRows suppresses standalone typingIndicator when busy and last message is assistant', () => {
  const rows = buildTranscriptRows({
    transcript: [
      makeMessage('user-1', 'user'),
      makeMessage('assistant-1', 'assistant'),
    ],
    systemPromptCount: 0,
    hasOlder: false,
    hasNewer: false,
    busy: true,
    hasPruningResult: false,
  });

  // No typingIndicator row — dots are rendered inline in the message item
  assert.deepEqual(rows.map((row) => row.kind), ['message', 'message']);
});

test('buildTranscriptRows suppresses standalone typingIndicator when assistant is streaming', () => {
  const streamingMsg = { ...makeMessage('assistant-1', 'assistant'), status: 'streaming' as const };
  const rows = buildTranscriptRows({
    transcript: [
      makeMessage('user-1', 'user'),
      streamingMsg,
    ],
    systemPromptCount: 0,
    hasOlder: false,
    hasNewer: false,
    busy: true,
    hasPruningResult: false,
  });

  assert.deepEqual(rows.map((row) => row.kind), ['message', 'message']);
});

test('buildTranscriptRows shows standalone typingIndicator when busy with empty transcript', () => {
  const rows = buildTranscriptRows({
    transcript: [],
    systemPromptCount: 0,
    hasOlder: false,
    hasNewer: false,
    busy: true,
    hasPruningResult: false,
  });

  assert.deepEqual(rows.map((row) => row.kind), ['typingIndicator']);
});

test('estimateTranscriptRowSize uses stable size buckets by row kind', () => {
  assert.equal(estimateTranscriptRowSize({ kind: 'systemPrompts', key: 'system-prompts' }), 140);
  assert.equal(estimateTranscriptRowSize({ kind: 'topGap', key: 'gap:older' }), 56);
  assert.equal(estimateTranscriptRowSize({ kind: 'bottomGap', key: 'gap:newer' }), 56);
  assert.equal(
    estimateTranscriptRowSize({ kind: 'message', key: 'message:user-1', message: makeMessage('user-1', 'user') }),
    120,
  );
  assert.equal(
    estimateTranscriptRowSize({ kind: 'message', key: 'message:assistant-1', message: makeMessage('assistant-1', 'assistant') }),
    180,
  );
});
