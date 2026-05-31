/**
 * Phase 5 — Streaming without overlay.
 *
 * Verifies that after removing the overlay system, streaming content is
 * correctly reflected in the Redux store and projected into ViewState, and
 * that the webview MessageItem renders streaming content from message.parts
 * alone (no overlay merge needed).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import DOMPurify from 'dompurify';
import { h } from 'preact';
import renderToString from 'preact-render-to-string';

import {
  sessionsActions,
  transcriptActions,
  selectViewState,
} from '../src/host/store';
import {
  DEFAULT_CHAT_PREFS,
  type ChatMessage,
  type ChatMessagePart,
  type ToolCall,
} from '../src/shared/protocol';

DOMPurify.sanitize = ((html: string) => html) as typeof DOMPurify.sanitize;

function useStore() {
  return (require('../src/host/store') as typeof import('../src/host/store')).store;
}

const SESSION_PATH = '/ws/streaming-test';

function setupActiveSession(store: ReturnType<typeof useStore>) {
  store.dispatch(sessionsActions.upsertSession({
    path: SESSION_PATH,
    name: 'Streaming Test',
    cwd: '/ws',
    modifiedAt: new Date().toISOString(),
    messageCount: 0,
    isPlaceholder: false,
  }));
  store.dispatch(sessionsActions.ensureOpenTab(SESSION_PATH));
  store.dispatch(sessionsActions.setActiveSessionPath(SESSION_PATH));
  store.dispatch(sessionsActions.setSessionRunning({ sessionPath: SESSION_PATH, running: true }));
}

// ─── Store-level streaming tests ───────────────────────────────────────────────

test('appendDelta accumulates text parts on message and sets status to streaming', () => {
  const store = useStore();
  setupActiveSession(store);

  store.dispatch(transcriptActions.setTranscript({
    sessionPath: SESSION_PATH,
    transcript: [
      { id: 'msg-1', role: 'assistant', createdAt: '', markdown: '', status: 'streaming' },
    ],
  }));

  store.dispatch(transcriptActions.appendDelta({ sessionPath: SESSION_PATH, messageId: 'msg-1', delta: 'Hello' }));
  store.dispatch(transcriptActions.appendDelta({ sessionPath: SESSION_PATH, messageId: 'msg-1', delta: ' world' }));

  const transcript = store.getState().transcript.bySession[SESSION_PATH]!;
  const msg = transcript.find(m => m.id === 'msg-1')!;

  assert.equal(msg.status, 'streaming');
  assert.ok(msg.parts, 'message should have parts array');
  assert.equal(msg.parts!.length, 1, 'consecutive text deltas should merge into one part');
  assert.equal(msg.parts![0].kind, 'text');
  assert.equal((msg.parts![0] as { text: string }).text, 'Hello world');
});

test('appendThinking accumulates reasoning parts on message', () => {
  const store = useStore();
  setupActiveSession(store);

  store.dispatch(transcriptActions.setTranscript({
    sessionPath: SESSION_PATH,
    transcript: [
      { id: 'msg-think', role: 'assistant', createdAt: '', markdown: '', status: 'streaming' },
    ],
  }));

  store.dispatch(transcriptActions.appendThinking({ sessionPath: SESSION_PATH, messageId: 'msg-think', thinking: 'Let me ' }));
  store.dispatch(transcriptActions.appendThinking({ sessionPath: SESSION_PATH, messageId: 'msg-think', thinking: 'think...' }));

  const msg = store.getState().transcript.bySession[SESSION_PATH]!.find(m => m.id === 'msg-think')!;
  assert.equal(msg.status, 'streaming');
  const reasoningParts = msg.parts?.filter(p => p.kind === 'reasoning') ?? [];
  assert.equal(reasoningParts.length, 1, 'consecutive reasoning should merge');
  assert.equal((reasoningParts[0] as { text: string }).text, 'Let me think...');
});

test('upsertToolCall adds and updates tool calls in message parts', () => {
  const store = useStore();
  setupActiveSession(store);

  store.dispatch(transcriptActions.setTranscript({
    sessionPath: SESSION_PATH,
    transcript: [
      { id: 'msg-tool', role: 'assistant', createdAt: '', markdown: '', status: 'streaming', parts: [] },
    ],
  }));

  // Tool started
  store.dispatch(transcriptActions.upsertToolCall({
    sessionPath: SESSION_PATH,
    messageId: 'msg-tool',
    toolCall: { id: 'tc-1', name: 'read_file', input: { path: '/a.ts' }, status: 'running' },
  }));

  let msg = store.getState().transcript.bySession[SESSION_PATH]!.find(m => m.id === 'msg-tool')!;
  const toolParts = msg.parts?.filter(p => p.kind === 'toolCall') ?? [];
  assert.equal(toolParts.length, 1);
  assert.equal((toolParts[0] as { toolCall: ToolCall }).toolCall.status, 'running');

  // Tool progress
  store.dispatch(transcriptActions.upsertToolCall({
    sessionPath: SESSION_PATH,
    messageId: 'msg-tool',
    toolCall: { id: 'tc-1', name: 'read_file', input: { path: '/a.ts' }, result: 'partial...', status: 'running' },
  }));

  msg = store.getState().transcript.bySession[SESSION_PATH]!.find(m => m.id === 'msg-tool')!;
  const updatedToolParts = msg.parts?.filter(p => p.kind === 'toolCall') ?? [];
  assert.equal(updatedToolParts.length, 1, 'should upsert, not append');
  assert.equal((updatedToolParts[0] as { toolCall: ToolCall }).toolCall.result, 'partial...');

  // Tool finished
  store.dispatch(transcriptActions.upsertToolCall({
    sessionPath: SESSION_PATH,
    messageId: 'msg-tool',
    toolCall: { id: 'tc-1', name: 'read_file', input: { path: '/a.ts' }, result: 'full content', status: 'completed' },
  }));

  msg = store.getState().transcript.bySession[SESSION_PATH]!.find(m => m.id === 'msg-tool')!;
  const finalToolParts = msg.parts?.filter(p => p.kind === 'toolCall') ?? [];
  assert.equal(finalToolParts.length, 1);
  assert.equal((finalToolParts[0] as { toolCall: ToolCall }).toolCall.status, 'completed');
  assert.equal((finalToolParts[0] as { toolCall: ToolCall }).toolCall.result, 'full content');
});

test('messageFinished (upsertMessage) replaces streaming content with authoritative message', () => {
  const store = useStore();
  setupActiveSession(store);

  store.dispatch(transcriptActions.setTranscript({
    sessionPath: SESSION_PATH,
    transcript: [
      { id: 'msg-fin', role: 'assistant', createdAt: '', markdown: '', status: 'streaming' },
    ],
  }));

  // Simulate streaming
  store.dispatch(transcriptActions.appendDelta({ sessionPath: SESSION_PATH, messageId: 'msg-fin', delta: 'partial stream' }));

  let msg = store.getState().transcript.bySession[SESSION_PATH]!.find(m => m.id === 'msg-fin')!;
  assert.equal(msg.status, 'streaming');

  // Simulate messageFinished — the authoritative message replaces the streaming one
  store.dispatch(transcriptActions.upsertMessage({
    sessionPath: SESSION_PATH,
    message: {
      id: 'msg-fin',
      role: 'assistant',
      createdAt: '2026-01-01T00:00:00Z',
      markdown: 'Final authoritative content',
      status: 'completed',
      durationMs: 1200,
      parts: [{ kind: 'text', text: 'Final authoritative content' }],
    },
  }));

  msg = store.getState().transcript.bySession[SESSION_PATH]!.find(m => m.id === 'msg-fin')!;
  assert.equal(msg.status, 'completed', 'status should be updated to completed');
  assert.equal(msg.markdown, 'Final authoritative content');
  assert.equal(msg.durationMs, 1200);
});

test('late deltas after messageFinished do not overwrite authoritative content', () => {
  const store = useStore();
  setupActiveSession(store);

  store.dispatch(transcriptActions.setTranscript({
    sessionPath: SESSION_PATH,
    transcript: [
      { id: 'msg-late', role: 'assistant', createdAt: '', markdown: '', status: 'streaming' },
    ],
  }));

  // Simulate streaming
  store.dispatch(transcriptActions.appendDelta({ sessionPath: SESSION_PATH, messageId: 'msg-late', delta: 'partial' }));

  // MessageFinished arrives with authoritative content
  store.dispatch(transcriptActions.upsertMessage({
    sessionPath: SESSION_PATH,
    message: {
      id: 'msg-late',
      role: 'assistant',
      createdAt: '2026-01-01T00:00:00Z',
      markdown: 'Authoritative final',
      status: 'completed',
    },
  }));

  // Late delta arrives after finished (race condition)
  store.dispatch(transcriptActions.appendDelta({ sessionPath: SESSION_PATH, messageId: 'msg-late', delta: ' stale' }));

  const msg = store.getState().transcript.bySession[SESSION_PATH]!.find(m => m.id === 'msg-late')!;
  // Authoritative message should not be corrupted by late delta
  assert.equal(msg.status, 'completed');
  assert.equal(msg.markdown, 'Authoritative final');
});

test('streaming content is projected into selectViewState transcript', () => {
  const store = useStore();
  setupActiveSession(store);

  store.dispatch(transcriptActions.setTranscript({
    sessionPath: SESSION_PATH,
    transcript: [
      { id: 'vs-msg', role: 'assistant', createdAt: '', markdown: '', status: 'streaming' },
    ],
  }));

  store.dispatch(transcriptActions.appendDelta({ sessionPath: SESSION_PATH, messageId: 'vs-msg', delta: 'Streamed text' }));

  const viewState = selectViewState(store.getState());
  assert.ok(viewState.transcript.length > 0);
  const msg = viewState.transcript.find(m => m.id === 'vs-msg');
  assert.ok(msg, 'streaming message should be in ViewState');
  assert.equal(msg!.status, 'streaming');
  assert.ok(msg!.parts?.some(p => p.kind === 'text' && (p as { text: string }).text === 'Streamed text'));
});

test('mixed streaming sequence: thinking → text → tool → text maintains part ordering', () => {
  const store = useStore();
  setupActiveSession(store);

  store.dispatch(transcriptActions.setTranscript({
    sessionPath: SESSION_PATH,
    transcript: [
      { id: 'msg-mixed', role: 'assistant', createdAt: '', markdown: '', status: 'streaming' },
    ],
  }));

  store.dispatch(transcriptActions.appendThinking({ sessionPath: SESSION_PATH, messageId: 'msg-mixed', thinking: 'plan' }));
  store.dispatch(transcriptActions.upsertToolCall({
    sessionPath: SESSION_PATH,
    messageId: 'msg-mixed',
    toolCall: { id: 'tc-m', name: 'write', input: {}, status: 'running' },
  }));
  store.dispatch(transcriptActions.appendDelta({ sessionPath: SESSION_PATH, messageId: 'msg-mixed', delta: 'after tool' }));
  store.dispatch(transcriptActions.upsertToolCall({
    sessionPath: SESSION_PATH,
    messageId: 'msg-mixed',
    toolCall: { id: 'tc-m', name: 'write', input: {}, status: 'completed', result: 'ok' },
  }));

  const msg = store.getState().transcript.bySession[SESSION_PATH]!.find(m => m.id === 'msg-mixed')!;
  const kinds = msg.parts?.map(p => p.kind === 'toolCall' ? `toolCall:${(p as { toolCall: ToolCall }).toolCall.status}` : p.kind) ?? [];

  assert.deepEqual(kinds, ['reasoning', 'toolCall:completed', 'text']);
});

// ─── Webview rendering tests (no overlay) ───────────────────────────────────────

const noop = () => undefined;
const noopContextMenu = () => undefined;

async function loadMessageItem() {
  await import('../src/webview/panel/transcript/register-builtins');
  const mod = await import('../src/webview/panel/transcript/message-item.tsx');
  return mod.MessageItem;
}

test('MessageItem renders streaming content from message.parts without overlay', async () => {
  const MessageItem = await loadMessageItem();

  const message: ChatMessage = {
    id: 'render-stream',
    role: 'assistant',
    createdAt: '2026-01-01T00:00:00Z',
    markdown: '',
    status: 'streaming',
    parts: [
      { kind: 'text', text: 'Hello from streaming' },
    ],
  };

  const html = renderToString(h(MessageItem, {
    message,
    isStreaming: true,
    prefs: DEFAULT_CHAT_PREFS,
    readonly: true,
    workingDirectory: '/repo',
    editingId: null,
    onEditRequest: noop,
    onEditConfirm: noop,
    onEditCancel: noop,
    onOpenFile: noop,
    onContextMenu: noopContextMenu,
    renderToolCall: () => null,
    isLastAssistantMessage: true,
    transcript: [message],
    transcriptIndex: 0,
    hasOlder: false,
  }));

  assert.match(html, /Hello from streaming/, 'streaming content should render from parts');
  assert.match(html, /Agent is responding/, 'streaming indicator should show');
});

test('MessageItem stabilizes layout during streaming via class hooks and footer slot', async () => {
  const MessageItem = await loadMessageItem();

  const message: ChatMessage = {
    id: 'render-stream-stable',
    role: 'assistant',
    createdAt: '2026-01-01T00:00:00Z',
    markdown: '',
    status: 'streaming',
    parts: [{ kind: 'text', text: 'Streaming text' }],
  };

  const html = renderToString(h(MessageItem, {
    message,
    isStreaming: true,
    prefs: DEFAULT_CHAT_PREFS,
    readonly: true,
    workingDirectory: '/repo',
    editingId: null,
    onEditRequest: noop,
    onEditConfirm: noop,
    onEditCancel: noop,
    onOpenFile: noop,
    onContextMenu: noopContextMenu,
    renderToolCall: () => null,
    isLastAssistantMessage: true,
    transcript: [message],
    transcriptIndex: 0,
    hasOlder: false,
  }));

  // `streaming` activates the fixed-width rule (prevents horizontal token growth).
  assert.match(html, /class="message role-assistant[^"]*\bstreaming\b/, 'streaming class should be applied');
  // `has-activity` + the footer slot reserve a constant footer height for the turn.
  assert.match(html, /class="message role-assistant[^"]*\bhas-activity\b/, 'has-activity class should be applied');
  assert.match(html, /message-activity-footer/, 'activity footer slot should render');
});

test('MessageItem renders completed content after messageFinished', async () => {
  const MessageItem = await loadMessageItem();

  const message: ChatMessage = {
    id: 'render-done',
    role: 'assistant',
    createdAt: '2026-01-01T00:00:00Z',
    markdown: 'Final answer here',
    status: 'completed',
    durationMs: 800,
    parts: [
      { kind: 'text', text: 'Final answer here' },
    ],
  };

  const html = renderToString(h(MessageItem, {
    message,
    isStreaming: false,
    prefs: DEFAULT_CHAT_PREFS,
    readonly: false,
    workingDirectory: '/repo',
    editingId: null,
    onEditRequest: noop,
    onEditConfirm: noop,
    onEditCancel: noop,
    onOpenFile: noop,
    onContextMenu: noopContextMenu,
    renderToolCall: () => null,
    isLastAssistantMessage: false,
    transcript: [message],
    transcriptIndex: 0,
    hasOlder: false,
  }));

  assert.match(html, /Final answer here/);
  assert.doesNotMatch(html, /Agent is responding/, 'no streaming indicator for completed');
});

test('MessageItem renders tool calls from parts without overlay', async () => {
  const MessageItem = await loadMessageItem();

  const message: ChatMessage = {
    id: 'render-tools',
    role: 'assistant',
    createdAt: '2026-01-01T00:00:00Z',
    markdown: '',
    status: 'streaming',
    parts: [
      { kind: 'text', text: 'Let me check that file.' },
      { kind: 'toolCall', toolCall: { id: 'tc-render', name: 'read_file', input: { path: '/src/a.ts' }, status: 'running' } },
    ],
  };

  const html = renderToString(h(MessageItem, {
    message,
    isStreaming: true,
    prefs: DEFAULT_CHAT_PREFS,
    readonly: true,
    workingDirectory: '/repo',
    editingId: null,
    onEditRequest: noop,
    onEditConfirm: noop,
    onEditCancel: noop,
    onOpenFile: noop,
    onContextMenu: noopContextMenu,
    renderToolCall: (tc: ToolCall) => h('span', { class: 'tool-rendered' }, tc.name),
    isLastAssistantMessage: true,
  }));

  assert.match(html, /Let me check that file/);
  assert.match(html, /tool-rendered/, 'tool call should be rendered');
  assert.match(html, /read_file/);
});

test('MessageItem shows reasoning from parts', async () => {
  const MessageItem = await loadMessageItem();

  const message: ChatMessage = {
    id: 'render-reasoning',
    role: 'assistant',
    createdAt: '2026-01-01T00:00:00Z',
    markdown: '',
    status: 'streaming',
    parts: [
      { kind: 'reasoning', text: 'I need to think about this carefully' },
      { kind: 'text', text: 'Here is my answer' },
    ],
  };

  const html = renderToString(h(MessageItem, {
    message,
    isStreaming: true,
    prefs: { ...DEFAULT_CHAT_PREFS, autoExpandReasoning: true },
    readonly: true,
    workingDirectory: '/repo',
    editingId: null,
    onEditRequest: noop,
    onEditConfirm: noop,
    onEditCancel: noop,
    onOpenFile: noop,
    onContextMenu: noopContextMenu,
    renderToolCall: () => null,
    isLastAssistantMessage: true,
  }));

  assert.match(html, /I need to think about this carefully/);
  assert.match(html, /Here is my answer/);
});

// ─── Pruning derivation from customDetails ───────────────────────────────────────

import { derivePruningResult } from '../src/host/store';

test('derivePruningResult extracts PruningResult from customDetails', () => {
  const transcript: ChatMessage[] = [
    { id: 'user-1', role: 'user', createdAt: '', markdown: 'hello', status: 'completed' },
    {
      id: 'prune-1',
      role: 'system',
      createdAt: '',
      markdown: 'Pruned: Kept 3/5 skills, Kept 8/10 tools',
      status: 'completed',
      customType: 'pruning-result',
      customDetails: {
        includedSkills: ['a', 'b', 'c'],
        excludedSkills: ['d', 'e'],
        includedTools: ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8'],
        excludedTools: ['t9', 't10'],
        mode: 'auto',
        skillTokensSaved: 1500,
        toolTokensSaved: 500,
      },
    },
  ];

  const result = derivePruningResult(transcript);
  assert.ok(result);
  assert.equal(result!.skillsKept, 3);
  assert.equal(result!.skillsTotal, 5);
  assert.equal(result!.toolsKept, 8);
  assert.equal(result!.toolsTotal, 10);
  assert.equal(result!.tokensSaved, 2000);
  assert.equal(result!.hasSkillPruning, true);
  assert.equal(result!.hasToolPruning, true);
});

test('derivePruningResult returns null when no pruning-result message exists', () => {
  const transcript: ChatMessage[] = [
    { id: 'user-1', role: 'user', createdAt: '', markdown: 'hello', status: 'completed' },
    { id: 'assist-1', role: 'assistant', createdAt: '', markdown: 'hi', status: 'completed' },
  ];

  assert.equal(derivePruningResult(transcript), null);
});

test('derivePruningResult picks the most recent pruning-result', () => {
  const transcript: ChatMessage[] = [
    {
      id: 'prune-old',
      role: 'system',
      createdAt: '',
      markdown: 'old',
      status: 'completed',
      customType: 'pruning-result',
      customDetails: {
        includedSkills: ['x'],
        excludedSkills: [],
        includedTools: ['a', 'b'],
        excludedTools: ['c'],
        mode: 'auto',
        skillTokensSaved: 100,
        toolTokensSaved: 200,
      },
    },
    {
      id: 'prune-new',
      role: 'system',
      createdAt: '',
      markdown: 'new',
      status: 'completed',
      customType: 'pruning-result',
      customDetails: {
        includedSkills: ['y', 'z'],
        excludedSkills: ['w'],
        includedTools: [],
        excludedTools: [],
        mode: 'shadow',
        skillTokensSaved: 900,
        toolTokensSaved: 0,
      },
    },
  ];

  const result = derivePruningResult(transcript);
  assert.ok(result);
  assert.equal(result!.skillsKept, 2, 'should use the latest pruning-result');
  assert.equal(result!.skillsTotal, 3);
  assert.equal(result!.hasSkillPruning, true);
  assert.equal(result!.hasToolPruning, false);
  assert.equal(result!.tokensSaved, 900);
});

test('derivePruningResult reports no pruning when nothing was excluded', () => {
  const transcript: ChatMessage[] = [
    {
      id: 'prune-noop',
      role: 'system',
      createdAt: '',
      markdown: 'no-op',
      status: 'completed',
      customType: 'pruning-result',
      customDetails: {
        includedSkills: ['a', 'b'],
        excludedSkills: [],
        includedTools: ['t1'],
        excludedTools: [],
        mode: 'auto',
        skillTokensSaved: 0,
        toolTokensSaved: 0,
      },
    },
  ];

  const result = derivePruningResult(transcript);
  assert.ok(result);
  assert.equal(result!.hasSkillPruning, false);
  assert.equal(result!.hasToolPruning, false);
  assert.equal(result!.tokensSaved, 0);
});
