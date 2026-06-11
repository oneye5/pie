import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPatchEnvelope,
  buildStateEnvelope,
  canPostSnapshotToWebview,
  createSidebarSyncState,
  flushDirtySnapshot,
  reconcilePostedMessageDelivery,
} from '../src/host/sidebar/sync';
import { DEFAULT_CHAT_PREFS, type ViewState } from '../src/shared/protocol';

const baseViewState: ViewState = {
  sessions: [],
  openTabPaths: [],
  runningSessionPaths: [],
  unreadFinishedSessionPaths: [],
  activeSession: null,
  transcript: [],
  transcriptWindow: {
    totalCount: 0,
    loadedStart: 0,
    loadedEnd: 0,
    hasOlder: false,
    hasNewer: false,
    isPartial: false,
    hasUserMessages: false,
  },
  transcriptLoaded: false,
  pendingComposerInputs: [],
  activeRunSummary: null,
  runSummariesBySession: {},
  busy: false,
  notice: null,
  backendReady: true,
  workspaceCwd: '/workspace',
  systemPrompts: [],
  modelSettings: null,
  availableModels: [],
  contextUsage: null,
  prefs: DEFAULT_CHAT_PREFS,
  availableExtensions: [],
  fileChanges: [],
  pruningResult: null,
  pruningSettings: {
    mode: 'auto' as const,
    skillCeiling: 8,
    toolCeiling: 10,
    skillAlwaysKeep: [],
    toolAlwaysKeep: [],
    model: 'gpt-5.4-mini',
    provider: 'github-copilot',
    thinkingLevel: 'minimal' as const,
  },
  pruningCatalog: {
    skills: [],
    tools: [],
  },
  editingMessageId: null,
  showOutcomeDialog: false,
  pendingExtensionUIRequestsBySession: {},
  pendingExtensionUIRequest: null,
};

test('buildPatchEnvelope marks the stream dirty when the view cannot accept patches', () => {
  const syncState = createSidebarSyncState('host-1');

  const result = buildPatchEnvelope(
    syncState,
    '/tmp/session-a',
    { kind: 'messageDelta', messageId: 'm1', delta: 'hello' },
    false,
  );

  assert.equal(result.message, undefined);
  assert.equal(result.nextSyncState.sessions['/tmp/session-a']?.dirty, true);
  assert.equal(result.nextSyncState.sessions['/tmp/session-a']?.revision, 0);
});

test('flushDirtySnapshot posts a full state snapshot once the view is visible again', () => {
  const syncState = { ...createSidebarSyncState('host-1'), globalDirty: true };

  const result = flushDirtySnapshot(syncState, baseViewState, true);

  assert.equal(result.message?.type, 'state');
  if (result.message?.type === 'state') {
    assert.equal(result.message.revision, 1);
  }
  assert.equal(result.nextSyncState.globalDirty, false);
  assert.equal(result.nextSyncState.globalRevision, 1);
});

test('buildStateEnvelope clears dirty state and advances revision when posted', () => {
  const syncState = {
    ...createSidebarSyncState('host-1'),
    globalDirty: true,
    globalRevision: 3,
  };

  const result = buildStateEnvelope(syncState, baseViewState, true);

  assert.equal(result.message?.type, 'state');
  if (result.message?.type === 'state') {
    assert.equal(result.message.revision, 4);
  }
  assert.equal(result.nextSyncState.globalDirty, false);
  assert.equal(result.nextSyncState.globalRevision, 4);
});

test('patch_envelope_addresses_session: envelope carries sessionPath and protocol version', () => {
  const syncState = createSidebarSyncState('host-1');

  const result = buildPatchEnvelope(
    syncState,
    '/tmp/session-x',
    { kind: 'messageDelta', messageId: 'm1', delta: 'hi' },
    true,
  );

  assert.ok(result.message, 'expected an envelope');
  if (result.message?.type === 'patch') {
    assert.equal(result.message.sessionPath, '/tmp/session-x');
    assert.equal(result.message.protocolVersion, 1);
    assert.equal(result.message.revision, 1);
  } else {
    assert.fail('expected patch envelope');
  }
});

test('revision_advances_per_session: independent counters', () => {
  let syncState = createSidebarSyncState('host-1');

  const op = { kind: 'messageDelta' as const, messageId: 'm', delta: 'x' };
  const r1 = buildPatchEnvelope(syncState, '/a', op, true);
  syncState = r1.nextSyncState;
  const r2 = buildPatchEnvelope(syncState, '/a', op, true);
  syncState = r2.nextSyncState;
  const r3 = buildPatchEnvelope(syncState, '/b', op, true);
  syncState = r3.nextSyncState;
  const r4 = buildPatchEnvelope(syncState, '/a', op, true);
  syncState = r4.nextSyncState;

  assert.equal(syncState.sessions['/a']?.revision, 3);
  assert.equal(syncState.sessions['/b']?.revision, 1);
});

test('dirty_stream_per_session: only the affected session is marked dirty', () => {
  let syncState = createSidebarSyncState('host-1');

  const op = { kind: 'messageDelta' as const, messageId: 'm', delta: 'x' };
  // /a posts successfully.
  syncState = buildPatchEnvelope(syncState, '/a', op, true).nextSyncState;
  // /b cannot post (view hidden).
  syncState = buildPatchEnvelope(syncState, '/b', op, false).nextSyncState;

  assert.equal(syncState.sessions['/a']?.dirty, false);
  assert.equal(syncState.sessions['/b']?.dirty, true);
});

test('background_stream_preserved: flushDirtySnapshot fires when a non-active session is dirty', () => {
  let syncState = createSidebarSyncState('host-1');

  const op = { kind: 'messageDelta' as const, messageId: 'm', delta: 'x' };
  // Background session accumulates patches while the view is hidden.
  syncState = buildPatchEnvelope(syncState, '/bg', op, false).nextSyncState;
  syncState = buildPatchEnvelope(syncState, '/bg', op, false).nextSyncState;

  // No global dirty was set, but session is dirty — flush should emit snapshot.
  assert.equal(syncState.globalDirty, false);
  assert.equal(syncState.sessions['/bg']?.dirty, true);

  const flushed = flushDirtySnapshot(syncState, baseViewState, true);
  assert.equal(flushed.message?.type, 'state', 'snapshot must recover dirty session');
  // After snapshot, per-session entries reset.
  assert.equal(flushed.nextSyncState.sessions['/bg'], undefined);
});

test('canPostSnapshotToWebview allows a full snapshot whenever the view exists', () => {
  assert.equal(canPostSnapshotToWebview(true, true), true);
  assert.equal(canPostSnapshotToWebview(true, false), true);
  assert.equal(canPostSnapshotToWebview(false, true), false);
});

test('reconcilePostedMessageDelivery marks global snapshots dirty when delivery fails', () => {
  const syncState = createSidebarSyncState('host-1');

  const next = reconcilePostedMessageDelivery(syncState, {
    type: 'state',
    protocolVersion: 1,
    hostInstanceId: 'host-1',
    revision: 1,
    state: baseViewState,
  }, false);

  assert.equal(next.globalDirty, true);
});

test('reconcilePostedMessageDelivery marks patch streams dirty when delivery fails', () => {
  const syncState = createSidebarSyncState('host-1');

  const next = reconcilePostedMessageDelivery(syncState, {
    type: 'patch',
    protocolVersion: 1,
    hostInstanceId: 'host-1',
    sessionPath: '/a',
    revision: 2,
    op: { kind: 'messageDelta', messageId: 'm1', delta: 'x' },
  }, false);

  assert.equal(next.sessions['/a']?.dirty, true);
});
