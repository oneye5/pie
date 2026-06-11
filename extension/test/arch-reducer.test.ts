import test from 'node:test';
import assert from 'node:assert/strict';

import { reducer, initialArchState, type ArchState } from '../src/host/core/reducer';
import type { Event } from '../src/host/core/events';
import type { ChatMessage } from '../src/shared/protocol';

test('reducer: initial state has empty pending ops and sessions records', () => {
  assert.deepEqual(initialArchState.pending.ops, {});
  assert.deepEqual(initialArchState.sessions.sessions, []);
  assert.deepEqual(initialArchState.sessions.interruptInFlightBySession, {});
});

test('reducer: unhandled event returns unchanged state with no effects', () => {
  const event: Event = {
    kind: 'SendResult',
    corrId: 'c1',
    sessionPath: '/a',
    ok: true,
  };

  const result = reducer(initialArchState, event);

  assert.deepEqual(result.state, initialArchState);
  assert.deepEqual(result.effects, []);
});

test('reducer: SessionListChanged preserves summaries for open active tabs missing from payload', () => {
  const existingSummary = {
    path: '/session/a',
    name: 'New Session',
    cwd: '/workspace',
    modifiedAt: new Date().toISOString(),
    messageCount: 0,
    isPlaceholder: true,
  };

  const state: ArchState = {
    ...initialArchState,
    sessions: {
      ...initialArchState.sessions,
      sessions: [existingSummary],
      openTabPaths: ['/session/a'],
      activeSessionPath: '/session/a',
    },
  };

  const event: Event = {
    kind: 'SessionListChanged',
    sessionSummaries: [],
  };

  const result = reducer(state, event);

  assert.equal(result.state.sessions.sessions.length, 1);
  assert.equal(result.state.sessions.sessions[0]?.path, '/session/a');
  assert.equal(result.state.sessions.activeSessionPath, '/session/a');
});

test('reducer: Interrupt command sets interruptInFlight and returns InterruptRpc effect', () => {
  const event: Event = {
    kind: 'Command',
    cmd: { kind: 'Interrupt', corrId: 'c1', sessionPath: '/session/a' },
  };

  const result = reducer(initialArchState, event);

  assert.equal(result.state.sessions.interruptInFlightBySession['/session/a'], true);
  assert.equal(result.effects.length, 1);
  assert.deepEqual(result.effects[0], {
    kind: 'InterruptRpc',
    corrId: 'c1',
    sessionPath: '/session/a',
  });
});

test('reducer: Interrupt does not affect other sessions', () => {
  const stateWithB: ArchState = {
    ...initialArchState,
    sessions: {
      ...initialArchState.sessions,
      interruptInFlightBySession: { '/b': false },
    },
  };

  const event: Event = {
    kind: 'Command',
    cmd: { kind: 'Interrupt', corrId: 'c2', sessionPath: '/a' },
  };

  const result = reducer(stateWithB, event);

  assert.equal(result.state.sessions.interruptInFlightBySession['/a'], true);
  assert.equal(result.state.sessions.interruptInFlightBySession['/b'], false);
});

test('reducer: InterruptResult{ok:true} clears interruptInFlight and sets running=false directly', () => {
  const state: ArchState = {
    ...initialArchState,
    sessions: {
      ...initialArchState.sessions,
      runningSessionPaths: ['/a'],
      interruptInFlightBySession: { '/a': true },
    },
  };

  const event: Event = {
    kind: 'InterruptResult',
    corrId: 'c1',
    sessionPath: '/a',
    ok: true,
  };

  const result = reducer(state, event);

  assert.equal(result.state.sessions.interruptInFlightBySession['/a'], false);
  // Watchdog: running=false set directly in state
  assert.ok(!result.state.sessions.runningSessionPaths.includes('/a'), 'running should be cleared for /a');
  // No SyncEffect — running state is mutated directly
  assert.equal(result.effects.length, 0);
});

