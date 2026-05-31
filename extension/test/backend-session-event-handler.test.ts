import assert from 'node:assert/strict';
import test from 'node:test';

import { handleSdkSessionEvent, type BackendSessionEventHandlerDeps } from '../src/backend/session-event-handler';
import type { SdkSessionEvent } from '../src/backend/sdk';
import type { SessionContext } from '../src/backend/server-types';

interface EmittedEvent {
  event: string;
  payload?: unknown;
}

function createContext(overrides: Partial<SessionContext> = {}): SessionContext {
  return {
    runtime: {} as SessionContext['runtime'],
    session: {} as SessionContext['session'],
    sessionPath: '/workspace/session.jsonl',
    unsubscribe: () => undefined,
    busySeq: 0,
    ...overrides,
  };
}

function createDeps() {
  const emitted: EmittedEvent[] = [];
  const busy: boolean[] = [];
  const sessionOpened: string[] = [];
  let listChangedCount = 0;
  let contextUsageChangedCount = 0;

  const deps: BackendSessionEventHandlerDeps = {
    emit(event, payload) {
      emitted.push({ event, payload });
    },
    emitBusyChanged(_context, nextBusy) {
      busy.push(nextBusy);
    },
    emitContextUsageChanged() {
      contextUsageChangedCount += 1;
    },
    async emitSessionOpened(sessionPath) {
      sessionOpened.push(sessionPath);
    },
    async emitSessionListChanged() {
      listChangedCount += 1;
    },
  };

  return { deps, emitted, busy, sessionOpened, getListChangedCount: () => listChangedCount, getContextUsageChangedCount: () => contextUsageChangedCount };
}

test('handleSdkSessionEvent ignores unsupported or incomplete events', () => {
  const { deps, emitted, busy, getContextUsageChangedCount, getListChangedCount } = createDeps();
  const context = createContext();

  handleSdkSessionEvent(deps, context, { type: 'message_start', message: { role: 'assistant' } });
  handleSdkSessionEvent(deps, context, { type: 'message_update', message: { role: 'assistant' }, assistantMessageEvent: { type: 'text_delta', delta: 'ignored' } });
  handleSdkSessionEvent(deps, context, { type: 'tool_execution_start' });
  handleSdkSessionEvent(deps, context, { type: 'message_end', message: { role: 'user' } });
  handleSdkSessionEvent(deps, context, { type: 'unknown-event' });

  assert.deepEqual(emitted, []);
  assert.deepEqual(busy, []);
  assert.equal(getContextUsageChangedCount(), 0);
  assert.equal(getListChangedCount(), 0);
});

test('message_start and message_update emit assistant events and update request state', () => {
  const { deps, emitted, getContextUsageChangedCount } = createDeps();
  const context = createContext({
    activeRequest: {
      id: 'req-1',
      messageIndex: 0,
      modelId: 'claude-test',
      thinkingLevel: 'high',
      aborted: false,
    },
  });

  handleSdkSessionEvent(deps, context, { type: 'agent_start' });
  handleSdkSessionEvent(deps, context, { type: 'message_start', message: { role: 'assistant' } });
  handleSdkSessionEvent(deps, context, {
    type: 'message_update',
    message: { role: 'assistant' },
    assistantMessageEvent: { type: 'text_delta', delta: 'Hello' },
  });
  handleSdkSessionEvent(deps, context, {
    type: 'message_update',
    message: { role: 'assistant' },
    assistantMessageEvent: { type: 'thinking_delta', delta: 'Reasoning' },
  });
  handleSdkSessionEvent(deps, context, {
    type: 'message_update',
    message: { role: 'assistant' },
    assistantMessageEvent: { type: 'thinking_delta', delta: '' },
  });

  assert.equal(context.activeRequest?.messageIndex, 1);
  assert.equal(context.activeRequest?.currentMessageId, 'req-1:1');
  assert.equal(context.activeRequest?.lastAssistantMessageId, 'req-1:1');
  assert.equal(typeof context.activeRequest?.currentMessageStartedAt, 'number');

  assert.deepEqual(emitted.map((entry) => entry.event), [
    'message.started',
    'message.delta',
    'message.thinking',
  ]);
  assert.deepEqual(emitted[0]?.payload, {
    requestId: 'req-1',
    messageId: 'req-1:1',
    sessionPath: '/workspace/session.jsonl',
    modelId: 'claude-test',
    thinkingLevel: 'high',
  });
  assert.deepEqual(emitted[1]?.payload, {
    requestId: 'req-1',
    sessionPath: '/workspace/session.jsonl',
    messageId: 'req-1:1',
    delta: 'Hello',
  });
  assert.deepEqual(emitted[2]?.payload, {
    requestId: 'req-1',
    sessionPath: '/workspace/session.jsonl',
    messageId: 'req-1:1',
    thinking: 'Reasoning',
  });
  assert.equal(getContextUsageChangedCount(), 5);
});

