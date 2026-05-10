import test from 'node:test';
import assert from 'node:assert/strict';

import { configureStore } from '@reduxjs/toolkit';

// Import the slices and selector directly so tests run without side-effects
// from the singleton store module.
import {
  sessionsActions,
  transcriptActions,
  settingsActions,
  uiActions,
  selectViewState,
} from '../src/host/store';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStore() {
  // Re-use the same reducers from the production store but create a fresh
  // instance for each test so tests are isolated.
  // We import the reducers via the actions (slices export both).
  const { store } = require('../src/host/store') as typeof import('../src/host/store');
  // Return a reference to the singleton for now — tests call dispatch directly.
  return store;
}

const session1 = {
  path: '/ws/a',
  name: 'Session A',
  cwd: '/ws',
  modifiedAt: '2026-01-01T00:00:00.000Z',
  messageCount: 1,
};

const session2 = {
  path: '/ws/b',
  name: 'Session B',
  cwd: '/ws',
  modifiedAt: '2026-01-01T00:00:00.000Z',
  messageCount: 2,
};

const baseMsg = {
  id: 'msg-1',
  role: 'assistant' as const,
  createdAt: '2026-01-01T00:00:00.000Z',
  markdown: '',
  status: 'streaming' as const,
  toolCalls: [],
};

// ---------------------------------------------------------------------------
// Sessions slice tests
// ---------------------------------------------------------------------------

test('sessionsActions.upsertSession adds a new session at the front', () => {
  const { store } = require('../src/host/store') as typeof import('../src/host/store');
  store.dispatch(sessionsActions.setOpenTabPaths(['/ws/a']));
  store.dispatch(sessionsActions.upsertSession(session1));
  const { sessions } = store.getState().sessions;
  assert.equal(sessions.length >= 1, true);
  assert.ok(sessions.some((s) => s.path === '/ws/a'));
});

test('sessionsActions.setSessionRunning adds and removes from runningSessionPaths', () => {
  const { store } = require('../src/host/store') as typeof import('../src/host/store');
  store.dispatch(sessionsActions.setSessionRunning({ sessionPath: '/ws/a', running: true }));
  assert.ok(store.getState().sessions.runningSessionPaths.includes('/ws/a'));
  store.dispatch(sessionsActions.setSessionRunning({ sessionPath: '/ws/a', running: false }));
  assert.ok(!store.getState().sessions.runningSessionPaths.includes('/ws/a'));
});

test('sessionsActions.clearRunningPaths empties the running list', () => {
  const { store } = require('../src/host/store') as typeof import('../src/host/store');
  store.dispatch(sessionsActions.setSessionRunning({ sessionPath: '/ws/a', running: true }));
  store.dispatch(sessionsActions.setSessionRunning({ sessionPath: '/ws/b', running: true }));
  store.dispatch(sessionsActions.clearRunningPaths());
  assert.deepEqual(store.getState().sessions.runningSessionPaths, []);
});

test('sessionsActions.removeOpenTab removes the path', () => {
  const { store } = require('../src/host/store') as typeof import('../src/host/store');
  store.dispatch(sessionsActions.setOpenTabPaths(['/ws/a', '/ws/b', '/ws/c']));
  store.dispatch(sessionsActions.removeOpenTab('/ws/b'));
  assert.deepEqual(store.getState().sessions.openTabPaths, ['/ws/a', '/ws/c']);
});

test('sessionsActions.replaceOpenTabPath swaps the path', () => {
  const { store } = require('../src/host/store') as typeof import('../src/host/store');
  store.dispatch(sessionsActions.setOpenTabPaths(['/ws/a', '__pending__:1', '/ws/c']));
  store.dispatch(sessionsActions.replaceOpenTabPath({ oldPath: '__pending__:1', newPath: '/ws/new' }));
  assert.deepEqual(store.getState().sessions.openTabPaths, ['/ws/a', '/ws/new', '/ws/c']);
});

