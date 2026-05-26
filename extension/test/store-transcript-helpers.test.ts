import assert from 'node:assert/strict';
import test from 'node:test';

import type { ChatMessage, ChatMessagePart, ToolCall } from '../src/shared/protocol';
import {
  appendAssistantTextPart,
  appendContinuationSeparator,
  assistantToolCallsFromMessage,
  ensureAssistantParts,
  markdownFromUserParts,
  mergeAssistantToolCallsPreservingResolvedState,
  mergeContinuationToolCalls,
  resolveAlias,
  upsertAssistantToolCall,
  withAssistantParts,
  type TranscriptState,
} from '../src/host/store/transcript-helpers';
import {
  transcriptActions,
  transcriptReducer,
  type TranscriptState as TranscriptSliceState,
} from '../src/host/store/transcript-slice';
import { reasoningFromMessageParts, textFromMessageParts } from '../src/shared/chat-message-parts';

function assistantMessage(overrides: Record<string, unknown> = {}): ChatMessage {
  return {
    id: 'assistant-1',
    role: 'assistant' as const,
    createdAt: '2026-01-01T00:00:00.000Z',
    markdown: '',
    status: 'completed' as const,
    toolCalls: [] as ToolCall[],
    ...overrides,
  } as ChatMessage;
}

test('appendContinuationSeparator appends paragraph break to markdown, thinking, and last matching part', () => {
  // Text-only message
  const textMessage = assistantMessage({
    markdown: 'Hello',
    parts: [{ kind: 'text' as const, text: 'Hello' }],
  });
  appendContinuationSeparator(textMessage as any);
  assert.equal(textMessage.markdown, 'Hello\n\n');
  assert.deepEqual(textMessage.parts, [{ kind: 'text', text: 'Hello\n\n' }]);

  // Text + tool call message — separator goes to last text/reasoning part
  const mixedMessage = assistantMessage({
    markdown: 'Before tool',
    parts: [
      { kind: 'text' as const, text: 'Before tool' },
      { kind: 'toolCall' as const, toolCall: { id: 'tc-1', name: 'bash', input: {}, status: 'completed' } },
    ],
    toolCalls: [{ id: 'tc-1', name: 'bash', input: {}, status: 'completed' }],
  });
  appendContinuationSeparator(mixedMessage as any);
  assert.equal(mixedMessage.markdown, 'Before tool\n\n');
  assert.equal((mixedMessage.parts![0] as any).text, 'Before tool\n\n');
  // Tool call part untouched
  assert.equal(mixedMessage.parts![1]!.kind, 'toolCall');

  // Thinking-only message
  const thinkingMessage = assistantMessage({
    thinking: 'Plan',
    parts: [{ kind: 'reasoning' as const, text: 'Plan' }],
  });
  appendContinuationSeparator(thinkingMessage as any);
  assert.equal(thinkingMessage.thinking, 'Plan\n\n');
  assert.deepEqual(thinkingMessage.parts, [{ kind: 'reasoning', text: 'Plan\n\n' }]);

  // Message with only tool calls (no text/reasoning) — only aggregates updated
  const toolOnlyMessage = assistantMessage({
    parts: [{ kind: 'toolCall' as const, toolCall: { id: 'tc-1', name: 'bash', input: {}, status: 'completed' } }],
    toolCalls: [{ id: 'tc-1', name: 'bash', input: {}, status: 'completed' }],
  });
  appendContinuationSeparator(toolOnlyMessage as any);
  // markdown and thinking are empty, so no '\n\n' is appended
  assert.equal(toolOnlyMessage.markdown, '');
  assert.equal(toolOnlyMessage.thinking, undefined);

  // Empty parts array — no crash
  const emptyPartsMessage = assistantMessage({ parts: [] });
  appendContinuationSeparator(emptyPartsMessage as any);
  assert.equal(emptyPartsMessage.markdown, '');

  // Double call: markdown/thinking accumulate extra '\n\n' each time, but the
  // last text/reasoning part skips the separator if already ends with '\n\n'.
  // This means the aggregate fields can drift from parts on repeated calls,
  // but `needsSeparator` in `appendAssistantTextPart` compensates by checking
  // the aggregate field directly. In practice this function is only called
  // once per continuation turn.
  const doubleMessage = assistantMessage({
    markdown: 'Hello',
    parts: [{ kind: 'text' as const, text: 'Hello' }],
  });
  appendContinuationSeparator(doubleMessage as any);
  assert.equal(doubleMessage.markdown, 'Hello\n\n');
  assert.equal(doubleMessage.parts![0]!.kind === 'text' ? doubleMessage.parts![0].text : '', 'Hello\n\n');
  appendContinuationSeparator(doubleMessage as any);
  assert.equal(doubleMessage.markdown, 'Hello\n\n\n\n');
  // Part already ends with '\n\n', so no extra separator is appended.
  // The part ends with exactly two newlines from the first call.
  assert.equal(doubleMessage.parts![0]!.kind === 'text' ? doubleMessage.parts![0].text : '', 'Hello\n\n');
});

