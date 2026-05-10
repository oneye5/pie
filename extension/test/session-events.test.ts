/**
 * Phase 1 — Session event semantics tests.
 *
 * Covers behaviours not exercised by store.test.ts: busy-seq dedup, pending
 * tab promotion, session summary name preservation, and prefs round-tripping.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  sessionsActions,
  settingsActions,
  transcriptActions,
  uiActions,
  selectViewState,
} from '../src/host/store';
import { applyPatch, emptyOverlay } from '../src/webview/panel/overlay';

function useStore() {
  return (require('../src/host/store') as typeof import('../src/host/store')).store;
}

// ─── Busy-seq dedup ────────────────────────────────────────────────────────────

/**
 * The host session-service uses a per-session busySeqMap to discard stale
 * busy.changed events. Reproduces the logic inline because the logic lives
 * outside the Redux store.
 */
function acceptBusySeq(map: Map<string, number>, path: string, seq: number | undefined): boolean {
  if (typeof seq !== 'number') return true;
  const last = map.get(path) ?? 0;
  if (seq <= last) return false;
  map.set(path, seq);
  return true;
}

test('busy-seq: accepts events in order and drops out-of-order', () => {
  const m = new Map<string, number>();
  assert.equal(acceptBusySeq(m, '/s', 1), true);
  assert.equal(acceptBusySeq(m, '/s', 2), true);
  assert.equal(acceptBusySeq(m, '/s', 1), false, 'stale event should be rejected');
  assert.equal(acceptBusySeq(m, '/s', 2), false, 'same-seq event should be rejected');
  assert.equal(acceptBusySeq(m, '/s', 3), true);
  assert.equal(acceptBusySeq(m, '/t', 1), true, 'different session has independent counter');
});

test('busy-seq: undefined seq is always accepted (backward-compat)', () => {
  const m = new Map<string, number>();
  m.set('/s', 100);
  assert.equal(acceptBusySeq(m, '/s', undefined), true);
});

// ─── Pending tab promotion ────────────────────────────────────────────────────

test('pending tab is promoted to real path on session.opened', () => {
  const store = useStore();

  const pendingPath = '__pending__:test-1234';
  const realPath = '/ws/sessions/abc.jsonl';

  // Simulate service creating pending tab.
  store.dispatch(sessionsActions.upsertSession({
    path: pendingPath,
    name: 'New Session',
    cwd: '/ws',
    modifiedAt: new Date().toISOString(),
    messageCount: 0,
    isPlaceholder: true,
  }));
  store.dispatch(sessionsActions.ensureOpenTab(pendingPath));

  // Simulate session.opened handler replacing the pending tab.
  store.dispatch(sessionsActions.replaceOpenTabPath({ oldPath: pendingPath, newPath: realPath }));
  store.dispatch(sessionsActions.removePendingSessions());
  store.dispatch(sessionsActions.upsertSession({
    path: realPath,
    name: 'New Session',
    cwd: '/ws',
    modifiedAt: new Date().toISOString(),
    messageCount: 0,
    isPlaceholder: true,
  }));

  const { openTabPaths, sessions } = store.getState().sessions;
  assert.ok(!openTabPaths.includes(pendingPath), 'pending tab should be gone');
  assert.ok(openTabPaths.includes(realPath), 'real path should be in tabs');
  assert.ok(!sessions.some((s) => s.path === pendingPath), 'pending session should be removed');
  assert.ok(sessions.some((s) => s.path === realPath), 'real session should be present');
});

// ─── Session summary name preservation ────────────────────────────────────────

test('replaceSessionSummaries preserves real name over incoming placeholder', () => {
  const store = useStore();

  const path = '/ws/name-preserve-test';
  // Establish a session with a real (non-placeholder) name.
  store.dispatch(sessionsActions.upsertSession({
    path,
    name: 'My Real Session',
    cwd: '/ws',
    modifiedAt: new Date().toISOString(),
    messageCount: 1,
    isPlaceholder: false,
  }));

  // Backend emits a list refresh where the name reverted to a placeholder.
  store.dispatch(sessionsActions.replaceSessionSummaries([{
    path,
    name: 'New Session',
    cwd: '/ws',
    modifiedAt: new Date().toISOString(),
    messageCount: 1,
    isPlaceholder: true,
  }]));

  const session = store.getState().sessions.sessions.find((s) => s.path === path);
  assert.ok(session, 'session should still exist');
  assert.equal(session?.name, 'My Real Session', 'real name should be preserved over placeholder');
});

test('replaceSessionSummaries updates name when incoming is not a placeholder', () => {
  const store = useStore();

  const path = '/ws/name-update-test';
  store.dispatch(sessionsActions.upsertSession({
    path,
    name: 'Old Name',
    cwd: '/ws',
    modifiedAt: new Date().toISOString(),
    messageCount: 0,
    isPlaceholder: false,
  }));

  store.dispatch(sessionsActions.replaceSessionSummaries([{
    path,
    name: 'New Real Name',
    cwd: '/ws',
    modifiedAt: new Date().toISOString(),
    messageCount: 2,
    isPlaceholder: false,
  }]));

  const session = store.getState().sessions.sessions.find((s) => s.path === path);
  assert.equal(session?.name, 'New Real Name');
  assert.equal(session?.messageCount, 2);
});

