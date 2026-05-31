import test from 'node:test';
import assert from 'node:assert/strict';

import { publishBackendReady } from '../src/host/session-service/backend-ready';
import { buildRestoredSessionSummaries } from '../src/host/session-service/restored-session-summaries';
import { sessionsActions, store, uiActions } from '../src/host/store';

function resetStartupStoreState(): void {
  store.dispatch(uiActions.setBackendReady(false));
  store.dispatch(uiActions.setNotice(null));
  store.dispatch(sessionsActions.setWorkspaceCwd(null));
  store.dispatch(sessionsActions.replaceSessionSummaries([]));
  store.dispatch(sessionsActions.setOpenTabPaths([]));
  store.dispatch(sessionsActions.clearActiveSession());
  store.dispatch(sessionsActions.clearRunningPaths());
}

test('buildRestoredSessionSummaries creates placeholders for string-only restored tabs', () => {
  const summaries = buildRestoredSessionSummaries(
    ['/workspace/a.jsonl'],
    ['/workspace/a.jsonl'],
    '/workspace',
    '2026-01-01T00:00:00.000Z',
  );

  assert.deepEqual(summaries, [{
    path: '/workspace/a.jsonl',
    name: 'Loading...',
    isPlaceholder: true,
    cwd: '/workspace',
    modifiedAt: '2026-01-01T00:00:00.000Z',
    messageCount: 0,
  }]);
});

test('buildRestoredSessionSummaries preserves persisted tab names', () => {
  const summaries = buildRestoredSessionSummaries(
    [{ path: '/workspace/a.jsonl', name: 'Fix startup' }],
    ['/workspace/a.jsonl'],
    '/workspace',
    '2026-01-01T00:00:00.000Z',
  );

  assert.equal(summaries[0]?.name, 'Fix startup');
  assert.equal(summaries[0]?.isPlaceholder, false);
});

test('publishBackendReady sets backendReady before restore open and keeps it true on restore failure', () => {
  resetStartupStoreState();

  const calls: string[] = [];
  const failure = publishBackendReady({
    scheduleRender: () => {
      calls.push(`render:${store.getState().ui.backendReady}`);
    },
    openSession: () => {
      calls.push(`open:${store.getState().ui.backendReady}`);
      throw new Error('boom');
    },
    preloadSessions: () => {
      calls.push('preload');
    },
    restoredStartupPath: '/workspace/a.jsonl',
    preloadPaths: ['/workspace/b.jsonl'],
  });

  assert.equal(failure?.message, 'boom');
  assert.deepEqual(calls, ['render:true', 'open:true', 'render:true']);
  assert.equal(store.getState().ui.backendReady, true);
  assert.equal(store.getState().ui.notice, 'Failed to restore session: boom');

  resetStartupStoreState();
});