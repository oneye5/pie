import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPatchEnvelope,
  buildStateEnvelope,
  createSidebarSyncState,
  flushDirtySnapshot,
} from '../src/host/sidebar-sync';
import { DEFAULT_CHAT_PREFS, type ViewState } from '../src/shared/protocol';

const baseViewState: ViewState = {
  sessions: [],
  openTabPaths: [],
  runningSessionPaths: [],
  activeSession: null,
  transcript: [],
  busy: false,
  notice: null,
  backendReady: true,
  workspaceCwd: '/workspace',
  systemPrompts: [],
  modelSettings: null,
  availableModels: [],
  contextUsage: null,
  prefs: DEFAULT_CHAT_PREFS,
};

test('buildPatchEnvelope marks the stream dirty when the view cannot accept patches', () => {
  const syncState = createSidebarSyncState('host-1');

  const result = buildPatchEnvelope(
    syncState,
    { kind: 'messageDelta', messageId: 'm1', delta: 'hello' },
    false,
  );

  assert.equal(result.message, undefined);
  assert.equal(result.nextSyncState.dirty, true);
  assert.equal(result.nextSyncState.revision, 0);
});

test('flushDirtySnapshot posts a full state snapshot once the view is visible again', () => {
  const syncState = { ...createSidebarSyncState('host-1'), dirty: true };

  const result = flushDirtySnapshot(syncState, baseViewState, true);

  assert.equal(result.message?.type, 'state');
  if (result.message?.type === 'state') {
    assert.equal(result.message.revision, 1);
  }
  assert.equal(result.nextSyncState.dirty, false);
  assert.equal(result.nextSyncState.revision, 1);
});

test('buildStateEnvelope clears dirty state and advances revision when posted', () => {
  const syncState = { ...createSidebarSyncState('host-1'), dirty: true, revision: 3 };

  const result = buildStateEnvelope(syncState, baseViewState, true);

  assert.equal(result.message?.type, 'state');
  if (result.message?.type === 'state') {
    assert.equal(result.message.revision, 4);
  }
  assert.equal(result.nextSyncState.dirty, false);
  assert.equal(result.nextSyncState.revision, 4);
});