test('sessionsActions.removePendingSessions removes only pending paths from sessions list', () => {
  const { store } = require('../src/host/store') as typeof import('../src/host/store');
  store.dispatch(sessionsActions.upsertSession(session1));
  store.dispatch(
    sessionsActions.upsertSession({ ...session1, path: '__pending__:123', name: 'New Session' }),
  );
  store.dispatch(sessionsActions.removePendingSessions());
  const { sessions } = store.getState().sessions;
  assert.ok(!sessions.some((s) => s.path.startsWith('__pending__:')));
  assert.ok(sessions.some((s) => s.path === '/ws/a'));
});

// ---------------------------------------------------------------------------
// Transcript slice tests
// ---------------------------------------------------------------------------

test('transcriptActions.ensureAssistantMessage adds a streaming message', () => {
  const { store } = require('../src/host/store') as typeof import('../src/host/store');
  store.dispatch(transcriptActions.clearTranscript('/ws/a'));
  store.dispatch(sessionsActions.setActiveSession(session1));
  store.dispatch(transcriptActions.ensureAssistantMessage({ sessionPath: '/ws/a', messageId: 'msg-1' }));
  const msg = store.getState().transcript.bySession['/ws/a'].find((m) => m.id === 'msg-1');
  assert.ok(msg);
  assert.equal(msg?.status, 'streaming');
  assert.equal(msg?.role, 'assistant');
});

test('transcriptActions.ensureAssistantMessage is idempotent', () => {
  const { store } = require('../src/host/store') as typeof import('../src/host/store');
  store.dispatch(transcriptActions.clearTranscript('/ws/a'));
  store.dispatch(transcriptActions.ensureAssistantMessage({ sessionPath: '/ws/a', messageId: 'msg-1' }));
  store.dispatch(transcriptActions.ensureAssistantMessage({ sessionPath: '/ws/a', messageId: 'msg-1' }));
  assert.equal(store.getState().transcript.bySession['/ws/a'].length, 1);
});

test('transcriptActions.appendDelta accumulates markdown', () => {
  const { store } = require('../src/host/store') as typeof import('../src/host/store');
  store.dispatch(transcriptActions.clearTranscript('/ws/a'));
  store.dispatch(transcriptActions.ensureAssistantMessage({ sessionPath: '/ws/a', messageId: 'msg-1' }));
  store.dispatch(transcriptActions.appendDelta({ sessionPath: '/ws/a', messageId: 'msg-1', delta: 'Hello' }));
  store.dispatch(transcriptActions.appendDelta({ sessionPath: '/ws/a', messageId: 'msg-1', delta: ' world' }));
  const msg = store.getState().transcript.bySession['/ws/a'].find((m) => m.id === 'msg-1');
  assert.equal(msg?.markdown, 'Hello world');
});

test('transcriptActions.appendThinking accumulates thinking', () => {
  const { store } = require('../src/host/store') as typeof import('../src/host/store');
  store.dispatch(transcriptActions.clearTranscript('/ws/a'));
  store.dispatch(transcriptActions.ensureAssistantMessage({ sessionPath: '/ws/a', messageId: 'msg-1' }));
  store.dispatch(transcriptActions.appendThinking({ sessionPath: '/ws/a', messageId: 'msg-1', thinking: 'think...' }));
  store.dispatch(transcriptActions.appendThinking({ sessionPath: '/ws/a', messageId: 'msg-1', thinking: 'more' }));
  const msg = store.getState().transcript.bySession['/ws/a'].find((m) => m.id === 'msg-1');
  assert.equal(msg?.thinking, 'think...more');
});

test('transcriptActions.upsertToolCall adds and updates tool calls', () => {
  const { store } = require('../src/host/store') as typeof import('../src/host/store');
  store.dispatch(transcriptActions.clearTranscript('/ws/a'));
  store.dispatch(transcriptActions.ensureAssistantMessage({ sessionPath: '/ws/a', messageId: 'msg-1' }));

  const tc = { id: 'tc-1', name: 'bash', input: { command: 'ls' }, status: 'running' as const };
  store.dispatch(transcriptActions.upsertToolCall({ sessionPath: '/ws/a', messageId: 'msg-1', toolCall: tc }));

  let msg = store.getState().transcript.bySession['/ws/a'].find((m) => m.id === 'msg-1');
  assert.equal(msg?.toolCalls?.length, 1);
  assert.equal(msg?.toolCalls?.[0].status, 'running');

  const tcDone = { ...tc, result: 'file.txt', status: 'completed' as const };
  store.dispatch(transcriptActions.upsertToolCall({ sessionPath: '/ws/a', messageId: 'msg-1', toolCall: tcDone }));

  msg = store.getState().transcript.bySession['/ws/a'].find((m) => m.id === 'msg-1');
  assert.equal(msg?.toolCalls?.length, 1);
  assert.equal(msg?.toolCalls?.[0].status, 'completed');
});