test('reducer: InterruptResult{ok:false} clears flag and produces Log effect', () => {
  const state: ArchState = {
    ...initialArchState,
    sessions: {
      ...initialArchState.sessions,
      interruptInFlightBySession: { '/a': true },
    },
  };

  const event: Event = {
    kind: 'InterruptResult',
    corrId: 'c1',
    sessionPath: '/a',
    ok: false,
    error: 'connection lost',
  };

  const result = reducer(state, event);

  assert.equal(result.state.sessions.interruptInFlightBySession['/a'], false);
  assert.equal(result.effects.length, 1);
  assert.equal(result.effects[0]?.kind, 'Log');
  if (result.effects[0]?.kind === 'Log') {
    assert.equal(result.effects[0].level, 'error');
    assert.match(result.effects[0].message, /Interrupt failed/);
    assert.deepEqual(result.effects[0].data, { error: 'connection lost' });
  }
});

test('reducer: non-Interrupt Command passes through unchanged', () => {
  const event: Event = {
    kind: 'Command',
    cmd: { kind: 'Send', corrId: 'c1', sessionPath: '/a', text: 'hello', inputs: [], composedText: 'hello', localId: 'local:1', previousSummary: null },
  };

  // Send is now handled by the reducer (Phase 4), so it should NOT pass through unchanged.
  const result = reducer(initialArchState, event);
  assert.ok(result.effects.length > 0, 'Send should produce effects');
});

// ─── Phase 4: Send ──────────────────────────────────────────────────────────

test('reducer: Send command inserts optimistic message and produces SendRpc', () => {
  const event: Event = {
    kind: 'Command',
    cmd: {
      kind: 'Send', corrId: 'c-send', sessionPath: '/s',
      text: 'raw', inputs: [], composedText: 'composed', localId: 'loc-1',
      userParts: [{ kind: 'text', text: 'raw' }], previousSummary: null,
    },
  };

  const result = reducer(initialArchState, event);

  // Pending entry recorded.
  assert.deepEqual(result.state.pending.ops['c-send'], {
    kind: 'send',
    sessionPath: '/s',
    localId: 'loc-1',
    previousSummary: null,
  });

  // Optimistic user message inserted in transcript.
  const transcript = result.state.transcript.bySession['/s'];
  assert.ok(transcript, 'transcript should exist for session');
  assert.equal(transcript!.length, 1);
  assert.equal(transcript![0]?.id, 'loc-1');
  assert.equal(transcript![0]?.role, 'user');

  // Only SendRpc effect now (no InsertOptimisticMessage).
  assert.equal(result.effects.length, 1);
  assert.equal(result.effects[0]?.kind, 'SendRpc');
  if (result.effects[0]?.kind === 'SendRpc') {
    assert.equal(result.effects[0].text, 'raw');
    assert.deepEqual(result.effects[0].inputs, []);
  }
});

test('reducer: SendResult{ok:true} clears pending and composer inputs directly', () => {
  const state: ArchState = {
    ...initialArchState,
    composer: {
      ...initialArchState.composer,
      pendingComposerInputsBySession: { '/s': [{ id: 'in1', kind: 'filesystemPathRef', path: '/f', name: 'f', source: 'picker' }] },
    },
    pending: {
      ...initialArchState.pending,
      ops: { 'c-ok': { kind: 'send', sessionPath: '/s', localId: 'loc-1', previousSummary: null } },
    },
  };

  const result = reducer(state, { kind: 'SendResult', corrId: 'c-ok', sessionPath: '/s', ok: true });

  assert.equal(result.state.pending.ops['c-ok'], undefined);
  // Composer inputs cleared directly in state.
  assert.equal(result.state.composer.pendingComposerInputsBySession['/s'], undefined);
  // No effects — state mutation only.
  assert.equal(result.effects.length, 0);
});