function createState(overrides: Partial<TranscriptState> = {}): TranscriptState {
  return {
    bySession: {},
    systemPromptsBySession: {},
    windowBySession: {},
    ...overrides,
  };
}

test('resolveAlias returns canonical ids when present and falls back to the input id otherwise', () => {
  assert.equal(resolveAlias({ alias: 'canonical' }, 'alias'), 'canonical');
  assert.equal(resolveAlias({ alias: 'canonical' }, 'direct'), 'direct');
});

test('ensureAssistantParts reuses existing parts and synthesizes legacy assistant content otherwise', () => {
  const existingParts = [{ kind: 'text' as const, text: 'ready' }];
  const withExisting = assistantMessage({ parts: existingParts });
  assert.equal(ensureAssistantParts(withExisting as any), existingParts);

  const legacy = assistantMessage({
    markdown: 'final text',
    thinking: 'reasoning text',
    toolCalls: [{ id: 'tool-1', name: 'bash', input: { command: 'pwd' }, status: 'completed' }],
  });
  const synthesized = ensureAssistantParts(legacy as any);

  assert.deepEqual(
    synthesized.map((part) => part.kind === 'toolCall' ? `${part.kind}:${part.toolCall.id}` : `${part.kind}:${part.text}`),
    ['reasoning:reasoning text', 'toolCall:tool-1', 'text:final text'],
  );
});

test('withAssistantParts only clones assistant legacy messages that need synthesized parts', () => {
  const userMessage = {
    id: 'user-1',
    role: 'user' as const,
    createdAt: '2026-01-01T00:00:00.000Z',
    markdown: 'hi',
    status: 'completed' as const,
  };
  assert.equal(withAssistantParts(userMessage as any), userMessage);

  const assistantWithParts = assistantMessage({ parts: [{ kind: 'text' as const, text: 'ready' }] });
  assert.equal(withAssistantParts(assistantWithParts as any), assistantWithParts);

  const assistantLegacy = assistantMessage({ markdown: 'legacy output' });
  const normalized = withAssistantParts(assistantLegacy as any);
  assert.notEqual(normalized, assistantLegacy);
  assert.deepEqual(normalized.parts, [{ kind: 'text', text: 'legacy output' }]);
});

test('markdownFromUserParts prefers text parts and falls back when there are none', () => {
  assert.equal(markdownFromUserParts(undefined, 'fallback'), 'fallback');
  assert.equal(markdownFromUserParts([{ kind: 'image', mimeType: 'image/png', dataBase64: 'abc' }] as any, 'fallback'), 'fallback');
  assert.equal(markdownFromUserParts([
    { kind: 'text', text: 'hello ' },
    { kind: 'image', mimeType: 'image/png', dataBase64: 'abc' },
    { kind: 'text', text: 'world' },
  ] as any, 'fallback'), 'hello world');
});

test('appendAssistantTextPart ignores empty input, appends separators when needed, and updates aggregates', () => {
  const reasoningMessage = assistantMessage({
    thinking: 'Plan',
    parts: [{ kind: 'reasoning' as const, text: 'Plan' }],
  });
  appendAssistantTextPart(reasoningMessage as any, 'reasoning', ' more');
  assert.deepEqual(reasoningMessage.parts, [{ kind: 'reasoning', text: 'Plan more' }]);
  assert.equal(reasoningMessage.thinking, 'Plan more');

  const textMessage = assistantMessage({
    markdown: 'Hello\n\n',
    parts: [{ kind: 'text' as const, text: 'Hello' }],
  });
  appendAssistantTextPart(textMessage as any, 'text', 'world');
  appendAssistantTextPart(textMessage as any, 'text', '');
  assert.deepEqual(textMessage.parts, [{ kind: 'text', text: 'Hello\n\nworld' }]);
  assert.equal(textMessage.markdown, 'Hello\n\nworld');

  const mixedMessage = assistantMessage({
    thinking: 'Plan',
    parts: [{ kind: 'reasoning' as const, text: 'Plan' }],
  });
  appendAssistantTextPart(mixedMessage as any, 'text', 'world');
  assert.deepEqual(mixedMessage.parts, [
    { kind: 'reasoning', text: 'Plan' },
    { kind: 'text', text: 'world' },
  ]);
});