test('tool execution events emit progress only when an active assistant message exists', () => {
  const { deps, emitted, getContextUsageChangedCount } = createDeps();
  const context = createContext({
    activeRequest: {
      id: 'req-2',
      messageIndex: 1,
      lastAssistantMessageId: 'req-2:1',
      aborted: false,
    },
  });

  handleSdkSessionEvent(deps, context, {
    type: 'tool_execution_start',
    toolCallId: 'tool-1',
    toolName: 'bash',
    args: { command: 'npm test' },
  });
  handleSdkSessionEvent(deps, context, {
    type: 'tool_execution_update',
    toolCallId: 'tool-1',
    partialResult: 'still running',
  });
  handleSdkSessionEvent(deps, context, {
    type: 'tool_execution_end',
    toolCallId: 'tool-1',
    result: { ok: true },
    isError: true,
  });

  assert.deepEqual(emitted.map((entry) => entry.event), [
    'tool.started',
    'tool.progress',
    'tool.finished',
  ]);
  assert.deepEqual(emitted[0]?.payload, {
    requestId: 'req-2',
    sessionPath: '/workspace/session.jsonl',
    messageId: 'req-2:1',
    toolCallId: 'tool-1',
    name: 'bash',
    input: { command: 'npm test' },
    startedAt: (emitted[0]?.payload as { startedAt: number }).startedAt,
  });
  assert.equal(typeof (emitted[0]?.payload as { startedAt: number }).startedAt, 'number');
  assert.deepEqual(emitted[1]?.payload, {
    requestId: 'req-2',
    sessionPath: '/workspace/session.jsonl',
    messageId: 'req-2:1',
    toolCallId: 'tool-1',
    partialResult: 'still running',
  });
  assert.deepEqual(emitted[2]?.payload, {
    requestId: 'req-2',
    sessionPath: '/workspace/session.jsonl',
    messageId: 'req-2:1',
    toolCallId: 'tool-1',
    result: { ok: true },
    status: 'failed',
    durationMs: (emitted[2]?.payload as { durationMs: number }).durationMs,
  });
  assert.equal(typeof (emitted[2]?.payload as { durationMs: number }).durationMs, 'number');
  assert.equal(getContextUsageChangedCount(), 3);
});

test('message_end emits finished and aborted payloads and clears the current message id', () => {
  const { deps, emitted, getContextUsageChangedCount } = createDeps();
  const originalNow = Date.now;
  Date.now = () => Date.UTC(2026, 0, 1, 0, 0, 5);
  try {
    const context = createContext({
      activeRequest: {
        id: 'req-3',
        messageIndex: 1,
        modelId: 'claude-test',
        thinkingLevel: 'medium',
        currentMessageId: 'req-3:1',
        currentMessageStartedAt: Date.UTC(2026, 0, 1, 0, 0, 2),
        aborted: false,
      },
    });

    const messageEndEvent: SdkSessionEvent = {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Trace' },
          { type: 'text', text: 'Done' },
        ],
        stopReason: 'aborted',
        usage: { input: 2, output: 3, cacheRead: 1, cacheWrite: 0 },
      },
    };

    handleSdkSessionEvent(deps, context, messageEndEvent);

    assert.equal(context.activeRequest?.currentMessageId, undefined);
    assert.equal(context.activeRequest?.lastAssistantMessageId, 'req-3:1');
    assert.equal(context.activeRequest?.currentMessageStartedAt, undefined);
    assert.deepEqual(emitted.map((entry) => entry.event), ['message.finished', 'message.aborted']);

    const finished = emitted[0]?.payload as { message: { id: string; markdown: string; status: string; durationMs?: number; usage?: { totalTokens: number } } };
    assert.equal(finished.message.id, 'req-3:1');
    assert.equal(finished.message.markdown, 'Done');
    assert.equal(finished.message.status, 'interrupted');
    assert.equal(finished.message.durationMs, 3000);
    assert.equal(finished.message.usage?.totalTokens, 6);

    assert.deepEqual(emitted[1]?.payload, {
      requestId: 'req-3',
      sessionPath: '/workspace/session.jsonl',
      messageId: 'req-3:1',
    });
    assert.equal(getContextUsageChangedCount(), 1);
  } finally {
    Date.now = originalNow;
  }
});