test('reducer: SendResult{ok:false} clears pending, removes optimistic, restores name, notifies', () => {
  const prevSummary = { path: '/s', name: 'Old', cwd: '/', modifiedAt: '', messageCount: 0 };
  const state: ArchState = {
    ...initialArchState,
    transcript: {
      ...initialArchState.transcript,
      bySession: { '/s': [{ id: 'loc-2', role: 'user' as const, createdAt: '', markdown: 'hello', status: 'completed' as const }] },
      windowBySession: { '/s': { totalCount: 1, loadedStart: 0, loadedEnd: 1, hasOlder: false, hasNewer: false, isPartial: false, hasUserMessages: true } },
    },
    sessions: {
      ...initialArchState.sessions,
      sessions: [{ path: '/s', name: 'Modified', cwd: '/', modifiedAt: '', messageCount: 1 }],
    },
    pending: {
      ...initialArchState.pending,
      ops: { 'c-fail': { kind: 'send', sessionPath: '/s', localId: 'loc-2', previousSummary: prevSummary } },
    },
  };

  const result = reducer(state, { kind: 'SendResult', corrId: 'c-fail', sessionPath: '/s', ok: false, error: 'timeout' });

  assert.equal(result.state.pending.ops['c-fail'], undefined);
  // Optimistic message removed from transcript.
  assert.ok(!result.state.transcript.bySession['/s']?.some((m: ChatMessage) => m.id === 'loc-2'), 'optimistic message should be removed');
  // Notice set directly in state.
  assert.match(result.state.settings.notice!, /Failed to send/);
  // Session summary restored.
  const restored = result.state.sessions.sessions.find(s => s.path === '/s');
  assert.equal(restored?.name, 'Old');
  // Only PostImperative remains as a real side-effect effect.
  assert.equal(result.effects.length, 1);
  assert.equal(result.effects[0]?.kind, 'PostImperative');
});

test('reducer: SendResult{ok:false} without previousSummary does not restore session name', () => {
  const state: ArchState = {
    ...initialArchState,
    transcript: {
      ...initialArchState.transcript,
      bySession: { '/s': [{ id: 'loc-3', role: 'user' as const, createdAt: '', markdown: 'hi', status: 'completed' as const }] },
      windowBySession: { '/s': { totalCount: 1, loadedStart: 0, loadedEnd: 1, hasOlder: false, hasNewer: false, isPartial: false, hasUserMessages: true } },
    },
    pending: {
      ...initialArchState.pending,
      ops: { 'c-fail2': { kind: 'send', sessionPath: '/s', localId: 'loc-3', previousSummary: null } },
    },
  };

  const result = reducer(state, { kind: 'SendResult', corrId: 'c-fail2', sessionPath: '/s', ok: false, error: 'err' });

  assert.equal(result.state.pending.ops['c-fail2'], undefined);
  // No previousSummary, so sessions list is unchanged.
  assert.deepEqual(result.state.sessions.sessions, []);
  // But notice and message removal still happened.
  assert.ok(result.state.settings.notice);
});

test('reducer: SendResult for unknown corrId is a no-op', () => {
  const result = reducer(initialArchState, { kind: 'SendResult', corrId: 'unknown', sessionPath: '/s', ok: true });
  assert.deepEqual(result.state, initialArchState);
  assert.deepEqual(result.effects, []);
});

// ─── Phase 4: Edit ──────────────────────────────────────────────────────────

test('reducer: Edit command records pending, inserts optimistic message, produces EditRpc', () => {
  const event: Event = {
    kind: 'Command',
    cmd: { kind: 'Edit', corrId: 'c-edit', sessionPath: '/s', messageId: 'msg-1', text: 'new text', localId: 'loc-e1' },
  };

  const result = reducer(initialArchState, event);

  assert.deepEqual(result.state.pending.ops['c-edit'], {
    kind: 'edit',
    sessionPath: '/s',
    localId: 'loc-e1',
    previousSummary: null,
  });

  // Optimistic user message in transcript.
  const transcript = result.state.transcript.bySession['/s'];
  assert.ok(transcript, 'transcript should exist');
  assert.equal(transcript![0]?.id, 'loc-e1');
  assert.equal(transcript![0]?.role, 'user');

  // Only EditRpc effect now.
  assert.equal(result.effects.length, 1);
  assert.equal(result.effects[0]?.kind, 'EditRpc');
  if (result.effects[0]?.kind === 'EditRpc') {
    assert.equal(result.effects[0].messageId, 'msg-1');
    assert.equal(result.effects[0].text, 'new text');
  }
});

test('reducer: EditResult{ok:true} clears pending with no extra effects', () => {
  const state: ArchState = {
    ...initialArchState,
    pending: {
      ...initialArchState.pending,
      ops: { 'c-edit-ok': { kind: 'edit', sessionPath: '/s', localId: 'loc-e2', previousSummary: null } },
    },
  };

  const result = reducer(state, { kind: 'EditResult', corrId: 'c-edit-ok', sessionPath: '/s', ok: true });

  assert.equal(result.state.pending.ops['c-edit-ok'], undefined);
  assert.deepEqual(result.effects, []);
});

