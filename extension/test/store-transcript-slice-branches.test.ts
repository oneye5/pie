import assert from 'node:assert/strict';
import test from 'node:test';

import { TRANSCRIPT_WINDOW_BUDGETS } from '../src/shared/transcript-window';
import {
  transcriptActions,
  transcriptReducer,
  type TranscriptState,
} from '../src/host/store/transcript-slice';

function reduce(
  actions: Array<ReturnType<(typeof transcriptActions)[keyof typeof transcriptActions]>>,
  state?: TranscriptState,
): TranscriptState {
  let nextState = state ?? transcriptReducer(undefined, { type: '@@init' });
  for (const action of actions) {
    nextState = transcriptReducer(nextState, action);
  }
  return nextState;
}

function assistantMessage(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    role: 'assistant' as const,
    createdAt: '2026-01-01T00:00:00.000Z',
    markdown: id,
    status: 'completed' as const,
    toolCalls: [],
    ...overrides,
  };
}

test('setTranscript can preserve existing system prompts when requested', () => {
  const initial: TranscriptState = {
    bySession: {
      '/session/a': [assistantMessage('assistant-1') as any],
    },
    systemPromptsBySession: {
      '/session/a': [{
        source: 'user',
        title: 'Prompt',
        text: 'Be helpful.',
        summary: 'Be helpful.',
        availability: 'available',
      }],
    },
    windowBySession: {},
  };

  const preserved = reduce([
    transcriptActions.setTranscript({
      sessionPath: '/session/a',
      transcript: [assistantMessage('assistant-2') as any],
      preserveCurrentTurn: true,
      preserveAliases: true,
    }),
  ], initial);

  assert.equal(preserved.systemPromptsBySession['/session/a']?.[0]?.text, 'Be helpful.');

  const reset = reduce([
    transcriptActions.setTranscript({
      sessionPath: '/session/a',
      transcript: [],
    }),
  ], initial);

  assert.deepEqual(reset.systemPromptsBySession['/session/a'], []);
});

test('setTranscriptWindowMetadata normalizes metadata against the loaded transcript', () => {
  const state = reduce([
    transcriptActions.setTranscript({
      sessionPath: '/session/window',
      transcript: [assistantMessage('assistant-1') as any, assistantMessage('assistant-2') as any],
    }),
    transcriptActions.setTranscriptWindowMetadata({
      sessionPath: '/session/window',
      transcriptWindow: {
        totalCount: 1,
        loadedStart: -5,
        loadedEnd: 99,
        hasOlder: false,
        hasNewer: false,
        isPartial: false,
        hasUserMessages: false,
      },
    }),
  ]);

  assert.deepEqual(state.windowBySession['/session/window'], {
    totalCount: 2,
    loadedStart: 0,
    loadedEnd: 2,
    hasOlder: false,
    hasNewer: false,
    isPartial: false,
    hasUserMessages: false,
  });
});

test('trimTranscriptForInactivity trims transcript tails when dropAll is false', () => {
  const state = reduce([
    transcriptActions.setTranscript({
      sessionPath: '/session/trim',
      transcript: [
        assistantMessage('assistant-1') as any,
        assistantMessage('assistant-2') as any,
        assistantMessage('assistant-3') as any,
      ],
    }),
    transcriptActions.trimTranscriptForInactivity({
      sessionPath: '/session/trim',
      keepTailCount: 1,
    }),
  ]);

  assert.deepEqual(state.bySession['/session/trim']?.map((message) => message.id), ['assistant-3']);
  assert.deepEqual(state.windowBySession['/session/trim'], {
    totalCount: 3,
    loadedStart: 2,
    loadedEnd: 3,
    hasOlder: true,
    hasNewer: false,
    isPartial: true,
    hasUserMessages: false,
  });
});

test('ensureAssistantMessage updates existing metadata and enforces the loaded-window budget', () => {
  const existingUpdated = reduce([
    transcriptActions.setTranscript({
      sessionPath: '/session/existing',
      transcript: [assistantMessage('assistant-1', { modelId: 'old', thinkingLevel: 'low' }) as any],
    }),
    transcriptActions.ensureAssistantMessage({
      sessionPath: '/session/existing',
      messageId: 'assistant-1',
      modelId: 'new-model',
      thinkingLevel: 'high',
    }),
  ]);
  assert.equal(existingUpdated.bySession['/session/existing']?.[0]?.modelId, 'new-model');
  assert.equal(existingUpdated.bySession['/session/existing']?.[0]?.thinkingLevel, 'high');

  // isAlias=true updates canonical message's status to streaming
  const aliasUpdated = reduce([
    transcriptActions.setTranscript({
      sessionPath: '/session/alias',
      transcript: [assistantMessage('canonical-1', { status: 'completed', markdown: 'hello' }) as any],
    }),
    transcriptActions.ensureAssistantMessage({
      sessionPath: '/session/alias',
      messageId: 'canonical-1',
      isAlias: true,
      modelId: 'new-model',
    }),
  ]);
  assert.equal(aliasUpdated.bySession['/session/alias']?.[0]?.status, 'streaming');
  assert.equal(aliasUpdated.bySession['/session/alias']?.[0]?.modelId, 'new-model');
  assert.equal(aliasUpdated.bySession['/session/alias']?.[0]?.markdown, 'hello\n\n');

  const crowdedTranscript = Array.from({ length: TRANSCRIPT_WINDOW_BUDGETS.maxLoadedCount }, (_value, index) =>
    assistantMessage(`assistant-${index + 1}`) as any,
  );
  const culled = reduce([
    transcriptActions.setTranscript({
      sessionPath: '/session/crowded',
      transcript: crowdedTranscript,
    }),
    transcriptActions.ensureAssistantMessage({
      sessionPath: '/session/crowded',
      messageId: 'assistant-241',
      requestId: 'req-241',
    }),
  ]);

  assert.equal(culled.bySession['/session/crowded']?.length, TRANSCRIPT_WINDOW_BUDGETS.maxLoadedCount);
  assert.equal(culled.bySession['/session/crowded']?.[0]?.id, 'assistant-2');
  assert.equal(culled.bySession['/session/crowded']?.at(-1)?.id, 'assistant-241');
  assert.deepEqual(culled.windowBySession['/session/crowded'], {
    totalCount: TRANSCRIPT_WINDOW_BUDGETS.maxLoadedCount + 1,
    loadedStart: 1,
    loadedEnd: TRANSCRIPT_WINDOW_BUDGETS.maxLoadedCount + 1,
    hasOlder: true,
    hasNewer: false,
    isPartial: true,
    hasUserMessages: false,
  });
});