test('transcriptActions preserve assistant part ordering across mixed events', () => {
  const { store } = require('../src/host/store') as typeof import('../src/host/store');
  store.dispatch(transcriptActions.clearTranscript('/ws/order'));
  store.dispatch(transcriptActions.ensureAssistantMessage({ sessionPath: '/ws/order', messageId: 'msg-order' }));

  store.dispatch(transcriptActions.appendThinking({ sessionPath: '/ws/order', messageId: 'msg-order', thinking: 'plan' }));
  store.dispatch(transcriptActions.upsertToolCall({
    sessionPath: '/ws/order',
    messageId: 'msg-order',
    toolCall: { id: 'tc-1', name: 'write', input: { path: 'a.txt' }, status: 'running' },
  }));
  store.dispatch(transcriptActions.appendDelta({ sessionPath: '/ws/order', messageId: 'msg-order', delta: 'after tool' }));
  store.dispatch(transcriptActions.upsertToolCall({
    sessionPath: '/ws/order',
    messageId: 'msg-order',
    toolCall: { id: 'tc-2', name: 'read', input: { path: 'a.txt' }, status: 'completed', result: 'ok' },
  }));
  store.dispatch(transcriptActions.appendThinking({ sessionPath: '/ws/order', messageId: 'msg-order', thinking: 'done' }));

  const msg = store.getState().transcript.bySession['/ws/order'].find((m) => m.id === 'msg-order');
  assert.deepEqual(
    msg?.parts?.map((part) =>
      part.kind === 'toolCall'
        ? `${part.kind}:${part.toolCall.id}`
        : `${part.kind}:${part.text}`,
    ),
    ['reasoning:plan', 'toolCall:tc-1', 'text:after tool', 'toolCall:tc-2', 'reasoning:done'],
  );
});

test('transcriptActions.upsertMessage replaces an existing message', () => {
  const { store } = require('../src/host/store') as typeof import('../src/host/store');
  store.dispatch(transcriptActions.clearTranscript('/ws/a'));
  store.dispatch(transcriptActions.ensureAssistantMessage({ sessionPath: '/ws/a', messageId: 'msg-1' }));
  store.dispatch(transcriptActions.appendDelta({ sessionPath: '/ws/a', messageId: 'msg-1', delta: 'partial' }));

  const finalMsg = { ...baseMsg, markdown: 'complete', status: 'completed' as const };
  store.dispatch(transcriptActions.upsertMessage({ sessionPath: '/ws/a', message: finalMsg }));

  const msg = store.getState().transcript.bySession['/ws/a'].find((m) => m.id === 'msg-1');
  assert.equal(msg?.markdown, 'complete');
  assert.equal(msg?.status, 'completed');
});

test('transcriptActions.setMessageStatus sets the status field', () => {
  const { store } = require('../src/host/store') as typeof import('../src/host/store');
  store.dispatch(transcriptActions.clearTranscript('/ws/a'));
  store.dispatch(transcriptActions.ensureAssistantMessage({ sessionPath: '/ws/a', messageId: 'msg-1' }));
  store.dispatch(
    transcriptActions.setMessageStatus({ sessionPath: '/ws/a', messageId: 'msg-1', status: 'interrupted' }),
  );
  const msg = store.getState().transcript.bySession['/ws/a'].find((m) => m.id === 'msg-1');
  assert.equal(msg?.status, 'interrupted');
});