test('reducer: EditResult{ok:false} clears pending, removes optimistic, sets notice', () => {
  const state: ArchState = {
    ...initialArchState,
    transcript: {
      ...initialArchState.transcript,
      bySession: { '/s': [{ id: 'loc-e3', role: 'user' as const, createdAt: '', markdown: 'edit', status: 'completed' as const }] },
      windowBySession: { '/s': { totalCount: 1, loadedStart: 0, loadedEnd: 1, hasOlder: false, hasNewer: false, isPartial: false, hasUserMessages: true } },
    },
    pending: {
      ...initialArchState.pending,
      ops: { 'c-edit-fail': { kind: 'edit', sessionPath: '/s', localId: 'loc-e3', previousSummary: null } },
    },
  };

  const result = reducer(state, { kind: 'EditResult', corrId: 'c-edit-fail', sessionPath: '/s', ok: false, error: 'denied' });

  assert.equal(result.state.pending.ops['c-edit-fail'], undefined);
  // Notice set directly in state.
  assert.match(result.state.settings.notice!, /Failed to edit/);
  // Optimistic message removed from transcript.
  assert.ok(!result.state.transcript.bySession['/s']?.some((m: ChatMessage) => m.id === 'loc-e3'), 'optimistic edit message should be removed');
  // No SyncEffects — all state mutations are direct.
  assert.deepEqual(result.effects, []);
});

// ─── Phase 5: Alias lifecycle ─────────────────────────────────────────────────

test('reducer: MessageStarted with new requestId creates currentTurn and assistant message in transcript', () => {
  const event: Event = {
    kind: 'MessageStarted',
    sessionPath: '/s',
    messageId: 'msg-1',
    requestId: 'req-1',
    modelId: 'gpt-5',
    thinkingLevel: 'high',
  };

  const result = reducer(initialArchState, event);

  // currentTurnBySession updated
  assert.deepEqual(result.state.pending.currentTurnBySession['/s'], { requestId: 'req-1', firstMessageId: 'msg-1' });
  // No alias created
  assert.equal(result.state.pending.messageIdAlias['msg-1'], undefined);
  // Assistant message created in transcript
  const msg = result.state.transcript.bySession['/s']?.find((m: ChatMessage) => m.id === 'msg-1');
  assert.ok(msg, 'assistant message should exist in transcript');
  assert.equal(msg!.role, 'assistant');
  assert.equal(msg!.status, 'streaming');
  assert.equal(msg!.modelId, 'gpt-5');
  assert.equal(msg!.thinkingLevel, 'high');
  // No SyncEffects
  assert.equal(result.effects.length, 0);
});

test('reducer: MessageStarted with same requestId creates alias and updates canonical message', () => {
  // Seed an existing message in transcript
  const state: ArchState = {
    ...initialArchState,
    transcript: {
      ...initialArchState.transcript,
      bySession: {
        '/s': [{ id: 'msg-1', role: 'assistant' as const, createdAt: '', markdown: 'hello', status: 'completed' as const, parts: [], toolCalls: [] }],
      },
      windowBySession: { '/s': { totalCount: 1, loadedStart: 0, loadedEnd: 1, hasOlder: false, hasNewer: false, isPartial: false, hasUserMessages: true } },
    },
    pending: {
      ...initialArchState.pending,
      currentTurnBySession: { '/s': { requestId: 'req-1', firstMessageId: 'msg-1' } },
    },
  };

  const event: Event = {
    kind: 'MessageStarted',
    sessionPath: '/s',
    messageId: 'msg-2',
    requestId: 'req-1',
    modelId: 'gpt-5',
  };

  const result = reducer(state, event);

  // Alias recorded
  assert.equal(result.state.pending.messageIdAlias['msg-2'], 'msg-1');
  // currentTurn unchanged
  assert.deepEqual(result.state.pending.currentTurnBySession['/s'], { requestId: 'req-1', firstMessageId: 'msg-1' });
  // Canonical message updated to streaming status with continuation separator
  const canonical = result.state.transcript.bySession['/s']?.find((m: ChatMessage) => m.id === 'msg-1');
  assert.ok(canonical, 'canonical message should still exist');
  assert.equal(canonical!.status, 'streaming');
  // No SyncEffects
  assert.equal(result.effects.length, 0);
});

