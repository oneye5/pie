import test from 'node:test';
import assert from 'node:assert/strict';

import {
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
  pinnedTabPaths: [],
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
  tokenRateBySession: {},
  draftText: '',
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
  fileChangesExpanded: false,
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

test('canPostSnapshotToWebview requires both a view and webviewReady', () => {
  assert.equal(canPostSnapshotToWebview(true, true), true);
  assert.equal(canPostSnapshotToWebview(true, false), false);
  assert.equal(canPostSnapshotToWebview(false, true), false);
  assert.equal(canPostSnapshotToWebview(false, false), false);
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

test('reconcilePostedMessageDelivery marks globalDirty for sendRejected when delivery fails', () => {
  const syncState = createSidebarSyncState('host-1');

  const next = reconcilePostedMessageDelivery(syncState, {
    type: 'sendRejected',
    sessionPath: '/workspace/a.ts',
    text: 'hello',
    localId: 'local-1',
  }, false);

  assert.equal(next.globalDirty, true, 'sendRejected failure should mark globalDirty');
});

test('reconcilePostedMessageDelivery does NOT mark globalDirty for playCompletionSound when delivery fails', () => {
  const syncState = createSidebarSyncState('host-1');

  const next = reconcilePostedMessageDelivery(syncState, {
    type: 'playCompletionSound',
    volume: 50,
  }, false);

  assert.equal(next.globalDirty, false, 'fire-and-forget imperative failure should NOT mark globalDirty');
});
