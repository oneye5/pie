import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_CHAT_PREFS,
  PROTOCOL_VERSION,
  type HostToWebviewMessage,
  type PatchOp,
  type WebviewToHostMessage,
} from '../src/shared/protocol';

// ---------------------------------------------------------------------------
// Protocol contract: PROTOCOL_VERSION is a positive integer that the host and
// backend must agree on. Bumps require a coordinated change.
// ---------------------------------------------------------------------------

test('PROTOCOL_VERSION is a positive integer', () => {
  assert.equal(typeof PROTOCOL_VERSION, 'number');
  assert.ok(Number.isInteger(PROTOCOL_VERSION));
  assert.ok(PROTOCOL_VERSION >= 1);
});

test('DEFAULT_CHAT_PREFS shape', () => {
  assert.equal(typeof DEFAULT_CHAT_PREFS.autoExpandReasoning, 'boolean');
  assert.equal(typeof DEFAULT_CHAT_PREFS.autoExpandToolCalls, 'boolean');
});

// ---------------------------------------------------------------------------
// Snapshot envelope contract: every state and patch carries hostInstanceId +
// revision. The webview uses these to detect host-side counter resets and
// missed patches respectively.
// ---------------------------------------------------------------------------

test('HostToWebviewMessage state envelope carries hostInstanceId and revision', () => {
  const msg: HostToWebviewMessage = {
    type: 'state',
    hostInstanceId: 'abc',
    revision: 7,
    state: {
      sessions: [],
      openTabPaths: [],
      runningSessionPaths: [],
      activeSession: null,
      transcript: [],
      busy: false,
      notice: null,
      workspaceCwd: null,
      systemPrompt: null,
      modelSettings: null,
      availableModels: [],
      prefs: DEFAULT_CHAT_PREFS,
    },
  };
  assert.equal(msg.type, 'state');
  assert.equal(msg.hostInstanceId, 'abc');
  assert.equal(msg.revision, 7);
});

test('HostToWebviewMessage patch envelope carries hostInstanceId and revision', () => {
  const msg: HostToWebviewMessage = {
    type: 'patch',
    hostInstanceId: 'abc',
    revision: 8,
    op: { kind: 'messageDelta', messageId: 'm1', delta: 'hello' },
  };
  assert.equal(msg.type, 'patch');
  if (msg.type === 'patch') {
    assert.equal(msg.op.kind, 'messageDelta');
  }
});

// ---------------------------------------------------------------------------
// Overlay clear contract: host sends `clearOverlay` to instruct the webview
// to drop streaming bytes for specific messages once the snapshot has been
// updated. An undefined `messageIds` means clear all overlays.
// ---------------------------------------------------------------------------

test('PatchOp.clearOverlay accepts targeted and untargeted forms', () => {
  const targeted: PatchOp = { kind: 'clearOverlay', messageIds: ['m1', 'm2'] };
  const all: PatchOp = { kind: 'clearOverlay' };
  assert.equal(targeted.kind, 'clearOverlay');
  assert.deepEqual((targeted as { messageIds: string[] }).messageIds, ['m1', 'm2']);
  assert.equal(all.kind, 'clearOverlay');
});

// ---------------------------------------------------------------------------
// busy-seq dedup contract: BusyChangedPayload may carry a `seq` counter that
// monotonically increases per session. The host drops events whose seq is
// less than or equal to the last accepted value to ignore re-orderings.
// ---------------------------------------------------------------------------

function acceptBusySeq(state: Map<string, number>, sessionPath: string, seq: number | undefined): boolean {
  if (typeof seq !== 'number') return true;
  const last = state.get(sessionPath) ?? 0;
  if (seq <= last) return false;
  state.set(sessionPath, seq);
  return true;
}

test('busy-seq dedup ignores out-of-order events but accepts unordered (no seq)', () => {
  const state = new Map<string, number>();
  assert.equal(acceptBusySeq(state, '/a', 1), true);
  assert.equal(acceptBusySeq(state, '/a', 2), true);
  // Stale event from an earlier dispatch arrives late.
  assert.equal(acceptBusySeq(state, '/a', 1), false);
  // Same seq is also dropped.
  assert.equal(acceptBusySeq(state, '/a', 2), false);
  // Higher seq accepted.
  assert.equal(acceptBusySeq(state, '/a', 3), true);
  // Different session has independent counter.
  assert.equal(acceptBusySeq(state, '/b', 1), true);
  // Missing seq is always accepted (backward-compat).
  assert.equal(acceptBusySeq(state, '/a', undefined), true);
});

// ---------------------------------------------------------------------------
// Webview-to-host setPrefs envelope: prefs now live on the host (globalState)
// and changes flow as a typed RPC, replacing the old localStorage path.
// ---------------------------------------------------------------------------

test('WebviewToHostMessage.setPrefs accepts partial pref updates', () => {
  const msg: WebviewToHostMessage = {
    type: 'setPrefs',
    prefs: { autoExpandReasoning: true },
  };
  assert.equal(msg.type, 'setPrefs');
  if (msg.type === 'setPrefs') {
    assert.equal(msg.prefs.autoExpandReasoning, true);
  }
});