test('reducer: MessageStarted without requestId does not update currentTurnBySession', () => {
  const event: Event = {
    kind: 'MessageStarted',
    sessionPath: '/s',
    messageId: 'msg-x',
  };

  const result = reducer(initialArchState, event);

  assert.equal(result.state.pending.currentTurnBySession['/s'], undefined);
  // Assistant message created in transcript
  const msg = result.state.transcript.bySession['/s']?.find((m: ChatMessage) => m.id === 'msg-x');
  assert.ok(msg, 'message should exist');
  assert.equal(msg!.status, 'streaming');
});

test('reducer: MessageDelta appends text to message directly in state', () => {
  const state: ArchState = {
    ...initialArchState,
    transcript: {
      ...initialArchState.transcript,
      bySession: {
        '/s': [{ id: 'm1', role: 'assistant' as const, createdAt: '', markdown: '', status: 'streaming' as const, parts: [], toolCalls: [] }],
      },
    },
  };

  const result = reducer(state, {
    kind: 'MessageDelta',
    sessionPath: '/s',
    messageId: 'm1',
    delta: 'hello',
  });

  const msg = result.state.transcript.bySession['/s']?.find((m: ChatMessage) => m.id === 'm1');
  assert.equal(msg?.markdown, 'hello');
  assert.equal(result.effects.length, 0);
});

test('reducer: MessageDelta resolves alias before appending', () => {
  const state: ArchState = {
    ...initialArchState,
    pending: {
      ...initialArchState.pending,
      messageIdAlias: { 'alias-1': 'canonical-1' },
    },
    transcript: {
      ...initialArchState.transcript,
      bySession: {
        '/s': [{ id: 'canonical-1', role: 'assistant' as const, createdAt: '', markdown: '', status: 'streaming' as const, parts: [], toolCalls: [] }],
      },
    },
  };

  const result = reducer(state, {
    kind: 'MessageDelta',
    sessionPath: '/s',
    messageId: 'alias-1',
    delta: 'hello',
  });

  const msg = result.state.transcript.bySession['/s']?.find((m: ChatMessage) => m.id === 'canonical-1');
  assert.equal(msg?.markdown, 'hello');
  assert.equal(result.effects.length, 0);
});

test('reducer: MessageDelta with unknown messageId passes through unchanged', () => {
  const result = reducer(initialArchState, {
    kind: 'MessageDelta',
    sessionPath: '/s',
    messageId: 'direct-id',
    delta: 'world',
  });

  // No effect, no state change (message doesn't exist)
  assert.deepEqual(result.state, initialArchState);
  assert.equal(result.effects.length, 0);
});

test('reducer: MessageThinking resolves alias and appends reasoning', () => {
  const state: ArchState = {
    ...initialArchState,
    pending: {
      ...initialArchState.pending,
      messageIdAlias: { 'alias-t': 'canonical-t' },
    },
    transcript: {
      ...initialArchState.transcript,
      bySession: {
        '/s': [{ id: 'canonical-t', role: 'assistant' as const, createdAt: '', markdown: '', status: 'streaming' as const, parts: [], toolCalls: [] }],
      },
    },
  };

  const result = reducer(state, {
    kind: 'MessageThinking',
    sessionPath: '/s',
    messageId: 'alias-t',
    thinking: 'plan',
  });

  const msg = result.state.transcript.bySession['/s']?.find((m: ChatMessage) => m.id === 'canonical-t');
  assert.equal(msg?.thinking, 'plan');
  assert.equal(result.effects.length, 0);
});

test('reducer: ToolCall resolves alias and upserts tool call directly', () => {
  const state: ArchState = {
    ...initialArchState,
    pending: {
      ...initialArchState.pending,
      messageIdAlias: { 'alias-tc': 'canonical-tc' },
    },
    transcript: {
      ...initialArchState.transcript,
      bySession: {
        '/s': [{ id: 'canonical-tc', role: 'assistant' as const, createdAt: '', markdown: '', status: 'streaming' as const, parts: [], toolCalls: [] }],
      },
    },
  };

  const toolCall = { id: 'tool-1', name: 'bash', input: { command: 'ls' }, status: 'running' as const };
  const result = reducer(state, {
    kind: 'ToolCall',
    sessionPath: '/s',
    messageId: 'alias-tc',
    toolCall,
  });

  const msg = result.state.transcript.bySession['/s']?.find((m: ChatMessage) => m.id === 'canonical-tc');
  assert.ok(msg, 'message should exist');
  assert.equal(msg!.toolCalls?.length, 1);
  assert.equal(msg!.toolCalls![0]?.id, 'tool-1');
  assert.equal(result.effects.length, 0);
});

