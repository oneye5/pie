/**
 * Tests targeting state/reducer invariants, edge cases, and consistency across
 * the arch reducer, Redux slices, and selectViewState projection.
 *
 * Fills gaps in existing coverage: SessionClosed cleanup, cross-session
 * isolation, UI slice deep merges, settings empty-refresh preservation,
 * ViewState consistency, and slice-specific edge cases.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { reducer, initialArchState, type ArchState } from '../src/host/core/reducer';
import type { Event } from '../src/host/core/events';
import {
  sessionsActions,
  transcriptActions,
  settingsActions,
  uiActions,
  createAppStore,
  sessionStateActions,
  fileChangesActions,
  selectViewState,
} from '../src/host/store';
import { sessionsReducer } from '../src/host/store/sessions-slice';
import { transcriptReducer } from '../src/host/store/transcript-slice';
import { settingsReducer } from '../src/host/store/settings-slice';
import { uiReducer } from '../src/host/store/ui-slice';
import { sessionStateReducer } from '../src/host/store/session-state-slice';
import { fileChangesReducer } from '../src/host/store/file-changes-slice';
import { CHAT_PREF_MENU_SECTIONS } from '../src/webview/panel/chat-prefs';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function archStateWithSession(path: string): ArchState {
  return {
    ...initialArchState,
    sessions: { [path]: { interruptInFlight: false } },
  };
}

function archStateWithPending(
  corrId: string,
  op: { kind: 'send' | 'edit'; sessionPath: string; localId: string; previousSummary?: any },
): ArchState {
  return {
    ...initialArchState,
    pending: {
      [corrId]: { ...op, previousSummary: op.previousSummary ?? null },
    },
  };
}

// ─── Arch reducer: SessionClosed ──────────────────────────────────────────────

test('arch: SessionClosed removes per-session arch state but preserves other sessions', () => {
  const state: ArchState = {
    ...initialArchState,
    sessions: {
      '/s/a': { interruptInFlight: true },
      '/s/b': { interruptInFlight: false },
    },
    currentTurnBySession: {
      '/s/a': { requestId: 'req-1', firstMessageId: 'msg-1' },
      '/s/b': { requestId: 'req-2', firstMessageId: 'msg-2' },
    },
  };

  const result = reducer(state, { kind: 'SessionClosed', sessionPath: '/s/a' });

  assert.equal(result.state.sessions['/s/a'], undefined);
  assert.deepEqual(result.state.sessions['/s/b'], { interruptInFlight: false });
  assert.equal(result.state.currentTurnBySession['/s/a'], undefined);
  assert.deepEqual(result.state.currentTurnBySession['/s/b'], {
    requestId: 'req-2',
    firstMessageId: 'msg-2',
  });
  assert.deepEqual(result.effects, []);
});

test('arch: SessionClosed removes pending operations belonging to the closed session', () => {
  const state: ArchState = {
    ...initialArchState,
    pending: {
      'c1': { kind: 'send', sessionPath: '/s/a', localId: 'loc-1', previousSummary: null },
      'c2': { kind: 'edit', sessionPath: '/s/b', localId: 'loc-2', previousSummary: null },
      'c3': { kind: 'send', sessionPath: '/s/a', localId: 'loc-3', previousSummary: null },
    },
  };

  const result = reducer(state, { kind: 'SessionClosed', sessionPath: '/s/a' });

  assert.equal(result.state.pending['c1'], undefined);
  assert.equal(result.state.pending['c3'], undefined);
  assert.deepEqual(result.state.pending['c2'], {
    kind: 'edit',
    sessionPath: '/s/b',
    localId: 'loc-2',
    previousSummary: null,
  });
});

test('arch: SessionClosed on unknown session is a no-op', () => {
  const result = reducer(initialArchState, {
    kind: 'SessionClosed',
    sessionPath: '/nonexistent',
  });
  assert.deepEqual(result.state, initialArchState);
  assert.deepEqual(result.effects, []);
});

// ─── Arch reducer: cross-session isolation ────────────────────────────────────

test('arch: concurrent sends across different sessions do not interfere', () => {
  const state = reducer(initialArchState, {
    kind: 'Command',
    cmd: {
      kind: 'Send',
      corrId: 'c-a',
      sessionPath: '/s/a',
      text: 'text-a',
      inputs: [],
      composedText: 'text-a',
      localId: 'loc-a',
      userParts: [],
      previousSummary: null,
    },
  }).state;

  const result = reducer(state, {
    kind: 'Command',
    cmd: {
      kind: 'Send',
      corrId: 'c-b',
      sessionPath: '/s/b',
      text: 'text-b',
      inputs: [],
      composedText: 'text-b',
      localId: 'loc-b',
      userParts: [],
      previousSummary: null,
    },
  });

  assert.deepEqual(result.state.pending['c-a'], {
    kind: 'send',
    sessionPath: '/s/a',
    localId: 'loc-a',
    previousSummary: null,
  });
  assert.deepEqual(result.state.pending['c-b'], {
    kind: 'send',
    sessionPath: '/s/b',
    localId: 'loc-b',
    previousSummary: null,
  });
});

test('arch: Interrupt on one session does not affect another session', () => {
  const state: ArchState = archStateWithSession('/s/b');

  const result = reducer(state, {
    kind: 'Command',
    cmd: { kind: 'Interrupt', corrId: 'c1', sessionPath: '/s/a' },
  });

  assert.equal(result.state.sessions['/s/a']?.interruptInFlight, true);
  assert.equal(result.state.sessions['/s/b']?.interruptInFlight, false);
});

// ─── Arch reducer: Edit edge cases ────────────────────────────────────────────

test('arch: EditResult for unknown corrId is a no-op', () => {
  const result = reducer(initialArchState, {
    kind: 'EditResult',
    corrId: 'unknown',
    sessionPath: '/s',
    ok: true,
  });
  assert.deepEqual(result.state, initialArchState);
  assert.deepEqual(result.effects, []);
});

// ─── Arch reducer: MessageStarted variations ──────────────────────────────────

test('arch: MessageStarted without modelId still creates turn and emits EnsureAssistantMessage', () => {
  const result = reducer(initialArchState, {
    kind: 'MessageStarted',
    sessionPath: '/s',
    messageId: 'msg-1',
    requestId: 'req-1',
  });

  assert.deepEqual(result.state.currentTurnBySession['/s'], {
    requestId: 'req-1',
    firstMessageId: 'msg-1',
  });
  const ensure = result.effects.find(e => e.kind === 'EnsureAssistantMessage');
  assert.ok(ensure);
  if (ensure?.kind === 'EnsureAssistantMessage') {
    assert.equal(ensure.isAlias, false);
    assert.equal(ensure.modelId, undefined);
    assert.equal(ensure.thinkingLevel, undefined);
  }
});

test('arch: MessageStarted with different requestId starts a new turn', () => {
  const state: ArchState = {
    ...initialArchState,
    currentTurnBySession: {
      '/s': { requestId: 'req-old', firstMessageId: 'msg-old' },
    },
  };

  const result = reducer(state, {
    kind: 'MessageStarted',
    sessionPath: '/s',
    messageId: 'msg-new',
    requestId: 'req-new',
  });

  assert.deepEqual(result.state.currentTurnBySession['/s'], {
    requestId: 'req-new',
    firstMessageId: 'msg-new',
  });
  const ensure = result.effects.find(e => e.kind === 'EnsureAssistantMessage');
  assert.ok(ensure?.kind === 'EnsureAssistantMessage' && ensure.isAlias === false);
});

test('arch: MessageStarted without requestId does not change current turn', () => {
  const state: ArchState = {
    ...initialArchState,
    currentTurnBySession: {
      '/s': { requestId: 'req-1', firstMessageId: 'msg-1' },
    },
  };

  const result = reducer(state, {
    kind: 'MessageStarted',
    sessionPath: '/s',
    messageId: 'msg-2',
    // no requestId
  });

  // currentTurnBySession unchanged because no requestId
  assert.deepEqual(result.state.currentTurnBySession['/s'], {
    requestId: 'req-1',
    firstMessageId: 'msg-1',
  });
});

// ─── Arch reducer: MessageFinished without alias ──────────────────────────────

test('arch: MessageFinished on canonical (non-aliased) ID emits UpsertMessage without canonicalMessageId', () => {
  const message = {
    id: 'direct-msg',
    role: 'assistant' as const,
    createdAt: '',
    markdown: 'content',
    status: 'completed' as const,
  } as any;

  const result = reducer(initialArchState, {
    kind: 'MessageFinished',
    sessionPath: '/s',
    message,
  });

  const effect = result.effects.find(e => e.kind === 'UpsertMessage');
  assert.ok(effect);
  if (effect?.kind === 'UpsertMessage') {
    assert.equal(effect.canonicalMessageId, undefined);
    assert.equal(effect.message.id, 'direct-msg');
  }
});

// ─── Arch reducer: ToolCall with unknown messageId ────────────────────────────

test('arch: ToolCall with unknown messageId still emits UpsertToolCall (no alias)', () => {
  const tc = { id: 'tc-1', name: 'read', input: { path: 'f.txt' }, status: 'running' as const };
  const result = reducer(initialArchState, {
    kind: 'ToolCall',
    sessionPath: '/s',
    messageId: 'unknown-msg',
    toolCall: tc,
  });

  const effect = result.effects.find(e => e.kind === 'UpsertToolCall');
  assert.ok(effect);
  if (effect?.kind === 'UpsertToolCall') {
    assert.equal(effect.messageId, 'unknown-msg');
    assert.deepEqual(effect.toolCall, tc);
  }
});

// ─── Arch reducer: Backend event scheduling consistency ───────────────────────

test('arch: every streaming event also schedules a render', () => {
  const events: Event[] = [
    { kind: 'MessageStarted', sessionPath: '/s', messageId: 'm1', requestId: 'r1' },
    { kind: 'MessageDelta', sessionPath: '/s', messageId: 'm1', delta: 'hi' },
    { kind: 'MessageThinking', sessionPath: '/s', messageId: 'm1', thinking: 'plan' },
    { kind: 'ToolCall', sessionPath: '/s', messageId: 'm1', toolCall: { id: 't1', name: 'bash', input: {}, status: 'running' } },
  ];

  for (const event of events) {
    const result = reducer(initialArchState, event);
    assert.ok(
      result.effects.some(e => e.kind === 'ScheduleRender'),
      `${event.kind} should schedule a render`,
    );
  }
});

// ─── Store: sessions slice edge cases ─────────────────────────────────────────

test('sessions: setSessionSummary upserts (replaces existing, appends new)', () => {
  const s1 = { path: '/a', name: 'A', cwd: '/', modifiedAt: '', messageCount: 0 };
  const s2 = { path: '/b', name: 'B', cwd: '/', modifiedAt: '', messageCount: 0 };
  const s1Updated = { ...s1, name: 'A Updated' };

  let state = sessionsReducer(undefined, { type: '@@init' });
  state = sessionsReducer(state, sessionsActions.setSessionSummary(s1));
  state = sessionsReducer(state, sessionsActions.setSessionSummary(s2));
  state = sessionsReducer(state, sessionsActions.setSessionSummary(s1Updated));

  assert.equal(state.sessions.length, 2);
  assert.equal(state.sessions[0]?.name, 'A Updated');
  assert.equal(state.sessions[1]?.name, 'B');
});

test('sessions: mergeSessionSummary preserves non-placeholder name when incoming is placeholder', () => {
  const existing = {
    path: '/a', name: 'My Session', cwd: '/', modifiedAt: '', messageCount: 0,
    isPlaceholder: false, modelId: 'gpt-4', thinkingLevel: 'high',
  } as any;

  const incoming = {
    path: '/a', name: 'New Session', cwd: '/', modifiedAt: '', messageCount: 2,
    isPlaceholder: true,
  } as any;

  let state = sessionsReducer(undefined, { type: '@@init' });
  state = sessionsReducer(state, sessionsActions.upsertSession(existing));
  state = sessionsReducer(state, sessionsActions.upsertSession(incoming));

  const merged = state.sessions.find(s => s.path === '/a');
  assert.equal(merged?.name, 'My Session');
  assert.equal(merged?.isPlaceholder, false);
  assert.equal(merged?.modelId, 'gpt-4');
  assert.equal(merged?.thinkingLevel, 'high');
});

test('sessions: replaceSessionSummaries preserves open-tab sessions not in incoming list', () => {
  const s1 = { path: '/a', name: 'A', cwd: '/', modifiedAt: '', messageCount: 0 };
  const s2 = { path: '/b', name: 'B', cwd: '/', modifiedAt: '', messageCount: 0 };

  let state = sessionsReducer(undefined, { type: '@@init' });
  state = sessionsReducer(state, sessionsActions.upsertSession(s1));
  state = sessionsReducer(state, sessionsActions.upsertSession(s2));
  state = sessionsReducer(state, sessionsActions.setOpenTabPaths(['/a']));

  const refreshed = sessionsReducer(
    state,
    sessionsActions.replaceSessionSummaries([{ ...s2, name: 'B Updated' }]),
  );

  // /a (open tab) preserved, /b updated
  assert.ok(refreshed.sessions.some(s => s.path === '/a' && s.name === 'A'));
  assert.ok(refreshed.sessions.some(s => s.path === '/b' && s.name === 'B Updated'));
});

test('sessions: replaceSessionSummaries preserves active session when not in list', () => {
  const s1 = { path: '/a', name: 'A', cwd: '/', modifiedAt: '', messageCount: 0 };

  let state = sessionsReducer(undefined, { type: '@@init' });
  state = sessionsReducer(state, sessionsActions.upsertSession(s1));
  state = sessionsReducer(state, sessionsActions.setActiveSessionPath('/a'));

  const refreshed = sessionsReducer(
    state,
    sessionsActions.replaceSessionSummaries([]),
  );

  assert.ok(refreshed.sessions.some(s => s.path === '/a'));
});

test('sessions: markSessionFinishedUnread is idempotent (no duplicates)', () => {
  let state = sessionsReducer(undefined, { type: '@@init' });
  state = sessionsReducer(state, sessionsActions.markSessionFinishedUnread('/a'));
  state = sessionsReducer(state, sessionsActions.markSessionFinishedUnread('/a'));
  state = sessionsReducer(state, sessionsActions.markSessionFinishedUnread('/a'));

  assert.deepEqual(state.unreadFinishedSessionPaths, ['/a']);
});

test('sessions: removeSession cleans all slots (tabs, running, unread, active)', () => {
  let state = sessionsReducer(undefined, { type: '@@init' });
  state = sessionsReducer(state, sessionsActions.upsertSession({ path: '/a', name: 'A', cwd: '/', modifiedAt: '', messageCount: 0 }));
  state = sessionsReducer(state, sessionsActions.setOpenTabPaths(['/a']));
  state = sessionsReducer(state, sessionsActions.setSessionRunning({ sessionPath: '/a', running: true }));
  state = sessionsReducer(state, sessionsActions.markSessionFinishedUnread('/a'));
  state = sessionsReducer(state, sessionsActions.setActiveSessionPath('/a'));

  state = sessionsReducer(state, sessionsActions.removeSession('/a'));

  assert.ok(!state.sessions.some(s => s.path === '/a'));
  assert.ok(!state.openTabPaths.includes('/a'));
  assert.ok(!state.runningSessionPaths.includes('/a'));
  assert.ok(!state.unreadFinishedSessionPaths.includes('/a'));
  assert.equal(state.activeSessionPath, null);
});

test('sessions: setActiveSessionPath(null) does not throw', () => {
  let state = sessionsReducer(undefined, { type: '@@init' });
  state = sessionsReducer(state, sessionsActions.setActiveSessionPath('/a'));
  state = sessionsReducer(state, sessionsActions.setActiveSessionPath(null));

  assert.equal(state.activeSessionPath, null);
});

test('sessions: setOpenTabPaths filters unread finished to only open tabs', () => {
  let state = sessionsReducer(undefined, { type: '@@init' });
  state = sessionsReducer(state, sessionsActions.markSessionFinishedUnread('/a'));
  state = sessionsReducer(state, sessionsActions.markSessionFinishedUnread('/b'));
  state = sessionsReducer(state, sessionsActions.markSessionFinishedUnread('/c'));

  state = sessionsReducer(state, sessionsActions.setOpenTabPaths(['/a', '/c']));

  assert.deepEqual(state.unreadFinishedSessionPaths, ['/a', '/c']);
});

test('sessions: ensureOpenTab is idempotent', () => {
  let state = sessionsReducer(undefined, { type: '@@init' });
  state = sessionsReducer(state, sessionsActions.setOpenTabPaths(['/a']));
  state = sessionsReducer(state, sessionsActions.ensureOpenTab('/a'));
  state = sessionsReducer(state, sessionsActions.ensureOpenTab('/a'));

  assert.deepEqual(state.openTabPaths, ['/a']);
});

test('sessions: insertOpenTabAfter inserts a new path right after the anchor', () => {
  let state = sessionsReducer(undefined, { type: '@@init' });
  state = sessionsReducer(state, sessionsActions.setOpenTabPaths(['/a', '/b', '/c']));

  // Insert after /a
  state = sessionsReducer(state, sessionsActions.insertOpenTabAfter({ afterPath: '/a', newPath: '/a-dup' }));
  assert.deepEqual(state.openTabPaths, ['/a', '/a-dup', '/b', '/c']);

  // Insert after /c (last tab)
  state = sessionsReducer(state, sessionsActions.insertOpenTabAfter({ afterPath: '/c', newPath: '/c-dup' }));
  assert.deepEqual(state.openTabPaths, ['/a', '/a-dup', '/b', '/c', '/c-dup']);

  // Insert after unknown path falls back to appending at the end
  state = sessionsReducer(state, sessionsActions.insertOpenTabAfter({ afterPath: '/missing', newPath: '/end' }));
  assert.deepEqual(state.openTabPaths, ['/a', '/a-dup', '/b', '/c', '/c-dup', '/end']);
});

test('sessions: replaceOpenTabPath also migrates unreadFinishedSessionPaths', () => {
  let state = sessionsReducer(undefined, { type: '@@init' });
  state = sessionsReducer(state, sessionsActions.setOpenTabPaths(['__pending__:1']));
  state = sessionsReducer(state, sessionsActions.markSessionFinishedUnread('__pending__:1'));

  state = sessionsReducer(
    state,
    sessionsActions.replaceOpenTabPath({ oldPath: '__pending__:1', newPath: '/real' }),
  );

  assert.deepEqual(state.openTabPaths, ['/real']);
  assert.deepEqual(state.unreadFinishedSessionPaths, ['/real']);
});

test('sessions: clearUnreadFinishedSessions empties the list', () => {
  let state = sessionsReducer(undefined, { type: '@@init' });
  state = sessionsReducer(state, sessionsActions.markSessionFinishedUnread('/a'));
  state = sessionsReducer(state, sessionsActions.markSessionFinishedUnread('/b'));
  state = sessionsReducer(state, sessionsActions.clearUnreadFinishedSessions());

  assert.deepEqual(state.unreadFinishedSessionPaths, []);
});

test('sessions: setWorkspaceCwd stores and clears workspace path', () => {
  let state = sessionsReducer(undefined, { type: '@@init' });
  state = sessionsReducer(state, sessionsActions.setWorkspaceCwd('/my/project'));
  assert.equal(state.workspaceCwd, '/my/project');

  state = sessionsReducer(state, sessionsActions.setWorkspaceCwd(null));
  assert.equal(state.workspaceCwd, null);
});

// ─── Store: transcript slice edge cases ───────────────────────────────────────

test('transcript: appendDelta is a no-op on completed messages', () => {
  let state = transcriptReducer(undefined, { type: '@@init' });
  state = transcriptReducer(state, transcriptActions.setTranscript({
    sessionPath: '/s',
    transcript: [{
      id: 'msg-done',
      role: 'assistant' as const,
      createdAt: '',
      markdown: 'already done',
      status: 'completed' as const,
    }],
  }));

  state = transcriptReducer(state, transcriptActions.appendDelta({
    sessionPath: '/s', messageId: 'msg-done', delta: 'SHOULD NOT APPEAR',
  }));

  const msg = state.bySession['/s']?.find(m => m.id === 'msg-done');
  assert.equal(msg?.markdown, 'already done');
});

test('transcript: appendDelta is a no-op on interrupted messages', () => {
  let state = transcriptReducer(undefined, { type: '@@init' });
  state = transcriptReducer(state, transcriptActions.setTranscript({
    sessionPath: '/s',
    transcript: [{
      id: 'msg-int',
      role: 'assistant' as const,
      createdAt: '',
      markdown: 'interrupted mid',
      status: 'interrupted' as const,
    }],
  }));

  state = transcriptReducer(state, transcriptActions.appendDelta({
    sessionPath: '/s', messageId: 'msg-int', delta: 'SHOULD NOT APPEND',
  }));

  const msg = state.bySession['/s']?.find(m => m.id === 'msg-int');
  assert.equal(msg?.markdown, 'interrupted mid');
});

test('transcript: appendThinking is a no-op on completed messages', () => {
  let state = transcriptReducer(undefined, { type: '@@init' });
  state = transcriptReducer(state, transcriptActions.setTranscript({
    sessionPath: '/s',
    transcript: [{
      id: 'msg-done',
      role: 'assistant' as const,
      createdAt: '',
      markdown: '',
      status: 'completed' as const,
      thinking: 'old thinking',
    }],
  }));

  state = transcriptReducer(state, transcriptActions.appendThinking({
    sessionPath: '/s', messageId: 'msg-done', thinking: 'SHOULD NOT APPEND',
  }));

  const msg = state.bySession['/s']?.find(m => m.id === 'msg-done');
  assert.equal(msg?.thinking, 'old thinking');
});

test('transcript: upsertToolCall is a no-op when target message does not exist', () => {
  const state = transcriptReducer(undefined, { type: '@@init' });
  const next = transcriptReducer(state, transcriptActions.upsertToolCall({
    sessionPath: '/s',
    messageId: 'nonexistent',
    toolCall: { id: 't1', name: 'bash', input: {}, status: 'running' },
  }));
  assert.deepEqual(next, state);
});

test('transcript: setMessageError attaches to most recent assistant message when no streaming', () => {
  let state = transcriptReducer(undefined, { type: '@@init' });
  state = transcriptReducer(state, transcriptActions.setTranscript({
    sessionPath: '/s',
    transcript: [
      {
        id: 'assistant-old',
        role: 'assistant' as const,
        createdAt: '2026-01-01T00:00:00Z',
        markdown: 'old',
        status: 'completed' as const,
      },
      {
        id: 'assistant-recent',
        role: 'assistant' as const,
        createdAt: '2026-01-02T00:00:00Z',
        markdown: 'recent',
        status: 'completed' as const,
      },
      {
        id: 'user-1',
        role: 'user' as const,
        createdAt: '2026-01-03T00:00:00Z',
        markdown: 'user',
        status: 'completed' as const,
      },
    ],
  }));

  state = transcriptReducer(state, transcriptActions.setMessageError({
    sessionPath: '/s', errorDetail: 'connection lost',
  }));

  // Most recent assistant is assistant-recent (not assistant-old)
  const recent = state.bySession['/s']?.find(m => m.id === 'assistant-recent');
  assert.equal(recent?.status, 'error');
  assert.equal(recent?.errorDetail, 'connection lost');
});

test('transcript: setMessageError attaches to streaming assistant even if not last', () => {
  let state = transcriptReducer(undefined, { type: '@@init' });
  state = transcriptReducer(state, transcriptActions.ensureAssistantMessage({
    sessionPath: '/s', messageId: 'streaming-msg',
  }));
  state = transcriptReducer(state, transcriptActions.appendLocalUserMessage({
    sessionPath: '/s', id: 'user-last', text: 'after',
  }));

  state = transcriptReducer(state, transcriptActions.setMessageError({
    sessionPath: '/s', errorDetail: 'error!',
  }));

  const streaming = state.bySession['/s']?.find(m => m.id === 'streaming-msg');
  assert.equal(streaming?.status, 'error');
  assert.equal(streaming?.errorDetail, 'error!');
});

test('transcript: setMessageError is a no-op for unknown sessions', () => {
  const state = transcriptReducer(undefined, { type: '@@init' });
  const next = transcriptReducer(state, transcriptActions.setMessageError({
    sessionPath: '/nonexistent', errorDetail: 'oops',
  }));
  assert.deepEqual(next, state);
});

test('transcript: upsertMessage preserves errorDetail set by setMessageError if replacement lacks one', () => {
  let state = transcriptReducer(undefined, { type: '@@init' });
  state = transcriptReducer(state, transcriptActions.ensureAssistantMessage({
    sessionPath: '/s', messageId: 'err-msg',
  }));
  state = transcriptReducer(state, transcriptActions.setMessageError({
    sessionPath: '/s', errorDetail: 'original error',
  }));

  state = transcriptReducer(state, transcriptActions.upsertMessage({
    sessionPath: '/s',
    message: {
      id: 'err-msg',
      role: 'assistant' as const,
      createdAt: '',
      markdown: 'partial',
      status: 'error' as const,
    },
  }));

  const msg = state.bySession['/s']?.find(m => m.id === 'err-msg');
  assert.equal(msg?.status, 'error');
  assert.equal(msg?.errorDetail, 'original error');
});

test('transcript: clearSessionState and clearTranscript behave identically', () => {
  let state1 = transcriptReducer(undefined, { type: '@@init' });
  state1 = transcriptReducer(state1, transcriptActions.ensureAssistantMessage({
    sessionPath: '/s', messageId: 'm1',
  }));
  state1 = transcriptReducer(state1, transcriptActions.clearTranscript('/s'));

  let state2 = transcriptReducer(undefined, { type: '@@init' });
  state2 = transcriptReducer(state2, transcriptActions.ensureAssistantMessage({
    sessionPath: '/s', messageId: 'm1',
  }));
  state2 = transcriptReducer(state2, transcriptActions.clearSessionState('/s'));

  assert.deepEqual(state1, state2);
  assert.equal(state1.bySession['/s'], undefined);
  assert.equal(state1.windowBySession['/s'], undefined);
  assert.equal(state1.systemPromptsBySession['/s'], undefined);
});

test('transcript: replaceSessionPath merges transcripts into the target', () => {
  let state = transcriptReducer(undefined, { type: '@@init' });
  state = transcriptReducer(state, transcriptActions.setTranscript({
    sessionPath: '/new',
    transcript: [{
      id: 'new-msg',
      role: 'assistant' as const,
      createdAt: '',
      markdown: 'existing',
      status: 'completed' as const,
    }],
  }));
  state = transcriptReducer(state, transcriptActions.setTranscript({
    sessionPath: '/old',
    transcript: [{
      id: 'old-msg',
      role: 'user' as const,
      createdAt: '',
      markdown: 'from old',
      status: 'completed' as const,
    }],
  }));

  state = transcriptReducer(state, transcriptActions.replaceSessionPath({
    oldPath: '/old', newPath: '/new',
  }));

  assert.equal(state.bySession['/old'], undefined);
  assert.equal(state.bySession['/new']?.length, 2);
  assert.ok(state.bySession['/new']?.find(m => m.id === 'old-msg'));
  assert.ok(state.bySession['/new']?.find(m => m.id === 'new-msg'));
});

test('transcript: appendLocalUserMessage with userParts stores structured parts', () => {
  let state = transcriptReducer(undefined, { type: '@@init' });
  state = transcriptReducer(state, transcriptActions.appendLocalUserMessage({
    sessionPath: '/s',
    id: 'user-img',
    text: 'See image',
    userParts: [
      { kind: 'text' as const, text: 'See image' },
      { kind: 'image' as const, mimeType: 'image/png', dataBase64: 'ZmFrZQ==', name: 'img.png', width: 100, height: 50 },
    ],
  }));

  const msg = state.bySession['/s']?.find(m => m.id === 'user-img');
  assert.ok(msg);
  assert.equal(msg?.role, 'user');
  assert.deepEqual(msg?.userParts?.length, 2);
});

test('transcript: upsertMessage for new user message sets hasUserMessages on window', () => {
  let state = transcriptReducer(undefined, { type: '@@init' });
  state = transcriptReducer(state, transcriptActions.upsertMessage({
    sessionPath: '/s',
    message: {
      id: 'user-new',
      role: 'user' as const,
      createdAt: '',
      markdown: 'hello',
      status: 'completed' as const,
    },
  }));

  assert.equal(state.windowBySession['/s']?.hasUserMessages, true);
});

// ─── Store: UI slice edge cases ───────────────────────────────────────────────

test('ui: setPrefs deep-merges extensionToggles without clobbering existing keys', () => {
  let state = uiReducer(undefined, { type: '@@init' });
  state = uiReducer(state, uiActions.setPrefs({
    extensionToggles: { 'subagent': true, 'skill-pruner': false },
  }));
  state = uiReducer(state, uiActions.setPrefs({
    extensionToggles: { 'cwd-skills': true },
  }));

  assert.equal(state.prefs.extensionToggles['subagent'], true);
  assert.equal(state.prefs.extensionToggles['skill-pruner'], false);
  assert.equal(state.prefs.extensionToggles['cwd-skills'], true);
});

test('ui: setPrefs deep-merges providerToggles without clobbering existing keys', () => {
  let state = uiReducer(undefined, { type: '@@init' });
  state = uiReducer(state, uiActions.setPrefs({
    providerToggles: { 'openai': true },
  }));
  state = uiReducer(state, uiActions.setPrefs({
    providerToggles: { 'anthropic': false },
  }));

  assert.equal(state.prefs.providerToggles['openai'], true);
  assert.equal(state.prefs.providerToggles['anthropic'], false);
});

test('ui: setBackendReady transitions from false to true', () => {
  let state = uiReducer(undefined, { type: '@@init' });
  assert.equal(state.backendReady, false);

  state = uiReducer(state, uiActions.setBackendReady(true));
  assert.equal(state.backendReady, true);

  state = uiReducer(state, uiActions.setBackendReady(false));
  assert.equal(state.backendReady, false);
});

test('ui: setEditingMessageId tracks the currently edited message', () => {
  let state = uiReducer(undefined, { type: '@@init' });
  assert.equal(state.editingMessageId, null);

  state = uiReducer(state, uiActions.setEditingMessageId('msg-1'));
  assert.equal(state.editingMessageId, 'msg-1');

  state = uiReducer(state, uiActions.setEditingMessageId(null));
  assert.equal(state.editingMessageId, null);
});

test('ui: setShowOutcomeDialog toggles the recording dialog visibility', () => {
  let state = uiReducer(undefined, { type: '@@init' });
  assert.equal(state.showOutcomeDialog, false);

  state = uiReducer(state, uiActions.setShowOutcomeDialog(true));
  assert.equal(state.showOutcomeDialog, true);
});

test('ui: setPendingExtensionUIRequest stores and clears extension UI requests', () => {
  const request = { id: 'req-1', extensionId: 'test-ext', title: 'Confirm', message: 'Proceed?', options: [{ label: 'OK', value: 'ok' }] };

  let state = uiReducer(undefined, { type: '@@init' });
  state = uiReducer(state, uiActions.setPendingExtensionUIRequest(request));
  assert.deepEqual(state.pendingExtensionUIRequest, request);

  state = uiReducer(state, uiActions.setPendingExtensionUIRequest(null));
  assert.equal(state.pendingExtensionUIRequest, null);
});

test('ui: setAvailableExtensions stores extension metadata', () => {
  const extensions = [
    { id: 'subagent', name: 'Subagent', version: '1.0.0' },
    { id: 'cwd-skills', name: 'CWD Skills', version: '2.0.0' },
  ];

  let state = uiReducer(undefined, { type: '@@init' });
  state = uiReducer(state, uiActions.setAvailableExtensions(extensions));

  assert.deepEqual(state.availableExtensions, extensions);
});

// ─── Store: settings slice edge cases ─────────────────────────────────────────

test('settings: setPruningSettings persists custom pruning configuration', () => {
  let state = settingsReducer(undefined, { type: '@@init' });
  state = settingsReducer(state, settingsActions.setPruningSettings({
    mode: 'custom',
    skillCeiling: 3,
    toolCeiling: 8,
    skillAlwaysKeep: ['always-skill'],
    toolAlwaysKeep: ['always-tool'],
    model: 'gpt-4o-mini',
    provider: 'openai',
    thinkingLevel: 'low',
  }));

  assert.equal(state.pruningSettings.mode, 'custom');
  assert.equal(state.pruningSettings.skillCeiling, 3);
  assert.equal(state.pruningSettings.toolCeiling, 8);
  assert.deepEqual(state.pruningSettings.skillAlwaysKeep, ['always-skill']);
  assert.deepEqual(state.pruningSettings.toolAlwaysKeep, ['always-tool']);
});

test('settings: clearAvailableModels removes the session entry', () => {
  let state = settingsReducer(undefined, { type: '@@init' });
  state = settingsReducer(state, settingsActions.setAvailableModels({
    sessionPath: '/s',
    availableModels: [{ id: 'gpt-4o', name: 'GPT-4o', provider: 'openai', reasoning: false, inputKinds: ['text'] }],
  }));
  assert.ok(state.availableModelsBySession['/s']);

  state = settingsReducer(state, settingsActions.clearAvailableModels('/s'));
  assert.equal(state.availableModelsBySession['/s'], undefined);
});

test('settings: clearContextUsage removes the session entry', () => {
  let state = settingsReducer(undefined, { type: '@@init' });
  state = settingsReducer(state, settingsActions.setContextUsage({
    sessionPath: '/s',
    contextUsage: { tokens: 5000, contextWindow: 100000, percent: 5 },
  }));
  assert.ok(state.contextUsageBySession['/s']);

  state = settingsReducer(state, settingsActions.clearContextUsage('/s'));
  assert.equal(state.contextUsageBySession['/s'], undefined);
});

test('settings: setAvailableModels does not replace non-empty models with empty array', () => {
  const models = [{ id: 'gpt-4o', name: 'GPT-4o', provider: 'openai', reasoning: false, inputKinds: ['text'] as const }];

  let state = settingsReducer(undefined, { type: '@@init' });
  state = settingsReducer(state, settingsActions.setAvailableModels({
    sessionPath: '/s', availableModels: models,
  }));
  state = settingsReducer(state, settingsActions.setAvailableModels({
    sessionPath: '/s', availableModels: [],
  }));

  // Should preserve existing models (empty refresh is ignored)
  assert.deepEqual(state.availableModelsBySession['/s'], models);
});

test('settings: setAvailableModels replaces empty with populated models', () => {
  const models = [{ id: 'gpt-4o', name: 'GPT-4o', provider: 'openai', reasoning: false, inputKinds: ['text'] as const }];

  let state = settingsReducer(undefined, { type: '@@init' });
  // No models for session yet
  state = settingsReducer(state, settingsActions.setAvailableModels({
    sessionPath: '/s', availableModels: models,
  }));

  assert.deepEqual(state.availableModelsBySession['/s'], models);
});

test('settings: setModelAndAvailable with empty availableModels preserves the non-empty existing', () => {
  const models = [{ id: 'gpt-4o', name: 'GPT-4o', provider: 'openai', reasoning: false, inputKinds: ['text'] as const }];

  let state = settingsReducer(undefined, { type: '@@init' });
  state = settingsReducer(state, settingsActions.setAvailableModels({
    sessionPath: '/s', availableModels: models,
  }));
  state = settingsReducer(state, settingsActions.setModelAndAvailable({
    sessionPath: '/s',
    modelSettings: { defaultModel: 'claude', defaultThinkingLevel: 'medium' },
    availableModels: [],
  }));

  assert.equal(state.modelSettings?.defaultModel, 'claude');
  assert.deepEqual(state.availableModelsBySession['/s'], models);
});

// ─── Store: sessionState slice edge cases ─────────────────────────────────────

test('sessionState: setPendingComposerInputs overwrites the list for a session', () => {
  let state = sessionStateReducer(undefined, { type: '@@init' });
  state = sessionStateReducer(state, sessionStateActions.addPendingComposerInput({
    sessionPath: '/s',
    input: { id: 'i1', kind: 'filesystemPathRef', path: '/a.ts', name: 'a.ts', source: 'picker' },
  }));

  state = sessionStateReducer(state, sessionStateActions.setPendingComposerInputs({
    sessionPath: '/s',
    inputs: [
      { id: 'i2', kind: 'filesystemPathRef', path: '/b.ts', name: 'b.ts', source: 'drop' },
    ],
  }));

  assert.deepEqual(state.pendingComposerInputsBySession['/s'], [
    { id: 'i2', kind: 'filesystemPathRef', path: '/b.ts', name: 'b.ts', source: 'drop' },
  ]);
});

test('sessionState: replaceSessionPath is a no-op when oldPath equals newPath', () => {
  const initial = sessionStateReducer(undefined, { type: '@@init' });
  const next = sessionStateReducer(initial, sessionStateActions.replaceSessionPath({
    oldPath: '/s', newPath: '/s',
  }));
  assert.deepEqual(next, initial);
});

// ─── selectViewState consistency ──────────────────────────────────────────────

test('selectViewState: workspaceCwd is null when not set', () => {
  const { createAppStore } = require('../src/host/store') as typeof import('../src/host/store');
  const store = createAppStore();
  const vs = selectViewState(store.getState());
  assert.equal(vs.workspaceCwd, null);
});

test('selectViewState: workspaceCwd propagates when set', () => {
  const { store } = require('../src/host/store') as typeof import('../src/host/store');
  store.dispatch(sessionsActions.setWorkspaceCwd('/project'));
  const vs = selectViewState(store.getState());
  assert.equal(vs.workspaceCwd, '/project');
});

test('selectViewState: busy is false when no active session even if sessions are running', () => {
  const { store } = require('../src/host/store') as typeof import('../src/host/store');
  store.dispatch(sessionsActions.setSessionRunning({ sessionPath: '/s', running: true }));
  store.dispatch(sessionsActions.clearActiveSession());

  const vs = selectViewState(store.getState());
  assert.equal(vs.busy, false);
});

test('selectViewState: systemPrompts is empty when no active session', () => {
  const { createAppStore } = require('../src/host/store') as typeof import('../src/host/store');
  const store = createAppStore();
  const vs = selectViewState(store.getState());
  assert.deepEqual(vs.systemPrompts, []);
});

test('selectViewState: fileChanges returns empty when no active session', () => {
  const { createAppStore } = require('../src/host/store') as typeof import('../src/host/store');
  const store = createAppStore();
  const vs = selectViewState(store.getState());
  assert.deepEqual(vs.fileChanges, []);
});

test('selectViewState: editingMessageId, showOutcomeDialog, pendingExtensionUIRequest are null/false initially', () => {
  const { createAppStore } = require('../src/host/store') as typeof import('../src/host/store');
  const store = createAppStore();
  const vs = selectViewState(store.getState());
  assert.equal(vs.editingMessageId, null);
  assert.equal(vs.showOutcomeDialog, false);
  assert.equal(vs.pendingExtensionUIRequest, null);
});

test('selectViewState: availableExtensions propagates from store', () => {
  const { store } = require('../src/host/store') as typeof import('../src/host/store');
  const extensions = [{ id: 'ext1', name: 'Ext 1', version: '1.0.0' }];
  store.dispatch(uiActions.setAvailableExtensions(extensions));

  const vs = selectViewState(store.getState());
  assert.deepEqual(vs.availableExtensions, extensions);
});

test('selectViewState: pruningResult is null when showPruningMessages is false', () => {
  const { store } = require('../src/host/store') as typeof import('../src/host/store');
  store.dispatch(uiActions.setPrefs({ showPruningMessages: false }));
  store.dispatch(sessionsActions.setActiveSession({ path: '/s', name: 'S', cwd: '/', modifiedAt: '', messageCount: 0 }));
  store.dispatch(transcriptActions.setTranscript({
    sessionPath: '/s',
    transcript: [{
      id: 'prune-msg',
      role: 'assistant' as const,
      createdAt: '',
      markdown: '',
      status: 'completed' as const,
      customType: 'pruning-result' as const,
      customDetails: {
        includedSkills: ['skill-a'],
        excludedSkills: ['skill-b'],
        includedTools: ['tool-1', 'tool-2'],
        excludedTools: ['tool-3'],
        skillTokensSaved: 100,
        toolTokensSaved: 50,
      },
    }],
  }));

  const vs = selectViewState(store.getState());
  assert.equal(vs.pruningResult, null);
});

test('selectViewState: pruningResult is derived when showPruningMessages is enabled', () => {
  const { store } = require('../src/host/store') as typeof import('../src/host/store');
  store.dispatch(uiActions.setPrefs({ showPruningMessages: true }));
  store.dispatch(sessionsActions.setActiveSession({ path: '/s', name: 'S', cwd: '/', modifiedAt: '', messageCount: 0 }));
  store.dispatch(transcriptActions.setTranscript({
    sessionPath: '/s',
    transcript: [{
      id: 'prune-msg',
      role: 'assistant' as const,
      createdAt: '',
      markdown: '',
      status: 'completed' as const,
      customType: 'pruning-result' as const,
      customDetails: {
        includedSkills: ['skill-a'],
        excludedSkills: ['skill-b'],
        includedTools: ['tool-1', 'tool-2'],
        excludedTools: ['tool-3'],
        skillTokensSaved: 100,
        toolTokensSaved: 50,
      },
    }],
  }));

  const vs = selectViewState(store.getState());
  assert.ok(vs.pruningResult);
  assert.equal(vs.pruningResult?.skillsKept, 1);
  assert.equal(vs.pruningResult?.skillsTotal, 2);
  assert.equal(vs.pruningResult?.toolsKept, 2);
  assert.equal(vs.pruningResult?.toolsTotal, 3);
  assert.equal(vs.pruningResult?.tokensSaved, 150);
  assert.equal(vs.pruningResult?.hasSkillPruning, true);
  assert.equal(vs.pruningResult?.hasToolPruning, true);
});

test('selectViewState: contextUsage is null when no active session', () => {
  const { createAppStore } = require('../src/host/store') as typeof import('../src/host/store');
  const store = createAppStore();
  const vs = selectViewState(store.getState());
  assert.equal(vs.contextUsage, null);
});

test('selectViewState: multi-session isolation — transcript for one session does not leak to another', () => {
  const { createAppStore } = require('../src/host/store') as typeof import('../src/host/store');
  const store = createAppStore();

  store.dispatch(transcriptActions.ensureAssistantMessage({ sessionPath: '/a', messageId: 'msg-a' }));
  store.dispatch(transcriptActions.ensureAssistantMessage({ sessionPath: '/b', messageId: 'msg-b' }));

  // Active session is /a
  store.dispatch(sessionsActions.setActiveSession({ path: '/a', name: 'A', cwd: '/', modifiedAt: '', messageCount: 0 }));
  let vs = selectViewState(store.getState());
  assert.equal(vs.transcript.length, 1);
  assert.equal(vs.transcript[0]?.id, 'msg-a');

  // Switch to /b
  store.dispatch(sessionsActions.setActiveSession({ path: '/b', name: 'B', cwd: '/', modifiedAt: '', messageCount: 0 }));
  vs = selectViewState(store.getState());
  assert.equal(vs.transcript.length, 1);
  assert.equal(vs.transcript[0]?.id, 'msg-b');
});

test('selectViewState: availableModels is session-scoped', () => {
  const { createAppStore } = require('../src/host/store') as typeof import('../src/host/store');
  const store = createAppStore();
  const modelsA = [{ id: 'gpt-4o', name: 'GPT-4o', provider: 'openai', reasoning: false, inputKinds: ['text'] as const }];
  const modelsB = [{ id: 'claude', name: 'Claude', provider: 'anthropic', reasoning: true, inputKinds: ['text'] as const }];

  store.dispatch(settingsActions.setAvailableModels({ sessionPath: '/a', availableModels: modelsA }));
  store.dispatch(settingsActions.setAvailableModels({ sessionPath: '/b', availableModels: modelsB }));

  store.dispatch(sessionsActions.setActiveSession({ path: '/a', name: 'A', cwd: '/', modifiedAt: '', messageCount: 0 }));
  assert.deepEqual(selectViewState(store.getState()).availableModels, modelsA);

  store.dispatch(sessionsActions.setActiveSession({ path: '/b', name: 'B', cwd: '/', modifiedAt: '', messageCount: 0 }));
  assert.deepEqual(selectViewState(store.getState()).availableModels, modelsB);
});

test('selectViewState exposes session-derived pruning catalog as enum options', () => {
  const store = createAppStore();
  const sessionPath = '/a';

  store.dispatch(sessionsActions.replaceSessionSummaries([{ path: sessionPath, name: 'A', cwd: '/', modifiedAt: '', messageCount: 0 }]));
  store.dispatch(sessionsActions.setActiveSession({ path: sessionPath, name: 'A', cwd: '/', modifiedAt: '', messageCount: 0 }));
  store.dispatch(sessionStateActions.setAnalyticsFactors({
    sessionPath,
    factors: {
      promptFamily: 'harness+skills',
      promptHash: 'prompt-hash',
      harnessPromptHash: 'harness-hash',
      customPromptHash: null,
      appendSystemPromptHash: null,
      promptGuidelineHashes: [],
      contextFiles: [],
      selectedToolIds: ['read', 'bash', 'read', 'subagent'],
      toolSnippetHashes: [],
      toolSetHash: 'tool-set-hash',
      skills: [
        {
          name: 'debugging',
          contentHash: 'content-a',
          sourceHash: 'source-a',
          disableModelInvocation: false,
          lastModifiedAt: null,
        },
        {
          name: 'hidden-skill',
          contentHash: 'content-b',
          sourceHash: 'source-b',
          disableModelInvocation: true,
          lastModifiedAt: null,
        },
        {
          name: 'analysis',
          contentHash: 'content-c',
          sourceHash: 'source-c',
          disableModelInvocation: false,
          lastModifiedAt: null,
        },
      ],
      skillSetHash: 'skill-set-hash',
      activeExtensions: ['skill-pruner'],
    },
  }));

  assert.deepEqual(selectViewState(store.getState()).pruningCatalog, {
    skills: ['analysis', 'debugging'],
    tools: ['bash', 'read', 'subagent'],
  });
});

// ─── ViewState: full snapshot invariant ───────────────────────────────────────

test('ViewState: all fields are present in initial state', () => {
  const { createAppStore } = require('../src/host/store') as typeof import('../src/host/store');
  const store = createAppStore();
  const vs = selectViewState(store.getState());

  // Spot-check all top-level fields are present (not undefined)
  const requiredKeys = [
    'sessions', 'openTabPaths', 'runningSessionPaths', 'unreadFinishedSessionPaths',
    'activeSession', 'transcript', 'transcriptWindow', 'transcriptLoaded', 'pendingComposerInputs',
    'activeRunSummary', 'runSummariesBySession', 'busy', 'notice', 'backendReady',
    'workspaceCwd', 'systemPrompts', 'modelSettings', 'availableModels', 'contextUsage',
    'prefs', 'fileChanges', 'availableExtensions', 'pruningResult', 'pruningSettings',
    'pruningCatalog', 'editingMessageId', 'showOutcomeDialog', 'pendingExtensionUIRequest',
  ];

  for (const key of requiredKeys) {
    assert.ok(
      key in vs,
      `ViewState missing required field: ${key}`,
    );
  }

  // Value sanity checks
  assert.deepEqual(vs.sessions, []);
  assert.deepEqual(vs.openTabPaths, []);
  assert.deepEqual(vs.runningSessionPaths, []);
  assert.equal(vs.activeSession, null);
  assert.deepEqual(vs.transcript, []);
  assert.equal(vs.transcriptLoaded, false);
  assert.equal(vs.busy, false);
  assert.equal(vs.notice, null);
  assert.equal(vs.backendReady, false);
  assert.equal(vs.workspaceCwd, null);
  assert.equal(vs.modelSettings, null);
  assert.deepEqual(vs.pruningCatalog, { skills: [], tools: [] });
  assert.equal(vs.contextUsage, null);
});

// ─── Chat prefs menu invariant ────────────────────────────────────────────────

test('chatPrefs: menu sections expose all toggleable transcript prefs', () => {
  const transcriptSection = CHAT_PREF_MENU_SECTIONS.find(s => s.id === 'transcript');
  assert.ok(transcriptSection);
  assert.deepEqual(
    transcriptSection?.items.map(i => i.key),
    ['autoExpandReasoning', 'autoExpandToolCalls', 'autoExpandSubagentCalls'],
  );
});

// ─── reducer purity checks ────────────────────────────────────────────────────

test('arch reducer: pure — does not mutate input state', () => {
  const state: ArchState = {
    ...initialArchState,
    sessions: { '/s': { interruptInFlight: false } },
    pending: { 'c1': { kind: 'send', sessionPath: '/s', localId: 'loc', previousSummary: null } },
  };

  const copy = JSON.parse(JSON.stringify(state));

  reducer(state, {
    kind: 'Command',
    cmd: { kind: 'Interrupt', corrId: 'c2', sessionPath: '/s' },
  });

  assert.deepEqual(state, copy);
});

test('arch reducer: pure — returns new state references', () => {
  const result = reducer(initialArchState, {
    kind: 'Command',
    cmd: { kind: 'Interrupt', corrId: 'c1', sessionPath: '/s' },
  });

  assert.notStrictEqual(result.state, initialArchState);
  assert.notStrictEqual(result.state.sessions, initialArchState.sessions);
});
