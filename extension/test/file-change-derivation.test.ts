import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveFileChangeFromToolCall,
  deriveFileChangesFromSubagentResult,
  deriveFileChangesFromTranscript,
} from '../src/host/core/file-change-derivation';
import type { ChatMessage, FileChangeEntry } from '../src/shared/protocol';

// ─── deriveFileChangeFromToolCall ───────────────────────────────────────────

test('deriveFileChangeFromToolCall: null for non-file tool', () => {
  const result = deriveFileChangeFromToolCall(
    { id: 'tc1', name: 'read', input: { path: '/foo.txt' } },
    'msg1',
    '2024-01-01T00:00:00Z',
  );
  assert.equal(result, null);
});

test('deriveFileChangeFromToolCall: created for write', () => {
  const result = deriveFileChangeFromToolCall(
    { id: 'tc1', name: 'write', input: { path: '/foo.txt', content: 'line1\nline2' } },
    'msg1',
    '2024-01-01T00:00:00Z',
  );
  assert.ok(result);
  assert.equal(result!.kind, 'created');
  assert.equal(result!.path, '/foo.txt');
  assert.equal(result!.additions, 2);
  assert.equal(result!.deletions, 0);
});

test('deriveFileChangeFromToolCall: modified for edit with oldText/newText', () => {
  const result = deriveFileChangeFromToolCall(
    {
      id: 'tc1',
      name: 'edit',
      input: { path: '/foo.txt', oldText: 'a\nb', newText: 'a\nb\nc' },
    },
    'msg1',
    '2024-01-01T00:00:00Z',
  );
  assert.ok(result);
  assert.equal(result!.kind, 'modified');
  assert.equal(result!.additions, 3);
  assert.equal(result!.deletions, 2);
});

test('deriveFileChangeFromToolCall: deleted for delete', () => {
  const result = deriveFileChangeFromToolCall(
    { id: 'tc1', name: 'delete_file', input: { path: '/foo.txt' } },
    'msg1',
    '2024-01-01T00:00:00Z',
  );
  assert.ok(result);
  assert.equal(result!.kind, 'deleted');
});

// ─── deriveFileChangesFromSubagentResult ──────────────────────────────────

function buildSubagentResult(innerToolCalls: { name: string; arguments: Record<string, unknown> }[]) {
  return {
    content: [{ type: 'text', text: 'done' }],
    details: {
      mode: 'single',
      agentScope: 'user',
      projectAgentsDir: null,
      results: [
        {
          agent: 'worker',
          agentSource: 'user',
          task: 'fix bugs',
          exitCode: 0,
          messages: [
            {
              role: 'assistant',
              content: innerToolCalls.map((tc) => ({ type: 'toolCall', ...tc })),
            },
          ],
          stderr: '',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
        },
      ],
    },
  };
}

test('deriveFileChangesFromSubagentResult: empty for non-subagent result', () => {
  const result = deriveFileChangesFromSubagentResult(
    { text: 'plain text' },
    'msg1',
    '2024-01-01T00:00:00Z',
    'tc1',
  );
  assert.deepEqual(result, []);
});

test('deriveFileChangesFromSubagentResult: extracts write from subagent messages', () => {
  const subagentResult = buildSubagentResult([
    { name: 'write', arguments: { path: '/inner.txt', content: 'hello\nworld' } },
  ]);
  const changes = deriveFileChangesFromSubagentResult(subagentResult, 'msg1', '2024-01-01T00:00:00Z', 'tc1');
  assert.equal(changes.length, 1);
  assert.equal(changes[0].path, '/inner.txt');
  assert.equal(changes[0].kind, 'created');
  assert.equal(changes[0].additions, 2);
  assert.equal(changes[0].messageId, 'msg1');
  assert.ok(changes[0].toolCallId.startsWith('tc1-sa'));
});

test('deriveFileChangesFromSubagentResult: extracts edit from subagent messages', () => {
  const subagentResult = buildSubagentResult([
    { name: 'edit', arguments: { path: '/inner.ts', oldText: 'foo', newText: 'bar\nbaz' } },
  ]);
  const changes = deriveFileChangesFromSubagentResult(subagentResult, 'msg1', '2024-01-01T00:00:00Z', 'tc1');
  assert.equal(changes.length, 1);
  assert.equal(changes[0].kind, 'modified');
  assert.equal(changes[0].additions, 2);
  assert.equal(changes[0].deletions, 1);
});

test('deriveFileChangesFromSubagentResult: skips non-file tools inside subagent', () => {
  const subagentResult = buildSubagentResult([
    { name: 'read', arguments: { path: '/inner.txt' } },
    { name: 'bash', arguments: { command: 'ls' } },
  ]);
  const changes = deriveFileChangesFromSubagentResult(subagentResult, 'msg1', '2024-01-01T00:00:00Z', 'tc1');
  assert.equal(changes.length, 0);
});

