import test from 'node:test';
import assert from 'node:assert/strict';

import { reducer, initialArchState, type ArchState } from '../src/host/core/reducer';
import type { Event } from '../src/host/core/events';

test('reducer: initial state has empty pending and sessions records', () => {
  assert.deepEqual(initialArchState.pending, {});
  assert.deepEqual(initialArchState.sessions, {});
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

test('reducer: Interrupt command sets interruptInFlight and returns InterruptRpc effect', () => {
  const event: Event = {
    kind: 'Command',
    cmd: { kind: 'Interrupt', corrId: 'c1', sessionPath: '/session/a' },
  };

  const result = reducer(initialArchState, event);

  assert.equal(result.state.sessions['/session/a']?.interruptInFlight, true);
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
    sessions: { '/b': { interruptInFlight: false } },
  };

  const event: Event = {
    kind: 'Command',
    cmd: { kind: 'Interrupt', corrId: 'c2', sessionPath: '/a' },
  };

  const result = reducer(stateWithB, event);

  assert.equal(result.state.sessions['/a']?.interruptInFlight, true);
  assert.equal(result.state.sessions['/b']?.interruptInFlight, false);
});

test('reducer: InterruptResult{ok:true} clears interruptInFlight with no effects', () => {
  const state: ArchState = {
    ...initialArchState,
    sessions: { '/a': { interruptInFlight: true } },
  };

  const event: Event = {
    kind: 'InterruptResult',
    corrId: 'c1',
    sessionPath: '/a',
    ok: true,
  };

  const result = reducer(state, event);

  assert.equal(result.state.sessions['/a']?.interruptInFlight, false);
  assert.deepEqual(result.effects, []);
});

test('reducer: InterruptResult{ok:false} clears flag and produces Log effect', () => {
  const state: ArchState = {
    ...initialArchState,
    sessions: { '/a': { interruptInFlight: true } },
  };

  const event: Event = {
    kind: 'InterruptResult',
    corrId: 'c1',
    sessionPath: '/a',
    ok: false,
    error: 'connection lost',
  };

  const result = reducer(state, event);

  assert.equal(result.state.sessions['/a']?.interruptInFlight, false);
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

test('reducer: Send command records pending, produces InsertOptimisticMessage + SendRpc', () => {
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
  assert.deepEqual(result.state.pending['c-send'], {
    kind: 'send',
    sessionPath: '/s',
    localId: 'loc-1',
    previousSummary: null,
  });

  // Effects: InsertOptimisticMessage then SendRpc.
  assert.equal(result.effects.length, 2);
  assert.equal(result.effects[0]?.kind, 'InsertOptimisticMessage');
  if (result.effects[0]?.kind === 'InsertOptimisticMessage') {
    assert.equal(result.effects[0].sessionPath, '/s');
    assert.equal(result.effects[0].localId, 'loc-1');
    assert.equal(result.effects[0].text, 'composed');
  }
  assert.equal(result.effects[1]?.kind, 'SendRpc');
  if (result.effects[1]?.kind === 'SendRpc') {
    assert.equal(result.effects[1].text, 'raw');
    assert.deepEqual(result.effects[1].inputs, []);
  }
});

test('reducer: SendResult{ok:true} clears pending, produces ClearComposerInputs', () => {
  const state: ArchState = {
    ...initialArchState,
    pending: { 'c-ok': { kind: 'send', sessionPath: '/s', localId: 'loc-1', previousSummary: null } },
  };

  const result = reducer(state, { kind: 'SendResult', corrId: 'c-ok', sessionPath: '/s', ok: true });

  assert.equal(result.state.pending['c-ok'], undefined);
  assert.equal(result.effects.length, 1);
  assert.equal(result.effects[0]?.kind, 'ClearComposerInputs');
});

test('reducer: SendResult{ok:false} clears pending, removes optimistic, restores name, notifies', () => {
  const prevSummary = { path: '/s', name: 'Old', cwd: '/', modifiedAt: '', messageCount: 0 };
  const state: ArchState = {
    ...initialArchState,
    pending: { 'c-fail': { kind: 'send', sessionPath: '/s', localId: 'loc-2', previousSummary: prevSummary } },
  };

  const result = reducer(state, { kind: 'SendResult', corrId: 'c-fail', sessionPath: '/s', ok: false, error: 'timeout' });

  assert.equal(result.state.pending['c-fail'], undefined);
  const kinds = result.effects.map((e) => e.kind);
  assert.ok(kinds.includes('RemoveOptimisticMessage'));
  assert.ok(kinds.includes('PostImperative'));
  assert.ok(kinds.includes('SetNotice'));
  assert.ok(kinds.includes('RestoreSessionSummary'));
});

test('reducer: SendResult{ok:false} without previousSummary does not produce RestoreSessionSummary', () => {
  const state: ArchState = {
    ...initialArchState,
    pending: { 'c-fail2': { kind: 'send', sessionPath: '/s', localId: 'loc-3', previousSummary: null } },
  };

  const result = reducer(state, { kind: 'SendResult', corrId: 'c-fail2', sessionPath: '/s', ok: false, error: 'err' });

  const kinds = result.effects.map((e) => e.kind);
  assert.ok(!kinds.includes('RestoreSessionSummary'));
});

test('reducer: SendResult for unknown corrId is a no-op', () => {
  const result = reducer(initialArchState, { kind: 'SendResult', corrId: 'unknown', sessionPath: '/s', ok: true });
  assert.deepEqual(result.state, initialArchState);
  assert.deepEqual(result.effects, []);
});

// ─── Phase 4: Edit ──────────────────────────────────────────────────────────

test('reducer: Edit command records pending, produces InsertOptimisticMessage + EditRpc', () => {
  const event: Event = {
    kind: 'Command',
    cmd: { kind: 'Edit', corrId: 'c-edit', sessionPath: '/s', messageId: 'msg-1', text: 'new text', localId: 'loc-e1' },
  };

  const result = reducer(initialArchState, event);

  assert.deepEqual(result.state.pending['c-edit'], {
    kind: 'edit',
    sessionPath: '/s',
    localId: 'loc-e1',
    previousSummary: null,
  });

  assert.equal(result.effects.length, 2);
  assert.equal(result.effects[0]?.kind, 'InsertOptimisticMessage');
  assert.equal(result.effects[1]?.kind, 'EditRpc');
  if (result.effects[1]?.kind === 'EditRpc') {
    assert.equal(result.effects[1].messageId, 'msg-1');
    assert.equal(result.effects[1].text, 'new text');
  }
});

test('reducer: EditResult{ok:true} clears pending with no extra effects', () => {
  const state: ArchState = {
    ...initialArchState,
    pending: { 'c-edit-ok': { kind: 'edit', sessionPath: '/s', localId: 'loc-e2', previousSummary: null } },
  };

  const result = reducer(state, { kind: 'EditResult', corrId: 'c-edit-ok', sessionPath: '/s', ok: true });

  assert.equal(result.state.pending['c-edit-ok'], undefined);
  assert.deepEqual(result.effects, []);
});

test('reducer: EditResult{ok:false} clears pending, removes optimistic, sets notice', () => {
  const state: ArchState = {
    ...initialArchState,
    pending: { 'c-edit-fail': { kind: 'edit', sessionPath: '/s', localId: 'loc-e3', previousSummary: null } },
  };

  const result = reducer(state, { kind: 'EditResult', corrId: 'c-edit-fail', sessionPath: '/s', ok: false, error: 'denied' });

  assert.equal(result.state.pending['c-edit-fail'], undefined);
  const kinds = result.effects.map((e) => e.kind);
  assert.ok(kinds.includes('RemoveOptimisticMessage'));
  assert.ok(kinds.includes('SetNotice'));
  if (result.effects[1]?.kind === 'SetNotice') {
    assert.match(result.effects[1].message!, /Failed to edit/);
  }
});

// ─── Phase 5: Alias lifecycle ─────────────────────────────────────────────────

test('reducer: MessageStarted with new requestId creates currentTurn and emits EnsureAssistantMessage (isAlias=false)', () => {
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
  assert.deepEqual(result.state.currentTurnBySession['/s'], { requestId: 'req-1', firstMessageId: 'msg-1' });
  // No alias created
  assert.equal(result.state.messageIdAlias['msg-1'], undefined);
  // EnsureAssistantMessage emitted with isAlias=false
  const ensure = result.effects.find(e => e.kind === 'EnsureAssistantMessage');
  assert.ok(ensure);
  if (ensure?.kind === 'EnsureAssistantMessage') {
    assert.equal(ensure.isAlias, false);
    assert.equal(ensure.canonicalMessageId, 'msg-1');
    assert.equal(ensure.modelId, 'gpt-5');
    assert.equal(ensure.thinkingLevel, 'high');
  }
});

test('reducer: MessageStarted with same requestId creates alias and emits EnsureAssistantMessage (isAlias=true)', () => {
  const state: ArchState = {
    ...initialArchState,
    currentTurnBySession: { '/s': { requestId: 'req-1', firstMessageId: 'msg-1' } },
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
  assert.equal(result.state.messageIdAlias['msg-2'], 'msg-1');
  // currentTurn unchanged
  assert.deepEqual(result.state.currentTurnBySession['/s'], { requestId: 'req-1', firstMessageId: 'msg-1' });
  // EnsureAssistantMessage emitted with isAlias=true
  const ensure = result.effects.find(e => e.kind === 'EnsureAssistantMessage');
  assert.ok(ensure);
  if (ensure?.kind === 'EnsureAssistantMessage') {
    assert.equal(ensure.isAlias, true);
    assert.equal(ensure.canonicalMessageId, 'msg-1');
    assert.equal(ensure.messageId, 'msg-2');
  }
});

test('reducer: MessageStarted without requestId does not update currentTurnBySession', () => {
  const event: Event = {
    kind: 'MessageStarted',
    sessionPath: '/s',
    messageId: 'msg-x',
  };

  const result = reducer(initialArchState, event);

  assert.equal(result.state.currentTurnBySession['/s'], undefined);
  const ensure = result.effects.find(e => e.kind === 'EnsureAssistantMessage');
  assert.ok(ensure);
  if (ensure?.kind === 'EnsureAssistantMessage') {
    assert.equal(ensure.isAlias, false);
    assert.equal(ensure.canonicalMessageId, 'msg-x');
  }
});

test('reducer: MessageDelta resolves alias before emitting AppendDelta', () => {
  const state: ArchState = {
    ...initialArchState,
    messageIdAlias: { 'alias-1': 'canonical-1' },
  };

  const event: Event = {
    kind: 'MessageDelta',
    sessionPath: '/s',
    messageId: 'alias-1',
    delta: 'hello',
  };

  const result = reducer(state, event);
  const delta = result.effects.find(e => e.kind === 'AppendDelta');
  assert.ok(delta);
  if (delta?.kind === 'AppendDelta') {
    assert.equal(delta.messageId, 'canonical-1');
    assert.equal(delta.delta, 'hello');
  }
});

test('reducer: MessageDelta with unknown messageId passes through unchanged', () => {
  const event: Event = {
    kind: 'MessageDelta',
    sessionPath: '/s',
    messageId: 'direct-id',
    delta: 'world',
  };

  const result = reducer(initialArchState, event);
  const delta = result.effects.find(e => e.kind === 'AppendDelta');
  assert.ok(delta);
  if (delta?.kind === 'AppendDelta') {
    assert.equal(delta.messageId, 'direct-id');
  }
});

test('reducer: MessageThinking resolves alias', () => {
  const state: ArchState = {
    ...initialArchState,
    messageIdAlias: { 'alias-t': 'canonical-t' },
  };

  const result = reducer(state, {
    kind: 'MessageThinking',
    sessionPath: '/s',
    messageId: 'alias-t',
    thinking: 'plan',
  });

  const effect = result.effects.find(e => e.kind === 'AppendThinking');
  assert.ok(effect);
  if (effect?.kind === 'AppendThinking') {
    assert.equal(effect.messageId, 'canonical-t');
    assert.equal(effect.thinking, 'plan');
  }
});

test('reducer: ToolCall resolves alias', () => {
  const state: ArchState = {
    ...initialArchState,
    messageIdAlias: { 'alias-tc': 'canonical-tc' },
  };

  const toolCall = { id: 'tool-1', name: 'bash', input: { command: 'ls' }, status: 'running' as const };
  const result = reducer(state, {
    kind: 'ToolCall',
    sessionPath: '/s',
    messageId: 'alias-tc',
    toolCall,
  });

  const effect = result.effects.find(e => e.kind === 'UpsertToolCall');
  assert.ok(effect);
  if (effect?.kind === 'UpsertToolCall') {
    assert.equal(effect.messageId, 'canonical-tc');
    assert.deepEqual(effect.toolCall, toolCall);
  }
});

test('reducer: MessageFinished resolves alias and sets canonicalMessageId on UpsertMessage', () => {
  const state: ArchState = {
    ...initialArchState,
    messageIdAlias: { 'alias-fin': 'canonical-fin' },
  };

  const message = {
    id: 'alias-fin', role: 'assistant' as const, createdAt: '', markdown: 'done', status: 'completed' as const,
  } as any;

  const result = reducer(state, { kind: 'MessageFinished', sessionPath: '/s', message });
  const effect = result.effects.find(e => e.kind === 'UpsertMessage');
  assert.ok(effect);
  if (effect?.kind === 'UpsertMessage') {
    assert.equal(effect.canonicalMessageId, 'canonical-fin');
    assert.equal(effect.message.id, 'alias-fin');
  }
});

test('reducer: MessageFinished without alias does not set canonicalMessageId', () => {
  const message = {
    id: 'direct-id', role: 'assistant' as const, createdAt: '', markdown: 'done', status: 'completed' as const,
  } as any;

  const result = reducer(initialArchState, { kind: 'MessageFinished', sessionPath: '/s', message });
  const effect = result.effects.find(e => e.kind === 'UpsertMessage');
  assert.ok(effect);
  if (effect?.kind === 'UpsertMessage') {
    assert.equal(effect.canonicalMessageId, undefined);
  }
});

test('reducer: MessageAborted resolves alias before setting status', () => {
  const state: ArchState = {
    ...initialArchState,
    messageIdAlias: { 'alias-abort': 'canonical-abort' },
  };

  const result = reducer(state, { kind: 'MessageAborted', sessionPath: '/s', messageId: 'alias-abort' });
  const effect = result.effects.find(e => e.kind === 'SetMessageStatus');
  assert.ok(effect);
  if (effect?.kind === 'SetMessageStatus') {
    assert.equal(effect.messageId, 'canonical-abort');
    assert.equal(effect.status, 'interrupted');
  }
});

test('reducer: MessageAborted without messageId is a render-only no-op', () => {
  const result = reducer(initialArchState, { kind: 'MessageAborted', sessionPath: '/s', messageId: undefined });
  assert.ok(!result.effects.find(e => e.kind === 'SetMessageStatus'));
  assert.ok(result.effects.find(e => e.kind === 'ScheduleRender'));
});

test('reducer: full alias lifecycle — multi-turn accumulation', () => {
  // Turn 1: MessageStarted creates first turn
  let { state } = reducer(initialArchState, {
    kind: 'MessageStarted', sessionPath: '/s', messageId: 'req1:1', requestId: 'req1', modelId: 'gpt-5',
  });

  // Simulate delta on first message
  let r = reducer(state, { kind: 'MessageDelta', sessionPath: '/s', messageId: 'req1:1', delta: 'hello' });
  const delta1 = r.effects.find(e => e.kind === 'AppendDelta');
  assert.ok(delta1?.kind === 'AppendDelta' && delta1.messageId === 'req1:1');

  // Turn 2: same requestId → alias created
  r = reducer(state, {
    kind: 'MessageStarted', sessionPath: '/s', messageId: 'req1:2', requestId: 'req1',
  });
  state = r.state;
  assert.equal(state.messageIdAlias['req1:2'], 'req1:1');

  // Delta on aliased ID resolves to canonical
  r = reducer(state, { kind: 'MessageDelta', sessionPath: '/s', messageId: 'req1:2', delta: 'world' });
  const delta2 = r.effects.find(e => e.kind === 'AppendDelta');
  assert.ok(delta2?.kind === 'AppendDelta' && delta2.messageId === 'req1:1');

  // Finished on aliased ID produces canonicalMessageId
  const finMsg = { id: 'req1:2', role: 'assistant' as const, createdAt: '', markdown: 'world', status: 'completed' as const } as any;
  r = reducer(state, { kind: 'MessageFinished', sessionPath: '/s', message: finMsg });
  const upsert = r.effects.find(e => e.kind === 'UpsertMessage');
  assert.ok(upsert?.kind === 'UpsertMessage' && upsert.canonicalMessageId === 'req1:1');
});