test('transcriptActions.appendLocalUserMessage adds a user message', () => {
  const { store } = require('../src/host/store') as typeof import('../src/host/store');
  store.dispatch(transcriptActions.clearTranscript('/ws/a'));
  store.dispatch(transcriptActions.appendLocalUserMessage({ sessionPath: '/ws/a', id: 'u-1', text: 'hello' }));
  const msg = store.getState().transcript.bySession['/ws/a'].find((m) => m.id === 'u-1');
  assert.ok(msg);
  assert.equal(msg?.role, 'user');
  assert.equal(msg?.markdown, 'hello');
  assert.equal(msg?.status, 'completed');
});

test('transcriptActions.clearSessionState removes aliases owned by the session', () => {
  const { createAppStore } = require('../src/host/store') as typeof import('../src/host/store');
  const store = createAppStore();

  store.dispatch(transcriptActions.ensureAssistantMessage({ sessionPath: '/ws/a', messageId: 'msg-1', requestId: 'req-1' }));
  store.dispatch(transcriptActions.ensureAssistantMessage({ sessionPath: '/ws/a', messageId: 'msg-2', requestId: 'req-1' }));

  assert.equal(store.getState().transcript.messageIdAlias['msg-2'], 'msg-1');

  store.dispatch(transcriptActions.clearSessionState('/ws/a'));

  assert.deepEqual(store.getState().transcript.bySession['/ws/a'], undefined);
  assert.deepEqual(store.getState().transcript.messageIdAlias, {});
});

// ---------------------------------------------------------------------------
// Settings slice tests
// ---------------------------------------------------------------------------

test('settingsActions.setModelSettings updates model settings', () => {
  const { store } = require('../src/host/store') as typeof import('../src/host/store');
  store.dispatch(
    settingsActions.setModelSettings({ defaultModel: 'gpt-4o', defaultThinkingLevel: 'off' }),
  );
  assert.equal(store.getState().settings.modelSettings?.defaultModel, 'gpt-4o');
});

test('settingsActions.setAvailableModels skips update when incoming list is empty and existing is non-empty', () => {
  const { store } = require('../src/host/store') as typeof import('../src/host/store');
  const models = [{ id: 'gpt-4o', name: 'GPT-4o', provider: 'openai', reasoning: false }];
  store.dispatch(settingsActions.setAvailableModels(models));
  store.dispatch(settingsActions.setAvailableModels([])); // empty — should not overwrite
  assert.equal(store.getState().settings.availableModels.length, 1);
});

// ---------------------------------------------------------------------------
// UI slice tests
// ---------------------------------------------------------------------------

test('uiActions.setNotice stores and clears the notice', () => {
  const { store } = require('../src/host/store') as typeof import('../src/host/store');
  store.dispatch(uiActions.setNotice('Something went wrong'));
  assert.equal(store.getState().ui.notice, 'Something went wrong');
  store.dispatch(uiActions.setNotice(null));
  assert.equal(store.getState().ui.notice, null);
});

// ---------------------------------------------------------------------------
// selectViewState tests
// ---------------------------------------------------------------------------

test('selectViewState derives busy from activeSession and runningSessionPaths', () => {
  const { store } = require('../src/host/store') as typeof import('../src/host/store');
  store.dispatch(sessionsActions.setActiveSession(session1));
  store.dispatch(sessionsActions.setSessionRunning({ sessionPath: session1.path, running: true }));
  const viewState = selectViewState(store.getState());
  assert.equal(viewState.busy, true);

  store.dispatch(sessionsActions.setSessionRunning({ sessionPath: session1.path, running: false }));
  assert.equal(selectViewState(store.getState()).busy, false);
});

test('selectViewState.busy is false when activeSession is null', () => {
  const { store } = require('../src/host/store') as typeof import('../src/host/store');
  store.dispatch(sessionsActions.clearActiveSession());
  store.dispatch(sessionsActions.setSessionRunning({ sessionPath: session1.path, running: true }));
  assert.equal(selectViewState(store.getState()).busy, false);
});

// ---------------------------------------------------------------------------
// Lifecycle sequence: startup with session restore
// ---------------------------------------------------------------------------