test('message_end emits custom transcript messages for displayed extension output', () => {
  const { deps, emitted, getContextUsageChangedCount } = createDeps();
  const context = createContext({
    activeRequest: {
      id: 'req-custom',
      messageIndex: 0,
      aborted: false,
    },
  });

  handleSdkSessionEvent(deps, context, {
    type: 'message_end',
    message: {
      role: 'custom',
      customType: 'pruning-result',
      content: 'Pruned: Kept 4/14 skills, Kept 8/13 tools · Saved ~1815 tokens',
      details: {
        includedSkills: ['systematic-debugging'],
        excludedSkills: ['frontend-design'],
        includedTools: ['read'],
        excludedTools: ['web_search'],
        mode: 'auto',
        skillTokensSaved: 100,
        toolTokensSaved: 50,
      },
      timestamp: Date.UTC(2026, 0, 1, 0, 0, 1),
    },
  } as SdkSessionEvent);

  assert.deepEqual(emitted, [{
    event: 'message.custom',
    payload: {
      requestId: 'req-custom',
      sessionPath: '/workspace/session.jsonl',
      message: {
        id: 'req-custom:custom:1',
        role: 'system',
        createdAt: '2026-01-01T00:00:01.000Z',
        markdown: 'Pruned: Kept 4/14 skills, Kept 8/13 tools · Saved ~1815 tokens',
        status: 'completed',
        customType: 'pruning-result',
        customDetails: {
          includedSkills: ['systematic-debugging'],
          excludedSkills: ['frontend-design'],
          includedTools: ['read'],
          excludedTools: ['web_search'],
          mode: 'auto',
          skillTokensSaved: 100,
          toolTokensSaved: 50,
        },
      },
    },
  }]);
  assert.equal(context.activeRequest?.customMessageIndex, 1);
  assert.equal(context.activeRequest?.currentMessageId, undefined);
  assert.equal(context.activeRequest?.lastAssistantMessageId, undefined);
  assert.equal(getContextUsageChangedCount(), 1);
});

test('agent_end emits busy false, refreshes session state, and aborts requests with no message id', async () => {
  const { deps, emitted, busy, sessionOpened, getListChangedCount, getContextUsageChangedCount } = createDeps();
  const context = createContext({
    activeRequest: {
      id: 'req-4',
      messageIndex: 0,
      aborted: true,
    },
  });

  handleSdkSessionEvent(deps, context, { type: 'agent_end' });

  assert.deepEqual(busy, [false]);
  assert.equal(getContextUsageChangedCount(), 1);
  assert.deepEqual(sessionOpened, ['/workspace/session.jsonl']);
  assert.equal(getListChangedCount(), 1);
  assert.deepEqual(emitted, [{
    event: 'message.aborted',
    payload: {
      requestId: 'req-4',
      sessionPath: '/workspace/session.jsonl',
    },
  }]);
  assert.equal(context.activeRequest, undefined);
});

test('message_end falls back to the last or inferred message id and agent_end skips duplicate abort events', () => {
  const { deps, emitted } = createDeps();
  const context = createContext({
    activeRequest: {
      id: 'req-5',
      messageIndex: 2,
      lastAssistantMessageId: 'req-5:2',
      aborted: true,
    },
  });

  handleSdkSessionEvent(deps, context, {
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'errored' }],
      stopReason: 'error',
    },
  });

  const finished = emitted[0]?.payload as { message: { id: string; status: string } };
  assert.equal(finished.message.id, 'req-5:2');
  assert.equal(finished.message.status, 'error');
  assert.equal(emitted.find((entry) => entry.event === 'message.aborted'), undefined);

  handleSdkSessionEvent(deps, context, { type: 'agent_end' });
  assert.equal(emitted.filter((entry) => entry.event === 'message.aborted').length, 0);
  assert.equal(context.activeRequest, undefined);

  const inferredContext = createContext({
    activeRequest: {
      id: 'req-6',
      messageIndex: 0,
      aborted: false,
    },
  });
  const secondDeps = createDeps();
  handleSdkSessionEvent(secondDeps.deps, inferredContext, {
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'fresh reply' }],
    },
  });
  const inferred = secondDeps.emitted[0]?.payload as { message: { id: string } };
  assert.equal(inferred.message.id, 'req-6:1');
});