test('upsertAssistantToolCall adds new tool calls and replaces existing ones in both fields', () => {
  const message = assistantMessage({
    parts: [],
    toolCalls: [],
  });

  upsertAssistantToolCall(message as any, {
    id: 'tool-1',
    name: 'bash',
    input: { command: 'pwd' },
    status: 'running',
  });
  upsertAssistantToolCall(message as any, {
    id: 'tool-1',
    name: 'bash',
    input: { command: 'pwd' },
    result: '/workspace',
    status: 'completed',
  });

  assert.equal(message.toolCalls!.length, 1);
  assert.equal(message.toolCalls![0]?.status, 'completed');
  assert.equal(message.parts!.length, 1);
  assert.equal(message.parts![0]?.kind, 'toolCall');
  assert.equal(message.parts![0]?.kind === 'toolCall' ? message.parts![0].toolCall.result : undefined, '/workspace');
});

test('mergeContinuationToolCalls consumes incoming tool calls from parts first and falls back to toolCalls', () => {
  const targetFromParts = assistantMessage({ parts: [], toolCalls: [] });
  mergeContinuationToolCalls(targetFromParts as any, assistantMessage({
    parts: [{ kind: 'toolCall' as const, toolCall: { id: 'tool-part', name: 'read', input: { path: 'a.ts' }, status: 'completed' } }],
  }) as any);
  assert.deepEqual(targetFromParts.toolCalls?.map((toolCall: any) => toolCall.id), ['tool-part']);

  const targetFromLegacy = assistantMessage({ parts: [], toolCalls: [] });
  mergeContinuationToolCalls(targetFromLegacy as any, assistantMessage({
    toolCalls: [{ id: 'tool-legacy', name: 'write', input: { path: 'b.ts' }, status: 'completed' }],
  }) as any);
  assert.deepEqual(targetFromLegacy.toolCalls?.map((toolCall: any) => toolCall.id), ['tool-legacy']);
});

test('assistantToolCallsFromMessage returns cloned assistant tool calls and ignores non-assistant messages', () => {
  const message = assistantMessage({
    parts: [{ kind: 'toolCall' as const, toolCall: { id: 'tool-1', name: 'edit', input: { path: 'a.ts' }, status: 'completed' } }],
  });
  const extracted = assistantToolCallsFromMessage(message as any);
  extracted[0]!.name = 'changed';

  assert.equal(extracted.length, 1);
  assert.equal(message.parts![0]?.kind === 'toolCall' ? message.parts![0].toolCall.name : undefined, 'edit');
  assert.deepEqual(assistantToolCallsFromMessage({ role: 'user' } as any), []);
});

test('mergeAssistantToolCallsPreservingResolvedState preserves failed results and carries forward missing tool calls', () => {
  const target = assistantMessage({
    parts: [{ kind: 'toolCall' as const, toolCall: { id: 'tool-1', name: '', status: 'completed' } }],
    toolCalls: [{ id: 'tool-1', name: '', status: 'completed' }],
  });
  const previous = assistantMessage({
    parts: [
      { kind: 'toolCall' as const, toolCall: { id: 'tool-1', name: 'bash', input: { command: 'npm test' }, result: 'boom', status: 'failed' } },
      { kind: 'toolCall' as const, toolCall: { id: 'tool-2', name: 'read', input: { path: 'a.ts' }, status: 'completed' } },
    ],
  });

  mergeAssistantToolCallsPreservingResolvedState(target as any, previous as any);

  const mergedCalls = assistantToolCallsFromMessage(target as any);
  assert.deepEqual(mergedCalls, [
    { id: 'tool-1', name: 'bash', input: { command: 'npm test' }, result: 'boom', status: 'failed' },
    { id: 'tool-2', name: 'read', input: { path: 'a.ts' }, status: 'completed' },
  ]);

  const userTarget = { role: 'user', toolCalls: [{ id: 'user-tool', name: 'bash', status: 'completed' }] };
  mergeAssistantToolCallsPreservingResolvedState(userTarget as any, previous as any);
  assert.deepEqual(userTarget.toolCalls, [{ id: 'user-tool', name: 'bash', status: 'completed' }]);
});