test('lifecycle: session restore flow sets activeSession and transcript', () => {
  const { store } = require('../src/host/store') as typeof import('../src/host/store');
  // Simulate session.list response
  store.dispatch(sessionsActions.replaceSessionSummaries([session1, session2]));
  // Simulate session.open response (showSession)
  store.dispatch(sessionsActions.upsertSession(session1));
  store.dispatch(sessionsActions.removePendingSessions());
  store.dispatch(sessionsActions.setSessionRunning({ sessionPath: session1.path, running: false }));
  store.dispatch(sessionsActions.setActiveSession(session1));
  store.dispatch(
    transcriptActions.setTranscript({
      sessionPath: session1.path,
      transcript: [],
      systemPrompts: [{
        source: 'user',
        title: 'User system prompt',
        text: 'Be helpful.',
        summary: 'Be helpful.',
        availability: 'available',
      }],
    }),
  );
  store.dispatch(uiActions.setNotice(null));

  const vs = selectViewState(store.getState());
  assert.equal(vs.activeSession?.path, session1.path);
  assert.equal(vs.systemPrompts[0]?.text, 'Be helpful.');
  assert.equal(vs.notice, null);
  assert.equal(vs.busy, false);
});

// ---------------------------------------------------------------------------
// Lifecycle sequence: message start → delta → finish
// ---------------------------------------------------------------------------

test('lifecycle: message start → delta × 2 → finish', () => {
  const { store } = require('../src/host/store') as typeof import('../src/host/store');
  store.dispatch(transcriptActions.clearTranscript(session1.path));
  store.dispatch(sessionsActions.setActiveSession(session1));

  // message.started
  store.dispatch(transcriptActions.ensureAssistantMessage({ sessionPath: session1.path, messageId: 'msg-2' }));
  store.dispatch(sessionsActions.setSessionRunning({ sessionPath: session1.path, running: true }));
  assert.equal(selectViewState(store.getState()).busy, true);

  // message.delta × 2 (host-side store update; patches go to webview separately)
  store.dispatch(transcriptActions.appendDelta({ sessionPath: session1.path, messageId: 'msg-2', delta: 'Hi ' }));
  store.dispatch(transcriptActions.appendDelta({ sessionPath: session1.path, messageId: 'msg-2', delta: 'there' }));

  // message.finished
  const finalMsg = {
    id: 'msg-2',
    role: 'assistant' as const,
    createdAt: '2026-01-01T00:00:00.000Z',
    markdown: 'Hi there',
    status: 'completed' as const,
  };
  store.dispatch(transcriptActions.upsertMessage({ sessionPath: session1.path, message: finalMsg }));
  store.dispatch(sessionsActions.setSessionRunning({ sessionPath: session1.path, running: false }));

  const vs = selectViewState(store.getState());
  assert.equal(vs.busy, false);
  const msg = vs.transcript.find((m) => m.id === 'msg-2');
  assert.equal(msg?.markdown, 'Hi there');
  assert.equal(msg?.status, 'completed');
});

// ---------------------------------------------------------------------------
// Lifecycle sequence: interrupt
// ---------------------------------------------------------------------------

test('lifecycle: message.aborted sets status to interrupted and clears busy', () => {
  const { store } = require('../src/host/store') as typeof import('../src/host/store');
  store.dispatch(transcriptActions.clearTranscript(session1.path));
  store.dispatch(sessionsActions.setActiveSession(session1));
  store.dispatch(transcriptActions.ensureAssistantMessage({ sessionPath: session1.path, messageId: 'msg-3' }));
  store.dispatch(sessionsActions.setSessionRunning({ sessionPath: session1.path, running: true }));

  // message.aborted
  store.dispatch(
    transcriptActions.setMessageStatus({ sessionPath: session1.path, messageId: 'msg-3', status: 'interrupted' }),
  );
  store.dispatch(sessionsActions.setSessionRunning({ sessionPath: session1.path, running: false }));

  const vs = selectViewState(store.getState());
  assert.equal(vs.busy, false);
  const msg = vs.transcript.find((m) => m.id === 'msg-3');
  assert.equal(msg?.status, 'interrupted');
});

// ---------------------------------------------------------------------------
// Lifecycle sequence: tool start → finish
// ---------------------------------------------------------------------------