test('reducer: MessageFinished resolves alias and merges into canonical message', () => {
  const state: ArchState = {
    ...initialArchState,
    pending: {
      ...initialArchState.pending,
      messageIdAlias: { 'alias-fin': 'canonical-fin' },
    },
    transcript: {
      ...initialArchState.transcript,
      bySession: {
        '/s': [{ id: 'canonical-fin', role: 'assistant' as const, createdAt: '', markdown: 'streaming', status: 'streaming' as const, parts: [], toolCalls: [] }],
      },
      windowBySession: { '/s': { totalCount: 1, loadedStart: 0, loadedEnd: 1, hasOlder: false, hasNewer: false, isPartial: false, hasUserMessages: true } },
    },
  };

  const message: ChatMessage = {
    id: 'alias-fin', role: 'assistant', createdAt: '', markdown: 'done', status: 'completed',
  };

  const result = reducer(state, { kind: 'MessageFinished', sessionPath: '/s', message });
  // Since it's an alias, the message is merged into the canonical message
  const canonical = result.state.transcript.bySession['/s']?.find((m: ChatMessage) => m.id === 'canonical-fin');
  assert.ok(canonical, 'canonical message should still exist');
  assert.equal(canonical!.status, 'completed');
  assert.equal(result.effects.length, 0);
});

test('reducer: MessageFinished without alias upserts message directly', () => {
  const message: ChatMessage = {
    id: 'direct-id', role: 'assistant', createdAt: '', markdown: 'done', status: 'completed',
  };

  const result = reducer(initialArchState, { kind: 'MessageFinished', sessionPath: '/s', message });
  const msg = result.state.transcript.bySession['/s']?.find((m: ChatMessage) => m.id === 'direct-id');
  assert.ok(msg, 'message should exist in transcript');
  assert.equal(msg!.status, 'completed');
  assert.equal(result.effects.length, 0);
});

test('reducer: MessageAborted resolves alias and sets status directly in state', () => {
  const state: ArchState = {
    ...initialArchState,
    pending: {
      ...initialArchState.pending,
      messageIdAlias: { 'alias-abort': 'canonical-abort' },
    },
    transcript: {
      ...initialArchState.transcript,
      bySession: {
        '/s': [{ id: 'canonical-abort', role: 'assistant' as const, createdAt: '', markdown: 'text', status: 'streaming' as const, parts: [], toolCalls: [] }],
      },
    },
  };

  const result = reducer(state, { kind: 'MessageAborted', sessionPath: '/s', messageId: 'alias-abort' });
  const msg = result.state.transcript.bySession['/s']?.find((m: ChatMessage) => m.id === 'canonical-abort');
  assert.ok(msg, 'canonical message should exist');
  assert.equal(msg!.status, 'interrupted');
  assert.equal(result.effects.length, 0);
});

test('reducer: MessageAborted without messageId is a no-op', () => {
  const result = reducer(initialArchState, { kind: 'MessageAborted', sessionPath: '/s', messageId: undefined });
  assert.deepEqual(result.state, initialArchState);
  assert.deepEqual(result.effects, []);
});