test('assistant message events ignore non-assistant roles and incomplete streaming state', () => {
  const { deps, emitted, getContextUsageChangedCount } = createDeps();
  const context = createContext({
    activeRequest: {
      id: 'req-5',
      messageIndex: 2,
      aborted: false,
    },
  });

  handleSdkSessionEvent(deps, context, { type: 'message_start', message: { role: 'user' } as any });
  handleSdkSessionEvent(deps, context, {
    type: 'message_update',
    message: { role: 'assistant' },
    assistantMessageEvent: { type: 'text_delta', delta: 'ignored' },
  });
  handleSdkSessionEvent(deps, context, { type: 'message_end', message: { role: 'user' } as any });
  handleSdkSessionEvent(deps, context, { type: 'tool_execution_update', toolCallId: 'tool-1', partialResult: 'ignored' });

  assert.deepEqual(emitted, []);
  assert.equal(getContextUsageChangedCount(), 0);
  assert.equal(context.activeRequest?.currentMessageId, undefined);
});

test('message_update emits thinking content from the explicit thinking field and skips empty tool execution state', () => {
  const { deps, emitted, getContextUsageChangedCount } = createDeps();
  const context = createContext({
    activeRequest: {
      id: 'req-6',
      messageIndex: 1,
      currentMessageId: 'req-6:1',
      lastAssistantMessageId: 'req-6:1',
      aborted: false,
    },
  });

  handleSdkSessionEvent(deps, context, {
    type: 'message_update',
    message: { role: 'assistant' },
    assistantMessageEvent: { type: 'thinking_delta', thinking: 'full reasoning', delta: '' },
  });
  handleSdkSessionEvent(deps, createContext({
    activeRequest: {
      id: 'req-6b',
      messageIndex: 1,
      aborted: false,
    },
  }), {
    type: 'tool_execution_start',
    toolName: 'bash',
  });

  assert.deepEqual(emitted, [{
    event: 'message.thinking',
    payload: {
      requestId: 'req-6',
      sessionPath: '/workspace/session.jsonl',
      messageId: 'req-6:1',
      thinking: 'full reasoning',
    },
  }]);
  assert.equal(getContextUsageChangedCount(), 1);
});

test('tool execution and message end events cover completed payloads and fallback message ids', () => {
  const { deps, emitted, getContextUsageChangedCount } = createDeps();
  const toolContext = createContext({
    activeRequest: {
      id: 'req-7',
      messageIndex: 3,
      lastAssistantMessageId: 'req-7:3',
      aborted: false,
    },
  });

  handleSdkSessionEvent(deps, toolContext, {
    type: 'tool_execution_end',
    toolCallId: undefined,
    result: { ok: true },
    isError: false,
  });

  const lastIdContext = createContext({
    activeRequest: {
      id: 'req-7b',
      messageIndex: 2,
      lastAssistantMessageId: 'req-7b:last',
      modelId: 'claude-test',
      aborted: false,
    },
  });
  handleSdkSessionEvent(deps, lastIdContext, {
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'Finished from last id' }],
      stopReason: 'end_turn',
    },
  } as any);

  const generatedIdContext = createContext({
    activeRequest: {
      id: 'req-7c',
      messageIndex: 4,
      modelId: 'claude-test',
      aborted: false,
    },
  });
  handleSdkSessionEvent(deps, generatedIdContext, {
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'Finished from generated id' }],
      stopReason: 'end_turn',
    },
  } as any);

  assert.deepEqual(emitted.map((entry) => entry.event), [
    'tool.finished',
    'message.finished',
    'message.finished',
  ]);
  assert.deepEqual(emitted[0]?.payload, {
    requestId: 'req-7',
    sessionPath: '/workspace/session.jsonl',
    messageId: 'req-7:3',
    toolCallId: '',
    result: { ok: true },
    status: 'completed',
    durationMs: 0,
  });
  assert.equal((emitted[1]?.payload as any).message.id, 'req-7b:last');
  assert.equal((emitted[1]?.payload as any).message.status, 'completed');
  assert.equal((emitted[2]?.payload as any).message.id, 'req-7c:5');
  assert.equal((emitted[2]?.payload as any).message.durationMs, undefined);
  assert.equal(getContextUsageChangedCount(), 3);
});

test('agent_end does not emit an extra aborted event when the request already has an assistant message', () => {
  const { deps, emitted, busy, sessionOpened, getListChangedCount, getContextUsageChangedCount } = createDeps();
  const context = createContext({
    activeRequest: {
      id: 'req-8',
      messageIndex: 1,
      lastAssistantMessageId: 'req-8:1',
      aborted: true,
    },
  });

  handleSdkSessionEvent(deps, context, { type: 'agent_end' });

  assert.deepEqual(busy, [false]);
  assert.equal(getContextUsageChangedCount(), 1);
  assert.deepEqual(sessionOpened, ['/workspace/session.jsonl']);
  assert.equal(getListChangedCount(), 1);
  assert.deepEqual(emitted, []);
  assert.equal(context.activeRequest, undefined);
});