test('lifecycle: tool.started → tool.finished', () => {
  const { store } = require('../src/host/store') as typeof import('../src/host/store');
  store.dispatch(transcriptActions.clearTranscript(session1.path));
  store.dispatch(sessionsActions.setActiveSession(session1));
  store.dispatch(transcriptActions.ensureAssistantMessage({ sessionPath: session1.path, messageId: 'msg-4' }));

  // tool.started
  const tc = { id: 'tc-2', name: 'read_file', input: { path: 'foo.ts' }, status: 'running' as const };
  store.dispatch(transcriptActions.upsertToolCall({ sessionPath: session1.path, messageId: 'msg-4', toolCall: tc }));

  let msg = store.getState().transcript.bySession[session1.path].find((m) => m.id === 'msg-4');
  assert.equal(msg?.toolCalls?.[0]?.status, 'running');

  // tool.finished
  const tcDone = { ...tc, result: 'const x = 1;', status: 'completed' as const };
  store.dispatch(transcriptActions.upsertToolCall({ sessionPath: session1.path, messageId: 'msg-4', toolCall: tcDone }));

  msg = store.getState().transcript.bySession[session1.path].find((m) => m.id === 'msg-4');
  assert.equal(msg?.toolCalls?.[0]?.status, 'completed');
  assert.equal(msg?.toolCalls?.[0]?.result, 'const x = 1;');
});

// ---------------------------------------------------------------------------
// Model settings hydration
// ---------------------------------------------------------------------------

test('settingsActions.setModelAndAvailable updates both together', () => {
  const { store } = require('../src/host/store') as typeof import('../src/host/store');
  const models = [{
    id: 'claude-sonnet-4-5',
    name: 'Claude Sonnet',
    provider: 'anthropic',
    reasoning: true,
    contextWindow: 200000,
    maxTokens: 8192,
  }];
  store.dispatch(
    settingsActions.setModelAndAvailable({
      modelSettings: { defaultModel: 'claude-sonnet-4-5', defaultThinkingLevel: 'medium' },
      availableModels: models,
    }),
  );
  const vs = selectViewState(store.getState());
  assert.equal(vs.modelSettings?.defaultModel, 'claude-sonnet-4-5');
  assert.equal(vs.availableModels.length, 1);
});

test('selectViewState returns context usage for the active session', () => {
  const { store } = require('../src/host/store') as typeof import('../src/host/store');
  store.dispatch(sessionsActions.upsertSession(session1));
  store.dispatch(sessionsActions.upsertSession(session2));
  store.dispatch(sessionsActions.setActiveSession(session2));
  store.dispatch(settingsActions.setContextUsage({
    sessionPath: session1.path,
    contextUsage: { tokens: 1000, contextWindow: 10000, percent: 10 },
  }));
  store.dispatch(settingsActions.setContextUsage({
    sessionPath: session2.path,
    contextUsage: { tokens: 7000, contextWindow: 10000, percent: 70 },
  }));

  const vs = selectViewState(store.getState());
  assert.deepEqual(vs.contextUsage, { tokens: 7000, contextWindow: 10000, percent: 70 });
});

// ---------------------------------------------------------------------------
// Multi-turn tool-use merging (same requestId → single bubble)
// ---------------------------------------------------------------------------

test('multi-turn: second ensureAssistantMessage with same requestId aliases to first', () => {
  const { store } = require('../src/host/store') as typeof import('../src/host/store');
  store.dispatch(transcriptActions.clearTranscript('/ws/a'));

  store.dispatch(transcriptActions.ensureAssistantMessage({
    sessionPath: '/ws/a', messageId: 'req1:1', requestId: 'req1',
  }));
  store.dispatch(transcriptActions.ensureAssistantMessage({
    sessionPath: '/ws/a', messageId: 'req1:2', requestId: 'req1',
  }));

  // Only one message should exist in the transcript
  const list = store.getState().transcript.bySession['/ws/a'];
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'req1:1');
});

