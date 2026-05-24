import assert from 'node:assert/strict';
import test from 'node:test';

import type { ChatMessage, ChatMessagePart, ToolCall } from '../src/shared/protocol';
import {
  appendAssistantTextPart,
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