function reduceTranscript(
  actions: Array<ReturnType<(typeof transcriptActions)[keyof typeof transcriptActions]>>,
  state?: TranscriptSliceState,
): TranscriptSliceState {
  let nextState = state ?? transcriptReducer(undefined, { type: '@@init' });
  for (const action of actions) {
    nextState = transcriptReducer(nextState, action);
  }
  return nextState;
}

function getAssistantMessage(state: TranscriptSliceState, sessionPath: string, messageId: string): ChatMessage {
  const message = state.bySession[sessionPath]?.find((candidate) => candidate.id === messageId);
  assert.ok(message, `Expected message ${messageId} in session ${sessionPath}`);
  assert.equal(message.role, 'assistant');
  return message;
}

function assertAssistantAggregateConsistency(message: ChatMessage): void {
  // After all actions, verify markdown matches textFromMessageParts + reasoningFromMessageParts
  const textParts = message.parts?.filter((part) => part.kind === 'text').map((part) => part.text).join('') ?? '';
  const reasoningParts = message.parts?.filter((part) => part.kind === 'reasoning').map((part) => part.text).join('') ?? '';
  assert.equal(message.markdown, textParts);
  assert.equal(message.thinking ?? '', reasoningParts);
}

test('alias continuation with text followed by more text keeps markdown and parts consistent', () => {
  const sessionPath = '/session/alias-text';
  const messageId = 'assistant-1';
  const state = reduceTranscript([
    transcriptActions.ensureAssistantMessage({ sessionPath, messageId }),
    transcriptActions.appendDelta({ sessionPath, messageId, delta: 'Turn one' }),
    transcriptActions.setMessageStatus({ sessionPath, messageId, status: 'completed' }),
    transcriptActions.ensureAssistantMessage({ sessionPath, messageId, isAlias: true }),
    transcriptActions.appendDelta({ sessionPath, messageId, delta: 'Turn two' }),
    transcriptActions.appendDelta({ sessionPath, messageId, delta: ' continued' }),
  ]);

  const message = getAssistantMessage(state, sessionPath, messageId);
  assertAssistantAggregateConsistency(message);
  assert.ok(message.markdown.includes('Turn one\n\nTurn two continued'));
});

test('alias continuation where last part is a tool call and continuation starts with text keeps separator in markdown and parts', () => {
  const sessionPath = '/session/alias-toolcall-to-text';
  const messageId = 'assistant-1';
  const state = reduceTranscript([
    transcriptActions.ensureAssistantMessage({ sessionPath, messageId }),
    transcriptActions.appendDelta({ sessionPath, messageId, delta: 'Turn one' }),
    transcriptActions.upsertToolCall({
      sessionPath,
      messageId,
      toolCall: { id: 'tool-1', name: 'bash', input: { command: 'pwd' }, status: 'completed' },
    }),
    transcriptActions.setMessageStatus({ sessionPath, messageId, status: 'completed' }),
    transcriptActions.ensureAssistantMessage({ sessionPath, messageId, isAlias: true }),
    transcriptActions.appendDelta({ sessionPath, messageId, delta: 'Turn two' }),
  ]);

  const message = getAssistantMessage(state, sessionPath, messageId);
  assertAssistantAggregateConsistency(message);

  // Check that the separator between turns is present in both markdown AND parts
  const textParts = message.parts?.filter((part) => part.kind === 'text').map((part) => part.text).join('') ?? '';
  assert.ok(message.markdown.includes('\n\nTurn two'));
  assert.ok(textParts.includes('\n\nTurn two'));
});

test('alias continuation with thinking followed by more thinking keeps aggregates and parts consistent', () => {
  const sessionPath = '/session/alias-thinking';
  const messageId = 'assistant-1';
  const state = reduceTranscript([
    transcriptActions.ensureAssistantMessage({ sessionPath, messageId }),
    transcriptActions.appendThinking({ sessionPath, messageId, thinking: 'First thought' }),
    transcriptActions.setMessageStatus({ sessionPath, messageId, status: 'completed' }),
    transcriptActions.ensureAssistantMessage({ sessionPath, messageId, isAlias: true }),
    transcriptActions.appendThinking({ sessionPath, messageId, thinking: 'Second thought' }),
    transcriptActions.appendThinking({ sessionPath, messageId, thinking: ' expanded' }),
  ]);

  const message = getAssistantMessage(state, sessionPath, messageId);
  assertAssistantAggregateConsistency(message);
  assert.equal(message.thinking, 'First thought\n\nSecond thought expanded');
});