test('multi-turn: deltas for aliased messageId accumulate on canonical', () => {
  const { store } = require('../src/host/store') as typeof import('../src/host/store');
  store.dispatch(transcriptActions.clearTranscript('/ws/a'));

  store.dispatch(transcriptActions.ensureAssistantMessage({
    sessionPath: '/ws/a', messageId: 'req1:1', requestId: 'req1',
  }));
  store.dispatch(transcriptActions.appendDelta({ sessionPath: '/ws/a', messageId: 'req1:1', delta: 'Turn1' }));

  // Finish turn 1
  store.dispatch(transcriptActions.upsertMessage({
    sessionPath: '/ws/a',
    message: { id: 'req1:1', role: 'assistant', createdAt: '', markdown: 'Turn1', status: 'completed' },
  }));

  // Start turn 2 (same request)
  store.dispatch(transcriptActions.ensureAssistantMessage({
    sessionPath: '/ws/a', messageId: 'req1:2', requestId: 'req1',
  }));
  store.dispatch(transcriptActions.appendDelta({ sessionPath: '/ws/a', messageId: 'req1:2', delta: 'Turn2' }));

  const msg = store.getState().transcript.bySession['/ws/a'].find((m) => m.id === 'req1:1');
  assert.ok(msg?.markdown.includes('Turn1'));
  assert.ok(msg?.markdown.includes('Turn2'));
});

test('multi-turn: new requestId starts a fresh message bubble', () => {
  const { store } = require('../src/host/store') as typeof import('../src/host/store');
  store.dispatch(transcriptActions.clearTranscript('/ws/a'));

  // First user turn
  store.dispatch(transcriptActions.ensureAssistantMessage({
    sessionPath: '/ws/a', messageId: 'req1:1', requestId: 'req1',
  }));
  store.dispatch(transcriptActions.upsertMessage({
    sessionPath: '/ws/a',
    message: { id: 'req1:1', role: 'assistant', createdAt: '', markdown: 'Reply1', status: 'completed' },
  }));

  // Second user turn (new requestId)
  store.dispatch(transcriptActions.appendLocalUserMessage({ sessionPath: '/ws/a', id: 'u1', text: 'Hi again' }));
  store.dispatch(transcriptActions.ensureAssistantMessage({
    sessionPath: '/ws/a', messageId: 'req2:1', requestId: 'req2',
  }));

  const list = store.getState().transcript.bySession['/ws/a'];
  assert.equal(list.length, 3); // req1:1 + u1 + req2:1
  assert.ok(list.find((m) => m.id === 'req2:1'));
});

test('multi-turn: upsertMessage on alias merges metadata only', () => {
  const { store } = require('../src/host/store') as typeof import('../src/host/store');
  store.dispatch(transcriptActions.clearTranscript('/ws/a'));

  store.dispatch(transcriptActions.ensureAssistantMessage({
    sessionPath: '/ws/a', messageId: 'req1:1', requestId: 'req1',
  }));
  store.dispatch(transcriptActions.appendDelta({ sessionPath: '/ws/a', messageId: 'req1:1', delta: 'Turn1' }));
  store.dispatch(transcriptActions.upsertMessage({
    sessionPath: '/ws/a',
    message: { id: 'req1:1', role: 'assistant', createdAt: '', markdown: 'Turn1', status: 'completed', durationMs: 1000 },
  }));

  store.dispatch(transcriptActions.ensureAssistantMessage({
    sessionPath: '/ws/a', messageId: 'req1:2', requestId: 'req1',
  }));
  store.dispatch(transcriptActions.appendDelta({ sessionPath: '/ws/a', messageId: 'req1:2', delta: 'Turn2' }));
  store.dispatch(transcriptActions.upsertMessage({
    sessionPath: '/ws/a',
    message: { id: 'req1:2', role: 'assistant', createdAt: '', markdown: 'Turn2', status: 'completed', durationMs: 2000 },
  }));

  const msg = store.getState().transcript.bySession['/ws/a'].find((m) => m.id === 'req1:1');
  assert.equal(msg?.status, 'completed');
  assert.equal(msg?.durationMs, 3000); // accumulated
  // markdown was accumulated via deltas with separator, not replaced by turn2-only text
  assert.ok(msg?.markdown.includes('Turn1'));
  assert.ok(msg?.markdown.includes('Turn2'));
  // Only one entry in transcript
  assert.equal(store.getState().transcript.bySession['/ws/a'].length, 1);
});
