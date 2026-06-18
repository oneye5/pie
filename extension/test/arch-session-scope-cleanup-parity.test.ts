/**
 * Parity tests for per-session keyed map cleanup between
 * `handleSessionScopeCleared` (tab-close path) and `removeSessionFromState`
 * (full-eviction path).
 *
 * Bug: Each function cleaned a different subset of per-session keyed maps —
 * 4 maps were missing from each. This caused stale state on
 * tab close → reopen cycles.
 *
 * `handleSessionScopeCleared` was MISSING:
 *   - transcript.editingMessageIdBySession
 *   - sessions.interruptInFlightBySession
 *   - settings.showOutcomeDialogBySession
 *   - pending.currentTurnBySession
 *
 * `removeSessionFromState` was MISSING:
 *   - transcript.pagingInFlightBySession
 *   - pending.sendQueueBySession
 *   - pending.backendReadyQueueBySession
 *   - pending.setModelByCorrId
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { reducer, initialArchState, type ArchState } from '../src/host/core/reducer';
import type { Event } from '../src/host/core/events';
import { removeSessionFromState } from '../src/host/core/reducer/helpers';
import type { SessionSummary, ModelSettings, ComposerInput, ExtensionUIRequestPayload } from '../src/shared/protocol';
import type {
  CurrentTurn,
  PendingSendQueueEntry,
  BackendReadyQueueEntry,
  SetModelPending,
} from '../src/host/core/arch-state';

const readyState: ArchState = {
  ...initialArchState,
  settings: { ...initialArchState.settings, backendReady: true },
};

function summary(path: string): SessionSummary {
  return {
    path,
    name: 'Test',
    cwd: '/workspace',
    modifiedAt: '2024-01-01T00:00:00.000Z',
    messageCount: 0,
    isPlaceholder: false,
  };
}

function sessionScopeCleared(sessionPath: string, removeSessionSummary: boolean): Event {
  return { kind: 'SessionScopeCleared', sessionPath, removeSessionSummary };
}

const defaultModelSettings: ModelSettings = {
  model: 'claude-test',
  baseURL: null,
  apiKey: null,
  envKey: null,
  smallModel: null,
  permissionMode: 'default',
  includes: [],
} as unknown as ModelSettings;

function currentTurn(sessionPath: string): CurrentTurn {
  return { requestId: `req-${sessionPath}`, firstMessageId: `msg-${sessionPath}` };
}

function sendQueueEntry(sessionPath: string): PendingSendQueueEntry {
  return {
    corrId: `corr-${sessionPath}`,
    text: 'hi',
    inputs: [] as ComposerInput[],
    composedText: 'hi',
    localId: `local-${sessionPath}`,
    userParts: undefined,
    previousSummary: null,
    timestamp: 1,
  };
}

function backendReadyEntry(sessionPath: string): BackendReadyQueueEntry {
  return {
    sessionPath,
    corrId: `bcorr-${sessionPath}`,
    text: 'hi',
    inputs: [] as ComposerInput[],
    composedText: 'hi',
    localId: `blocal-${sessionPath}`,
    userParts: undefined,
    previousSummary: null,
    timestamp: 1,
  };
}

function setModelPending(sessionPath: string): SetModelPending {
  return {
    sessionPath,
    modelSettings: defaultModelSettings,
    snapshot: null,
  };
}

const extUiPayload = {} as unknown as ExtensionUIRequestPayload;

// ─── handleSessionScopeCleared (tab-close path) ─────────────────────────────

test('handleSessionScopeCleared cleans editingMessageIdBySession', () => {
  const state: ArchState = {
    ...readyState,
    transcript: {
      ...readyState.transcript,
      editingMessageIdBySession: { '/a': 'msg-1' },
    },
  };
  const result = reducer(state, sessionScopeCleared('/a', false));
  assert.equal(result.state.transcript.editingMessageIdBySession['/a'], undefined);
});

test('handleSessionScopeCleared cleans interruptInFlightBySession', () => {
  const state: ArchState = {
    ...readyState,
    sessions: {
      ...readyState.sessions,
      interruptInFlightBySession: { '/a': true },
    },
  };
  const result = reducer(state, sessionScopeCleared('/a', false));
  assert.equal(result.state.sessions.interruptInFlightBySession['/a'], undefined);
});

test('handleSessionScopeCleared cleans showOutcomeDialogBySession', () => {
  const state: ArchState = {
    ...readyState,
    settings: {
      ...readyState.settings,
      showOutcomeDialogBySession: { '/a': true },
    },
  };
  const result = reducer(state, sessionScopeCleared('/a', false));
  assert.equal(result.state.settings.showOutcomeDialogBySession['/a'], undefined);
});

test('handleSessionScopeCleared cleans currentTurnBySession', () => {
  const state: ArchState = {
    ...readyState,
    pending: {
      ...readyState.pending,
      currentTurnBySession: { '/a': currentTurn('/a') },
    },
  };
  const result = reducer(state, sessionScopeCleared('/a', false));
  assert.equal(result.state.pending.currentTurnBySession['/a'], undefined);
});

test('handleSessionScopeCleared preserves maps for other sessions', () => {
  const state: ArchState = {
    ...readyState,
    transcript: {
      ...readyState.transcript,
      editingMessageIdBySession: { '/a': 'msg-a', '/b': 'msg-b' },
    },
    sessions: {
      ...readyState.sessions,
      interruptInFlightBySession: { '/a': true, '/b': false },
    },
    settings: {
      ...readyState.settings,
      showOutcomeDialogBySession: { '/a': true, '/b': false },
    },
    pending: {
      ...readyState.pending,
      currentTurnBySession: { '/a': currentTurn('/a'), '/b': currentTurn('/b') },
    },
  };
  const result = reducer(state, sessionScopeCleared('/a', false));
  assert.equal(result.state.transcript.editingMessageIdBySession['/a'], undefined);
  assert.equal(result.state.transcript.editingMessageIdBySession['/b'], 'msg-b');
  assert.equal(result.state.sessions.interruptInFlightBySession['/a'], undefined);
  assert.equal(result.state.sessions.interruptInFlightBySession['/b'], false);
  assert.equal(result.state.settings.showOutcomeDialogBySession['/a'], undefined);
  assert.equal(result.state.settings.showOutcomeDialogBySession['/b'], false);
  assert.equal(result.state.pending.currentTurnBySession['/a'], undefined);
  assert.deepEqual(result.state.pending.currentTurnBySession['/b'], currentTurn('/b'));
});

// ─── removeSessionFromState (full-eviction path) ────────────────────────────

test('removeSessionFromState cleans pagingInFlightBySession', () => {
  const state: ArchState = {
    ...readyState,
    transcript: {
      ...readyState.transcript,
      pagingInFlightBySession: { '/a': 'corr-1' },
    },
  };
  const result = removeSessionFromState(state, '/a');
  assert.equal(result.state.transcript.pagingInFlightBySession['/a'], undefined);
});

test('removeSessionFromState cleans sendQueueBySession', () => {
  const state: ArchState = {
    ...readyState,
    pending: {
      ...readyState.pending,
      sendQueueBySession: { '/a': [sendQueueEntry('/a')] },
    },
  };
  const result = removeSessionFromState(state, '/a');
  assert.equal(result.state.pending.sendQueueBySession['/a'], undefined);
});

test('removeSessionFromState cleans backendReadyQueueBySession', () => {
  const state: ArchState = {
    ...readyState,
    pending: {
      ...readyState.pending,
      backendReadyQueueBySession: { '/a': [backendReadyEntry('/a')] },
    },
  };
  const result = removeSessionFromState(state, '/a');
  assert.equal(result.state.pending.backendReadyQueueBySession['/a'], undefined);
});

test('removeSessionFromState cleans setModelByCorrId', () => {
  const state: ArchState = {
    ...readyState,
    pending: {
      ...readyState.pending,
      setModelByCorrId: {
        'corr-1': setModelPending('/a'),
        'corr-2': setModelPending('/b'),
      },
    },
  };
  const result = removeSessionFromState(state, '/a');
  assert.equal(result.state.pending.setModelByCorrId['corr-1'], undefined);
  assert.deepEqual(result.state.pending.setModelByCorrId['corr-2'], setModelPending('/b'));
});

test('removeSessionFromState preserves maps for other sessions', () => {
  const state: ArchState = {
    ...readyState,
    transcript: {
      ...readyState.transcript,
      pagingInFlightBySession: { '/a': 'corr-a', '/b': 'corr-b' },
    },
    pending: {
      ...readyState.pending,
      sendQueueBySession: { '/a': [sendQueueEntry('/a')], '/b': [sendQueueEntry('/b')] },
      backendReadyQueueBySession: { '/a': [backendReadyEntry('/a')], '/b': [backendReadyEntry('/b')] },
      setModelByCorrId: {
        'corr-a': setModelPending('/a'),
        'corr-b': setModelPending('/b'),
      },
    },
  };
  const result = removeSessionFromState(state, '/a');
  assert.equal(result.state.transcript.pagingInFlightBySession['/a'], undefined);
  assert.equal(result.state.transcript.pagingInFlightBySession['/b'], 'corr-b');
  assert.equal(result.state.pending.sendQueueBySession['/a'], undefined);
  assert.deepEqual(result.state.pending.sendQueueBySession['/b'], [sendQueueEntry('/b')]);
  assert.equal(result.state.pending.backendReadyQueueBySession['/a'], undefined);
  assert.deepEqual(result.state.pending.backendReadyQueueBySession['/b'], [backendReadyEntry('/b')]);
  assert.equal(result.state.pending.setModelByCorrId['corr-a'], undefined);
  assert.deepEqual(result.state.pending.setModelByCorrId['corr-b'], setModelPending('/b'));
});

// ─── Parity: both functions clean the same set of per-session keyed maps ────

test('Both functions clean the same set of per-session keyed maps', () => {
  const sp = '/a';
  const other = '/b';

  // Build a rich state with entries for `/a` in EVERY per-session keyed map.
  const base: ArchState = {
    ...readyState,
    transcript: {
      ...readyState.transcript,
      bySession: {
        ...readyState.transcript.bySession,
        [sp]: [],
        [other]: [],
      },
      systemPromptsBySession: {
        ...readyState.transcript.systemPromptsBySession,
        [sp]: [],
        [other]: [],
      },
      windowBySession: {
        ...readyState.transcript.windowBySession,
        [sp]: readyState.transcript.windowBySession.__never__ ?? ({} as never),
        [other]: {} as never,
      },
      editingMessageIdBySession: { [sp]: 'msg-1', [other]: 'msg-2' },
      pagingInFlightBySession: { [sp]: 'corr-1', [other]: 'corr-2' },
    },
    sessions: {
      ...readyState.sessions,
      sessions: [summary(sp), summary(other)],
      openTabPaths: [sp, other],
      runningSessionPaths: [sp],
      unreadFinishedSessionPaths: [sp],
      activeSessionPath: sp,
      analyticsFactorsBySession: { [sp]: null, [other]: null },
      interruptInFlightBySession: { [sp]: true, [other]: false },
    },
    settings: {
      ...readyState.settings,
      availableModelsBySession: { [sp]: [], [other]: [] },
      contextUsageBySession: { [sp]: {} as never, [other]: {} as never },
      showOutcomeDialogBySession: { [sp]: true, [other]: false },
      pendingExtensionUIRequestsBySession: {
        [sp]: { req1: extUiPayload },
        [other]: { req2: extUiPayload },
      },
    },
    composer: {
      ...readyState.composer,
      pendingComposerInputsBySession: { [sp]: [], [other]: [] },
      activeRunSummaryBySession: { [sp]: null, [other]: null },
    },
    fileChanges: {
      ...readyState.fileChanges,
      bySession: { [sp]: [], [other]: [] },
    },
    pending: {
      ...readyState.pending,
      ops: { 'op-1': { sessionPath: sp } as never },
      requestIdToLocalId: { 'r1': { sessionPath: sp, localId: 'l1' } },
      currentTurnBySession: { [sp]: currentTurn(sp), [other]: currentTurn(other) },
      setModelByCorrId: { 'sm-1': setModelPending(sp), 'sm-2': setModelPending(other) },
      sendQueueBySession: { [sp]: [sendQueueEntry(sp)], [other]: [sendQueueEntry(other)] },
      backendReadyQueueBySession: { [sp]: [backendReadyEntry(sp)], [other]: [backendReadyEntry(other)] },
    },
  };

  // Run handleSessionScopeCleared via the reducer (removeSessionSummary=true
  // exercises the full eviction-equivalent branch).
  const cleared = reducer(base, sessionScopeCleared(sp, true));
  // Run removeSessionFromState directly.
  const evicted = removeSessionFromState(base, sp);

  // Collect every per-session keyed map and check both results have no `/a`.
  const checks: Array<{ name: string; map: Record<string, unknown> }> = [
    { name: 'transcript.bySession', map: cleared.state.transcript.bySession },
    { name: 'transcript.systemPromptsBySession', map: cleared.state.transcript.systemPromptsBySession },
    { name: 'transcript.windowBySession', map: cleared.state.transcript.windowBySession },
    { name: 'transcript.editingMessageIdBySession', map: cleared.state.transcript.editingMessageIdBySession },
    { name: 'transcript.pagingInFlightBySession', map: cleared.state.transcript.pagingInFlightBySession },
    { name: 'sessions.analyticsFactorsBySession', map: cleared.state.sessions.analyticsFactorsBySession },
    { name: 'sessions.interruptInFlightBySession', map: cleared.state.sessions.interruptInFlightBySession },
    { name: 'settings.availableModelsBySession', map: cleared.state.settings.availableModelsBySession },
    { name: 'settings.contextUsageBySession', map: cleared.state.settings.contextUsageBySession },
    { name: 'settings.showOutcomeDialogBySession', map: cleared.state.settings.showOutcomeDialogBySession },
    { name: 'settings.pendingExtensionUIRequestsBySession', map: cleared.state.settings.pendingExtensionUIRequestsBySession },
    { name: 'composer.pendingComposerInputsBySession', map: cleared.state.composer.pendingComposerInputsBySession },
    { name: 'composer.activeRunSummaryBySession', map: cleared.state.composer.activeRunSummaryBySession },
    { name: 'fileChanges.bySession', map: cleared.state.fileChanges.bySession },
    { name: 'pending.currentTurnBySession', map: cleared.state.pending.currentTurnBySession },
    { name: 'pending.sendQueueBySession', map: cleared.state.pending.sendQueueBySession },
    { name: 'pending.backendReadyQueueBySession', map: cleared.state.pending.backendReadyQueueBySession },
  ];

  for (const { name, map } of checks) {
    assert.equal(
      map[sp],
      undefined,
      `handleSessionScopeCleared left stale entry in ${name}[${sp}]`,
    );
  }

  // setModelByCorrId and ops / requestIdToLocalId are keyed by corrId/requestId;
  // verify no entry references `/a`.
  for (const [corrId, entry] of Object.entries(cleared.state.pending.setModelByCorrId)) {
    assert.notEqual(
      (entry as SetModelPending).sessionPath,
      sp,
      `handleSessionScopeCleared left stale setModelByCorrId[${corrId}] referencing ${sp}`,
    );
  }
  for (const [corrId, op] of Object.entries(cleared.state.pending.ops)) {
    assert.notEqual(
      (op as { sessionPath: string }).sessionPath,
      sp,
      `handleSessionScopeCleared left stale ops[${corrId}] referencing ${sp}`,
    );
  }
  for (const [reqId, mapping] of Object.entries(cleared.state.pending.requestIdToLocalId)) {
    assert.notEqual(
      (mapping as { sessionPath: string }).sessionPath,
      sp,
      `handleSessionScopeCleared left stale requestIdToLocalId[${reqId}] referencing ${sp}`,
    );
  }

  // Same checks for removeSessionFromState.
  for (const { name, map } of checks) {
    assert.equal(
      map[sp],
      undefined,
      `removeSessionFromState left stale entry in ${name}[${sp}]`,
    );
  }
  for (const [corrId, entry] of Object.entries(evicted.state.pending.setModelByCorrId)) {
    assert.notEqual(
      (entry as SetModelPending).sessionPath,
      sp,
      `removeSessionFromState left stale setModelByCorrId[${corrId}] referencing ${sp}`,
    );
  }
  for (const [corrId, op] of Object.entries(evicted.state.pending.ops)) {
    assert.notEqual(
      (op as { sessionPath: string }).sessionPath,
      sp,
      `removeSessionFromState left stale ops[${corrId}] referencing ${sp}`,
    );
  }
  for (const [reqId, mapping] of Object.entries(evicted.state.pending.requestIdToLocalId)) {
    assert.notEqual(
      (mapping as { sessionPath: string }).sessionPath,
      sp,
      `removeSessionFromState left stale requestIdToLocalId[${reqId}] referencing ${sp}`,
    );
  }
});