test('alias continuation with text followed by thinking keeps markdown and parts consistent', () => {
  const sessionPath = '/session/alias-text-to-thinking';
  const messageId = 'assistant-1';
  const state = reduceTranscript([
    transcriptActions.ensureAssistantMessage({ sessionPath, messageId }),
    transcriptActions.appendDelta({ sessionPath, messageId, delta: 'Turn one' }),
    transcriptActions.setMessageStatus({ sessionPath, messageId, status: 'completed' }),
    transcriptActions.ensureAssistantMessage({ sessionPath, messageId, isAlias: true }),
    transcriptActions.appendThinking({ sessionPath, messageId, thinking: 'Reasoning for continuation' }),
  ]);

  const message = getAssistantMessage(state, sessionPath, messageId);
  assertAssistantAggregateConsistency(message);
  assert.equal(message.thinking, 'Reasoning for continuation');
});

test('multiple alias continuations in sequence preserve separators in markdown and parts', () => {
  const sessionPath = '/session/alias-multi';
  const messageId = 'assistant-1';
  const state = reduceTranscript([
    transcriptActions.ensureAssistantMessage({ sessionPath, messageId }),
    transcriptActions.appendDelta({ sessionPath, messageId, delta: 'Turn one' }),
    transcriptActions.setMessageStatus({ sessionPath, messageId, status: 'completed' }),
    transcriptActions.ensureAssistantMessage({ sessionPath, messageId, isAlias: true }),
    transcriptActions.appendDelta({ sessionPath, messageId, delta: 'Turn two' }),
    transcriptActions.setMessageStatus({ sessionPath, messageId, status: 'completed' }),
    transcriptActions.ensureAssistantMessage({ sessionPath, messageId, isAlias: true }),
    transcriptActions.appendDelta({ sessionPath, messageId, delta: 'Turn three' }),
  ]);

  const message = getAssistantMessage(state, sessionPath, messageId);
  assertAssistantAggregateConsistency(message);
  assert.equal(message.markdown, 'Turn one\n\nTurn two\n\nTurn three');
});

test('full flow ensureAssistantMessage → appendDelta → ensureAssistantMessage(alias) → appendDelta stays consistent with part helpers', () => {
  const sessionPath = '/session/alias-full-flow';
  const messageId = 'assistant-1';
  const state = reduceTranscript([
    transcriptActions.ensureAssistantMessage({ sessionPath, messageId }),
    transcriptActions.appendDelta({ sessionPath, messageId, delta: 'Turn one' }),
    transcriptActions.ensureAssistantMessage({ sessionPath, messageId, isAlias: true }),
    transcriptActions.appendDelta({ sessionPath, messageId, delta: 'Turn two' }),
  ]);

  const message = getAssistantMessage(state, sessionPath, messageId);
  assert.equal(message.markdown, textFromMessageParts(message.parts));
  assert.equal(message.thinking ?? '', reasoningFromMessageParts(message.parts) ?? '');
  assertAssistantAggregateConsistency(message);
});

test('BUG REPRO: alias continuation after tool call preserves separator between text parts', () => {
  const sessionPath = '/session/alias-bug-repro';
  const messageId = 'assistant-1';
  const state = reduceTranscript([
    transcriptActions.ensureAssistantMessage({ sessionPath, messageId }),
    transcriptActions.appendDelta({ sessionPath, messageId, delta: 'Before tool' }),
    transcriptActions.upsertToolCall({
      sessionPath,
      messageId,
      toolCall: { id: 'tool-1', name: 'read', input: { path: 'a.ts' }, status: 'completed' },
    }),
    transcriptActions.setMessageStatus({ sessionPath, messageId, status: 'completed' }),
    transcriptActions.ensureAssistantMessage({ sessionPath, messageId, isAlias: true }),
    transcriptActions.appendDelta({ sessionPath, messageId, delta: 'After tool' }),
  ]);

  const message = getAssistantMessage(state, sessionPath, messageId);
  const textParts = message.parts?.filter((part) => part.kind === 'text').map((part) => part.text) ?? [];

  // The separator '\n\n' is placed at the end of the preceding text part,
  // not at the start of the continuation text part.
  assert.equal(message.markdown, 'Before tool\n\nAfter tool');
  assert.deepEqual(textParts, ['Before tool\n\n', 'After tool']);

  // Aggregates stay consistent: concatenating all text parts gives the same
  // result as the markdown field.
  assertAssistantAggregateConsistency(message);
});