test('deriveFileChangesFromSubagentResult: handles multiple results (parallel mode)', () => {
  const subagentResult = {
    content: [{ type: 'text', text: 'done' }],
    details: {
      mode: 'parallel',
      agentScope: 'user',
      projectAgentsDir: null,
      results: [
        {
          agent: 'a1',
          agentSource: 'user',
          task: 't1',
          exitCode: 0,
          messages: [
            {
              role: 'assistant',
              content: [{ type: 'toolCall', name: 'write', arguments: { path: '/a.txt', content: 'a' } }],
            },
          ],
          stderr: '',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
        },
        {
          agent: 'a2',
          agentSource: 'user',
          task: 't2',
          exitCode: 0,
          messages: [
            {
              role: 'assistant',
              content: [{ type: 'toolCall', name: 'edit', arguments: { path: '/b.ts', oldText: 'x', newText: 'y' } }],
            },
          ],
          stderr: '',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
        },
      ],
    },
  };
  const changes = deriveFileChangesFromSubagentResult(subagentResult, 'msg1', '2024-01-01T00:00:00Z', 'tc1');
  assert.equal(changes.length, 2);
  const paths = changes.map((c) => c.path).sort();
  assert.deepEqual(paths, ['/a.txt', '/b.ts']);
});

// ─── deriveFileChangesFromTranscript ──────────────────────────────────────

function makeChatMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'm1',
    role: 'assistant',
    createdAt: '2024-01-01T00:00:00Z',
    markdown: '',
    status: 'completed',
    toolCalls: [],
    ...overrides,
  };
}

test('deriveFileChangesFromTranscript: includes regular tool calls', () => {
  const transcript: ChatMessage[] = [
    makeChatMessage({
      toolCalls: [
        { id: 'tc1', name: 'write', input: { path: '/x.txt', content: 'hello' }, status: 'completed' },
      ],
    }),
  ];
  const changes = deriveFileChangesFromTranscript(transcript);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].path, '/x.txt');
});

test('deriveFileChangesFromTranscript: includes subagent inner changes', () => {
  const subagentResult = buildSubagentResult([
    { name: 'write', arguments: { path: '/sub.txt', content: 'data' } },
  ]);
  const transcript: ChatMessage[] = [
    makeChatMessage({
      toolCalls: [
        { id: 'tc1', name: 'subagent', input: { agent: 'worker', task: 'do work' }, result: subagentResult, status: 'completed' },
      ],
    }),
  ];
  const changes = deriveFileChangesFromTranscript(transcript);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].path, '/sub.txt');
  assert.equal(changes[0].kind, 'created');
});

test('deriveFileChangesFromTranscript: accumulates subagent changes with parent changes', () => {
  const subagentResult = buildSubagentResult([
    { name: 'edit', arguments: { path: '/shared.ts', oldText: 'a\nb', newText: 'a\nb\nc\nd' } },
  ]);
  const transcript: ChatMessage[] = [
    makeChatMessage({
      toolCalls: [
        { id: 'tc1', name: 'edit', input: { path: '/shared.ts', oldText: 'x', newText: 'a\nb' }, status: 'completed' },
      ],
    }),
    makeChatMessage({
      toolCalls: [
        { id: 'tc2', name: 'subagent', input: { agent: 'worker', task: 'do more' }, result: subagentResult, status: 'completed' },
      ],
    }),
  ];
  const changes = deriveFileChangesFromTranscript(transcript);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].path, '/shared.ts');
  assert.equal(changes[0].kind, 'modified');
  assert.equal(changes[0].additions, 6); // 2 from parent + 4 from subagent
  assert.equal(changes[0].deletions, 3); // 1 from parent + 2 from subagent
});

test('deriveFileChangesFromTranscript: subagent delete removes prior create', () => {
  const subagentResult = buildSubagentResult([
    { name: 'delete_file', arguments: { path: '/temp.txt' } },
  ]);
  const transcript: ChatMessage[] = [
    makeChatMessage({
      toolCalls: [
        { id: 'tc1', name: 'write', input: { path: '/temp.txt', content: 'tmp' }, status: 'completed' },
      ],
    }),
    makeChatMessage({
      toolCalls: [
        { id: 'tc2', name: 'subagent', input: { agent: 'cleaner', task: 'cleanup' }, result: subagentResult, status: 'completed' },
      ],
    }),
  ];
  const changes = deriveFileChangesFromTranscript(transcript);
  assert.equal(changes.length, 0);
});

test('deriveFileChangesFromTranscript: skips failed subagent tool calls', () => {
  const subagentResult = buildSubagentResult([
    { name: 'write', arguments: { path: '/fail.txt', content: 'data' } },
  ]);
  const transcript: ChatMessage[] = [
    makeChatMessage({
      toolCalls: [
        { id: 'tc1', name: 'subagent', input: { agent: 'worker', task: 'do work' }, result: subagentResult, status: 'failed' },
      ],
    }),
  ];
  const changes = deriveFileChangesFromTranscript(transcript);
  assert.equal(changes.length, 0);
});