test('reducer: full alias lifecycle — multi-turn accumulation', () => {
  // Turn 1: MessageStarted creates first turn
  let { state } = reducer(initialArchState, {
    kind: 'MessageStarted', sessionPath: '/s', messageId: 'req1:1', requestId: 'req1', modelId: 'gpt-5',
  });

  // Verify assistant message created
  let msg = state.transcript.bySession['/s']?.find((m: ChatMessage) => m.id === 'req1:1');
  assert.ok(msg, 'first assistant message should exist');
  assert.equal(msg!.status, 'streaming');

  // Delta on first message appends text
  let r = reducer(state, { kind: 'MessageDelta', sessionPath: '/s', messageId: 'req1:1', delta: 'hello' });
  state = r.state;
  msg = state.transcript.bySession['/s']?.find((m: ChatMessage) => m.id === 'req1:1');
  assert.equal(msg?.markdown, 'hello');

  // Turn 2: same requestId → alias created
  r = reducer(state, {
    kind: 'MessageStarted', sessionPath: '/s', messageId: 'req1:2', requestId: 'req1',
  });
  state = r.state;
  assert.equal(state.pending.messageIdAlias['req1:2'], 'req1:1');

  // Delta on aliased ID resolves to canonical and appends
  r = reducer(state, { kind: 'MessageDelta', sessionPath: '/s', messageId: 'req1:2', delta: 'world' });
  state = r.state;
  msg = state.transcript.bySession['/s']?.find((m: ChatMessage) => m.id === 'req1:1');
  assert.ok(msg?.markdown?.includes('world'), 'delta should append to canonical message');

  // Finished on aliased ID merges into canonical
  const finMsg: ChatMessage = { id: 'req1:2', role: 'assistant', createdAt: '', markdown: 'world', status: 'completed' };
  r = reducer(state, { kind: 'MessageFinished', sessionPath: '/s', message: finMsg });
  state = r.state;
  msg = state.transcript.bySession['/s']?.find((m: ChatMessage) => m.id === 'req1:1');
  assert.ok(msg, 'canonical message should persist');
  assert.equal(msg!.status, 'completed');
});

test('reducer: BusyChanged running=true adds session to runningSessionPaths', () => {
  const result = reducer(initialArchState, {
    kind: 'BusyChanged',
    sessionPath: '/s',
    running: true,
  });

  assert.ok(result.state.sessions.runningSessionPaths.includes('/s'));
  assert.equal(result.state.sessions.unreadFinishedSessionPaths.length, 0);
  assert.deepEqual(result.effects, []);
});

test('reducer: BusyChanged running=false when was running adds to unreadFinishedSessionPaths', () => {
  // First mark the session as running
  const state = reducer(initialArchState, {
    kind: 'BusyChanged',
    sessionPath: '/s',
    running: true,
  }).state;

  assert.ok(state.sessions.runningSessionPaths.includes('/s'));

  // Now mark it as not running
  const result = reducer(state, {
    kind: 'BusyChanged',
    sessionPath: '/s',
    running: false,
  });

  assert.equal(result.state.sessions.runningSessionPaths.includes('/s'), false);
  assert.ok(result.state.sessions.unreadFinishedSessionPaths.includes('/s'));
  assert.deepEqual(result.effects, []);
});

test('reducer: BusyChanged running=false when never running does NOT add to unreadFinishedSessionPaths', () => {
  const result = reducer(initialArchState, {
    kind: 'BusyChanged',
    sessionPath: '/s',
    running: false,
  });

  assert.equal(result.state.sessions.runningSessionPaths.includes('/s'), false);
  assert.equal(result.state.sessions.unreadFinishedSessionPaths.includes('/s'), false);
  assert.equal(result.state.sessions.unreadFinishedSessionPaths.length, 0);
  assert.deepEqual(result.effects, []);
});

test('reducer: BusyChanged running=false for a session that finished earlier does not re-add to unreadFinishedSessionPaths', () => {
  // Mark as running, then finished
  let state = reducer(initialArchState, {
    kind: 'BusyChanged', sessionPath: '/s', running: true,
  }).state;
  state = reducer(state, {
    kind: 'BusyChanged', sessionPath: '/s', running: false,
  }).state;

  assert.equal(state.sessions.runningSessionPaths.includes('/s'), false);
  assert.ok(state.sessions.unreadFinishedSessionPaths.includes('/s'));

  // A second BusyChanged(false) should not re-add
  const result = reducer(state, {
    kind: 'BusyChanged', sessionPath: '/s', running: false,
  });

  assert.equal(result.state.sessions.runningSessionPaths.includes('/s'), false);
  assert.ok(result.state.sessions.unreadFinishedSessionPaths.includes('/s'));
  assert.equal(result.state.sessions.unreadFinishedSessionPaths.length, 1);
  assert.deepEqual(result.effects, []);
});
