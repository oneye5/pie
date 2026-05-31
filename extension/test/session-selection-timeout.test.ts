import test from 'node:test';
import assert from 'node:assert/strict';

import { SessionServiceState } from '../src/host/session-service/state';
import { sessionsActions, store, uiActions } from '../src/host/store';

function createExtensionContext() {
  return {
    globalState: {
      update: async () => undefined,
    },
    workspaceState: {
      update: async () => undefined,
    },
  } as any;
}

function resetSelectionTimeoutStoreState(): void {
  store.dispatch(uiActions.setNotice(null));
  store.dispatch(uiActions.setBackendReady(false));
  store.dispatch(sessionsActions.replaceSessionSummaries([]));
  store.dispatch(sessionsActions.setOpenTabPaths([]));
  store.dispatch(sessionsActions.clearActiveSession());
  store.dispatch(sessionsActions.clearRunningPaths());
  store.dispatch(sessionsActions.clearUnreadFinishedSessions());
  store.dispatch(sessionsActions.setWorkspaceCwd(null));
}

async function waitFor(predicate: () => boolean, attempts = 40): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('Timed out waiting for predicate to become true.');
}

test('selection timeout clears pending tab and surfaces a notice', async () => {
  resetSelectionTimeoutStoreState();

  const backend = { request: async () => undefined } as any;
  const context = createExtensionContext();
  let renderCount = 0;
  const state = new SessionServiceState(context, backend, () => {
    renderCount += 1;
  }, 15);

  const pendingPath = `__pending__:selection-timeout-${Date.now()}`;
  store.dispatch(sessionsActions.upsertSession({
    path: pendingPath,
    name: 'Loading...',
    isPlaceholder: true,
    cwd: '',
    modifiedAt: new Date().toISOString(),
    messageCount: 0,
  }));
  store.dispatch(sessionsActions.ensureOpenTab(pendingPath));
  store.dispatch(sessionsActions.setActiveSessionPath(pendingPath));

  const token = state.beginSelectionRequest(pendingPath, pendingPath, false, true);

  await waitFor(() => {
    const notice = store.getState().ui.notice;
    return typeof notice === 'string' && notice.includes('Timed out waiting to create session');
  });

  const sessionsState = store.getState().sessions;
  assert.equal(state.getSelectionRequest(token), null);
  assert.equal(sessionsState.openTabPaths.includes(pendingPath), false);
  assert.equal(sessionsState.sessions.some((session) => session.path === pendingPath), false);
  assert.equal(sessionsState.activeSessionPath, null);
  assert.ok(renderCount > 0, 'timeout should schedule a render');

  state.resetRuntimeState();
  resetSelectionTimeoutStoreState();
});

test('finishing a selection request cancels its timeout watchdog', async () => {
  resetSelectionTimeoutStoreState();

  const backend = { request: async () => undefined } as any;
  const context = createExtensionContext();
  let renderCount = 0;
  const state = new SessionServiceState(context, backend, () => {
    renderCount += 1;
  }, 15);

  const token = state.beginSelectionRequest('/workspace/session-a.jsonl');
  state.finishSelectionRequest(token);

  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.equal(store.getState().ui.notice, null);
  assert.equal(renderCount, 0);

  state.resetRuntimeState();
  resetSelectionTimeoutStoreState();
});
