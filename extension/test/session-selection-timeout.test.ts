import test from 'node:test';
import assert from 'node:assert/strict';

import { produce } from 'immer';

import { SessionServiceState } from '../src/host/session-service/state';
import { createInitialArchState } from '../src/host/core/arch-state';
import type { ArchState } from '../src/host/core/arch-state';

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
  let archState = createInitialArchState();
  const getArchState = () => archState;
  const mutateArchState = (recipe: (draft: ArchState) => void) => {
    archState = produce(archState, recipe);
  };

  const backend = { request: async () => undefined } as any;
  const context = createExtensionContext();
  let renderCount = 0;
  const state = new SessionServiceState(context, backend, () => {
    renderCount += 1;
  }, getArchState, mutateArchState, 15);

  const pendingPath = `__pending__:selection-timeout-${Date.now()}`;
  mutateArchState((draft) => {
    draft.sessions.sessions.push({
      path: pendingPath,
      name: 'Loading...',
      isPlaceholder: true,
      cwd: '',
      modifiedAt: new Date().toISOString(),
      messageCount: 0,
    });
    if (!draft.sessions.openTabPaths.includes(pendingPath)) {
      draft.sessions.openTabPaths = [...draft.sessions.openTabPaths, pendingPath];
    }
    draft.sessions.activeSessionPath = pendingPath;
  });

  const token = state.beginSelectionRequest(pendingPath, pendingPath, false, true);

  await waitFor(() => {
    const notice = getArchState().settings.notice;
    return typeof notice === 'string' && notice.includes('Timed out waiting to create session');
  });

  const sessionsState = getArchState().sessions;
  assert.equal(state.getSelectionRequest(token), null);
  assert.equal(sessionsState.openTabPaths.includes(pendingPath), false);
  assert.equal(sessionsState.sessions.some((session) => session.path === pendingPath), false);
  assert.equal(sessionsState.activeSessionPath, null);
  assert.ok(renderCount > 0, 'timeout should schedule a render');

  state.resetRuntimeState();
});

test('finishing a selection request cancels its timeout watchdog', async () => {
  let archState = createInitialArchState();
  const getArchState = () => archState;
  const mutateArchState = (recipe: (draft: ArchState) => void) => {
    archState = produce(archState, recipe);
  };

  const backend = { request: async () => undefined } as any;
  const context = createExtensionContext();
  let renderCount = 0;
  const state = new SessionServiceState(context, backend, () => {
    renderCount += 1;
  }, getArchState, mutateArchState, 15);

  const token = state.beginSelectionRequest('/workspace/session-a.jsonl');
  state.finishSelectionRequest(token);

  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.equal(getArchState().settings.notice, null);
  assert.equal(renderCount, 0);

  state.resetRuntimeState();
});