test('append and status mutations are no-ops when the target message does not exist', () => {
  const initial = transcriptReducer(undefined, { type: '@@init' });
  const next = reduce([
    transcriptActions.appendDelta({ sessionPath: '/session/missing', messageId: 'missing', delta: 'hello' }),
    transcriptActions.appendThinking({ sessionPath: '/session/missing', messageId: 'missing', thinking: 'plan' }),
    transcriptActions.upsertToolCall({
      sessionPath: '/session/missing',
      messageId: 'missing',
      toolCall: { id: 'tool-1', name: 'bash', input: { command: 'pwd' }, status: 'running' },
    }),
    transcriptActions.setMessageStatus({ sessionPath: '/session/missing', messageId: 'missing', status: 'error' }),
  ], initial);

  assert.deepEqual(next, initial);
});

test('upsertMessage with canonicalMessageId merges into canonical and marks inserted user messages in window metadata', () => {
  // canonicalMessageId causes a merge into the canonical message
  const merged = reduce([
    transcriptActions.setTranscript({
      sessionPath: '/session/alias',
      transcript: [assistantMessage('canonical-1', { status: 'streaming', durationMs: 100 }) as any],
    }),
    transcriptActions.upsertMessage({
      sessionPath: '/session/alias',
      message: assistantMessage('alias-1', { status: 'completed', durationMs: 50, modelId: 'gpt-4' }) as any,
      canonicalMessageId: 'canonical-1',
    }),
  ]);
  const canonical = merged.bySession['/session/alias']?.[0];
  assert.equal(canonical?.status, 'completed');
  assert.equal(canonical?.durationMs, 150);
  assert.equal(canonical?.modelId, 'gpt-4');
  assert.equal(merged.bySession['/session/alias']?.length, 1);

  const userInserted = reduce([
    transcriptActions.upsertMessage({
      sessionPath: '/session/user',
      message: {
        id: 'user-1',
        role: 'user',
        createdAt: '2026-01-01T00:00:00.000Z',
        markdown: 'hi',
        status: 'completed',
      },
    }),
  ]);
  assert.equal(userInserted.windowBySession['/session/user']?.hasUserMessages, true);
});

test('clearTranscript removes session-scoped transcript state', () => {
  const cleared = reduce([
    transcriptActions.ensureAssistantMessage({ sessionPath: '/session/clear', messageId: 'assistant-1', requestId: 'req-1' }),
    transcriptActions.ensureAssistantMessage({ sessionPath: '/session/clear', messageId: 'assistant-2', requestId: 'req-1' }),
    transcriptActions.clearTranscript('/session/clear'),
  ]);

  assert.equal(cleared.bySession['/session/clear'], undefined);
  assert.equal(cleared.windowBySession['/session/clear'], undefined);
});

test('removeMessage keeps missing sessions unchanged and clears hasUserMessages for fully loaded transcripts', () => {
  const initial = transcriptReducer(undefined, { type: '@@init' });
  const unchanged = transcriptReducer(
    initial,
    transcriptActions.removeMessage({ sessionPath: '/session/missing', messageId: 'user-1' }),
  );
  assert.deepEqual(unchanged, initial);

  const state = reduce([
    transcriptActions.setTranscript({
      sessionPath: '/session/remove',
      transcript: [
        {
          id: 'user-1',
          role: 'user',
          createdAt: '2026-01-01T00:00:00.000Z',
          markdown: 'hello',
          status: 'completed',
        },
        assistantMessage('assistant-1') as any,
      ],
      transcriptWindow: {
        totalCount: 2,
        loadedStart: 0,
        loadedEnd: 2,
        hasOlder: false,
        hasNewer: false,
        isPartial: false,
        hasUserMessages: true,
      },
    }),
    transcriptActions.removeMessage({ sessionPath: '/session/remove', messageId: 'user-1' }),
  ]);

  assert.deepEqual(state.bySession['/session/remove']?.map((message) => message.id), ['assistant-1']);
  assert.deepEqual(state.windowBySession['/session/remove'], {
    totalCount: 1,
    loadedStart: 0,
    loadedEnd: 1,
    hasOlder: false,
    hasNewer: false,
    isPartial: false,
    hasUserMessages: false,
  });
});