// ─── Chat prefs ───────────────────────────────────────────────────────────────

test('uiActions.setPrefs merges into existing prefs', () => {
  const store = useStore();

  store.dispatch(uiActions.setPrefs({ autoExpandReasoning: false, autoExpandToolCalls: false }));
  store.dispatch(uiActions.setPrefs({ autoExpandReasoning: true }));

  const { prefs } = store.getState().ui;
  assert.equal(prefs.autoExpandReasoning, true);
  assert.equal(prefs.autoExpandToolCalls, false, 'unchanged pref should not be modified');
});

// ─── selectViewState prefs round-trip ──────────────────────────────────────────

test('selectViewState includes prefs from ui slice', () => {
  const store = useStore();

  store.dispatch(uiActions.setPrefs({ autoExpandReasoning: true, autoExpandToolCalls: true }));

  const viewState = selectViewState(store.getState());
  assert.equal(viewState.prefs.autoExpandReasoning, true);
  assert.equal(viewState.prefs.autoExpandToolCalls, true);
});

// ─── Overlay / gap-detection logic ──────────────────────────────────────────

test('overlay preserves mixed assistant-part ordering', () => {
  let overlay = emptyOverlay();

  overlay = applyPatch(overlay, { kind: 'messageThinking', messageId: 'm1', thinking: 'plan' });
  overlay = applyPatch(overlay, {
    kind: 'toolCall',
    messageId: 'm1',
    toolCall: { id: 'tc-1', name: 'write', input: { path: 'a.txt' }, status: 'running' },
  });
  overlay = applyPatch(overlay, { kind: 'messageDelta', messageId: 'm1', delta: 'after tool' });
  overlay = applyPatch(overlay, {
    kind: 'toolCall',
    messageId: 'm1',
    toolCall: { id: 'tc-1', name: 'write', input: { path: 'a.txt' }, status: 'completed', result: 'ok' },
  });

  assert.deepEqual(
    overlay.partsByMessage.get('m1')?.map((part) =>
      part.kind === 'toolCall'
        ? `${part.kind}:${part.toolCall.id}:${part.toolCall.status}`
        : `${part.kind}:${part.text}`,
    ),
    ['reasoning:plan', 'toolCall:tc-1:completed', 'text:after tool'],
  );
});

test('overlay clears targeted and untargeted entries', () => {
  let overlay = emptyOverlay();
  overlay = applyPatch(overlay, { kind: 'messageDelta', messageId: 'm1', delta: 'a' });
  overlay = applyPatch(overlay, { kind: 'messageDelta', messageId: 'm2', delta: 'b' });

  overlay = applyPatch(overlay, { kind: 'clearOverlay', messageIds: ['m1'] });
  assert.equal(overlay.partsByMessage.has('m1'), false, 'm1 should be cleared');
  assert.equal(overlay.partsByMessage.get('m2')?.[0]?.kind, 'text', 'm2 should remain');

  overlay = applyPatch(overlay, { kind: 'clearOverlay' });
  assert.equal(overlay.partsByMessage.size, 0);
});

test('edit rerun keeps an optimistic user row until the authoritative snapshot arrives', () => {
  const store = useStore();
  const sessionPath = '/ws/edit-rerun-test';

  store.dispatch(transcriptActions.setTranscript({
    sessionPath,
    transcript: [
      { id: 'user-1', role: 'user', createdAt: '', markdown: 'Original prompt', status: 'completed' },
      { id: 'assistant-1', role: 'assistant', createdAt: '', markdown: 'Original reply', status: 'completed' },
    ],
  }));

  // session.truncateAfter emits a snapshot that removes the edited row and tail.
  store.dispatch(transcriptActions.setTranscript({ sessionPath, transcript: [] }));
  store.dispatch(transcriptActions.appendLocalUserMessage({
    sessionPath,
    id: 'local:edit:1',
    text: 'Original prompt ',
  }));

  let transcript = store.getState().transcript.bySession[sessionPath] ?? [];
  assert.equal(transcript.length, 1, 'edited prompt should remain visible during rerun');
  assert.equal(transcript[0]?.role, 'user');
  assert.equal(transcript[0]?.markdown, 'Original prompt ');

  // agent_end emits a fresh session.opened snapshot that replaces the optimistic row.
  store.dispatch(transcriptActions.setTranscript({
    sessionPath,
    transcript: [
      { id: 'user-2', role: 'user', createdAt: '', markdown: 'Original prompt ', status: 'completed' },
      { id: 'assistant-2', role: 'assistant', createdAt: '', markdown: 'New reply', status: 'completed' },
    ],
  }));

  transcript = store.getState().transcript.bySession[sessionPath] ?? [];
  assert.deepEqual(transcript.map((message) => message.id), ['user-2', 'assistant-2']);
  assert.equal(transcript[0]?.markdown, 'Original prompt ');
});
