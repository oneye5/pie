/**
 * Phase 4 arrival-order tests.
 *
 * These verify that removing the event-buffering window in backend-client.ts
 * is safe: the CQRS reducer's pending state correctly survives arbitrary
 * interleaving of events between command dispatch and result arrival.
 *
 * Scenarios:
 *  - send-then-success: Send → SendResult{ok:true}
 *  - send-then-failure: Send → SendResult{ok:false}
 *  - send-then-delta-before-ack: Send → unrelated event → SendResult
 *  - send-then-delta-after-ack: Send → SendResult → unrelated event
 *  - edit-truncate-then-stream: Edit → EditResult{ok:true} → unrelated event
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { reducer, initialArchState, type ArchState } from '../src/host/core/reducer';
import type { Event } from '../src/host/core/events';

// ─── Helpers ────────────────────────────────────────────────────────────────

function sendCommand(corrId: string, sessionPath: string): Event {
  return {
    kind: 'Command',
    cmd: {
      kind: 'Send',
      corrId,
      sessionPath,
      text: 'hello',
      inputs: [],
      composedText: 'hello',
      localId: `local:${corrId}`,
      userParts: [{ kind: 'text', text: 'hello' }],
      previousSummary: null,
    },
  };
}

function editCommand(corrId: string, sessionPath: string): Event {
  return {
    kind: 'Command',
    cmd: {
      kind: 'Edit',
      corrId,
      sessionPath,
      messageId: 'msg-1',
      text: 'edited text',
      localId: `local:${corrId}`,
    },
  };
}

// ─── send-then-success (full round-trip sequence) ───────────────────────────

test('arrival-order: send → success produces pending then clears it', () => {
  // 1. Dispatch Send command.
  const r1 = reducer(initialArchState, sendCommand('c1', '/s'));
  assert.ok(r1.state.pending['c1'], 'pending should exist after Send');
  assert.equal(r1.effects.length, 2);
  assert.equal(r1.effects[0]?.kind, 'InsertOptimisticMessage');
  assert.equal(r1.effects[1]?.kind, 'SendRpc');

  // 2. Dispatch SendResult{ok:true}.
  const r2 = reducer(r1.state, { kind: 'SendResult', corrId: 'c1', sessionPath: '/s', ok: true });
  assert.equal(r2.state.pending['c1'], undefined, 'pending should be cleared after success');
  assert.equal(r2.effects.length, 1);
  assert.equal(r2.effects[0]?.kind, 'ClearComposerInputs');
});

// ─── send-then-failure (full round-trip sequence) ───────────────────────────

test('arrival-order: send → failure rolls back pending and notifies', () => {
  const r1 = reducer(initialArchState, sendCommand('c2', '/s'));
  assert.ok(r1.state.pending['c2']);

  const r2 = reducer(r1.state, { kind: 'SendResult', corrId: 'c2', sessionPath: '/s', ok: false, error: 'network' });
  assert.equal(r2.state.pending['c2'], undefined, 'pending should be cleared on failure');
  const kinds = r2.effects.map((e) => e.kind);
  assert.ok(kinds.includes('RemoveOptimisticMessage'));
  assert.ok(kinds.includes('PostImperative'));
  assert.ok(kinds.includes('SetNotice'));
});

// ─── send-then-delta-before-ack ─────────────────────────────────────────────

test('arrival-order: send → unhandled event (simulated delta) → success — pending preserved through interleaving', () => {
  // 1. Dispatch Send command.
  const r1 = reducer(initialArchState, sendCommand('c3', '/s'));
  assert.ok(r1.state.pending['c3']);

  // 2. An unrecognized event arrives (simulates a streaming delta from the
  //    backend arriving before the SendRpc ack). Since the reducer doesn't
  //    handle it yet (Phase 5), it must return state unchanged.
  const deltaEvent: Event = {
    kind: 'InterruptResult',
    corrId: 'unrelated-corr',
    sessionPath: '/other-session',
    ok: true,
  };
  const r2 = reducer(r1.state, deltaEvent);
  // Pending for 'c3' must survive — the interleaved event must NOT corrupt it.
  assert.ok(r2.state.pending['c3'], 'pending must survive unrelated event');
  assert.equal(r2.state.pending['c3']?.kind, 'send');
  assert.equal(r2.state.pending['c3']?.localId, 'local:c3');

  // 3. Now the actual SendResult arrives — still works correctly.
  const r3 = reducer(r2.state, { kind: 'SendResult', corrId: 'c3', sessionPath: '/s', ok: true });
  assert.equal(r3.state.pending['c3'], undefined, 'pending cleared after ack');
  assert.equal(r3.effects[0]?.kind, 'ClearComposerInputs');
});

test('arrival-order: send → multiple interleaved events → success — pending still intact', () => {
  const r1 = reducer(initialArchState, sendCommand('c4', '/s'));

  // Simulate multiple events arriving while RPC is in-flight.
  let state = r1.state;
  for (let i = 0; i < 5; i++) {
    const interleaved: Event = {
      kind: 'InterruptResult',
      corrId: `noise-${i}`,
      sessionPath: `/unrelated-${i}`,
      ok: true,
    };
    const r = reducer(state, interleaved);
    state = r.state;
  }

  // Pending still intact after 5 interleaved events.
  assert.ok(state.pending['c4'], 'pending survives multiple interleavings');
  assert.equal(state.pending['c4']?.kind, 'send');

  // SendResult still resolves correctly.
  const final = reducer(state, { kind: 'SendResult', corrId: 'c4', sessionPath: '/s', ok: true });
  assert.equal(final.state.pending['c4'], undefined);
});

// ─── send-then-delta-after-ack ──────────────────────────────────────────────

test('arrival-order: send → success → unhandled event — clean state post-ack', () => {
  // Send + ack.
  const r1 = reducer(initialArchState, sendCommand('c5', '/s'));
  const r2 = reducer(r1.state, { kind: 'SendResult', corrId: 'c5', sessionPath: '/s', ok: true });
  assert.equal(r2.state.pending['c5'], undefined);

  // Subsequent event has no pending to corrupt.
  const after: Event = {
    kind: 'InterruptResult',
    corrId: 'later',
    sessionPath: '/other',
    ok: true,
  };
  const r3 = reducer(r2.state, after);
  // State remains clean — no orphan pending entries.
  assert.deepEqual(r3.state.pending, {});
});

// ─── edit-truncate-then-stream ──────────────────────────────────────────────

test('arrival-order: edit → success → unhandled event — edit pending cleared, no corruption', () => {
  // 1. Dispatch Edit command.
  const r1 = reducer(initialArchState, editCommand('c6', '/s'));
  assert.ok(r1.state.pending['c6']);
  assert.equal(r1.state.pending['c6']?.kind, 'edit');
  assert.equal(r1.effects.length, 2);
  assert.equal(r1.effects[0]?.kind, 'InsertOptimisticMessage');
  assert.equal(r1.effects[1]?.kind, 'EditRpc');

  // 2. EditResult{ok:true} arrives (this represents truncate+send succeeding).
  const r2 = reducer(r1.state, { kind: 'EditResult', corrId: 'c6', sessionPath: '/s', ok: true });
  assert.equal(r2.state.pending['c6'], undefined, 'edit pending cleared');
  assert.deepEqual(r2.effects, []);

  // 3. Streaming events arrive after edit ack — state stays clean.
  const stream: Event = {
    kind: 'InterruptResult',
    corrId: 'stream-noise',
    sessionPath: '/s',
    ok: true,
  };
  const r3 = reducer(r2.state, stream);
  assert.deepEqual(r3.state.pending, {});
});

test('arrival-order: edit → interleaved event before ack → success — pending preserved', () => {
  const r1 = reducer(initialArchState, editCommand('c7', '/s'));
  assert.ok(r1.state.pending['c7']);

  // Interleaved event while edit RPC is in-flight.
  const noise: Event = {
    kind: 'SendResult',
    corrId: 'unrelated',
    sessionPath: '/other',
    ok: true,
  };
  const r2 = reducer(r1.state, noise);
  // SendResult for unknown corrId is a no-op, state unchanged.
  assert.ok(r2.state.pending['c7'], 'edit pending survives unrelated SendResult');

  // EditResult arrives correctly.
  const r3 = reducer(r2.state, { kind: 'EditResult', corrId: 'c7', sessionPath: '/s', ok: true });
  assert.equal(r3.state.pending['c7'], undefined);
});

// ─── Concurrent sends on different sessions ─────────────────────────────────

test('arrival-order: two concurrent sends — results resolve independently', () => {
  // Two sends on different sessions, dispatched back-to-back.
  const r1 = reducer(initialArchState, sendCommand('ca', '/session-a'));
  const r2 = reducer(r1.state, sendCommand('cb', '/session-b'));

  assert.ok(r2.state.pending['ca']);
  assert.ok(r2.state.pending['cb']);

  // 'cb' ack arrives first (out-of-order w.r.t. dispatch).
  const r3 = reducer(r2.state, { kind: 'SendResult', corrId: 'cb', sessionPath: '/session-b', ok: true });
  assert.equal(r3.state.pending['cb'], undefined);
  assert.ok(r3.state.pending['ca'], 'ca still pending');

  // 'ca' ack arrives second.
  const r4 = reducer(r3.state, { kind: 'SendResult', corrId: 'ca', sessionPath: '/session-a', ok: true });
  assert.equal(r4.state.pending['ca'], undefined);
  assert.deepEqual(r4.state.pending, {});
});
