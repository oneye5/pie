import test from 'node:test';
import assert from 'node:assert/strict';

import { produce } from 'immer';

import { NOOP_RUN_OBSERVER } from '../src/host/stats-service';
import { createInitialArchState } from '../src/host/core/arch-state';
import type { ArchState } from '../src/host/core/arch-state';
import { SessionServiceState } from '../src/host/session-service/state';
import { SessionTabActions } from '../src/host/session-service/tab-actions';

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

async function flushMicrotasks(turns = 1): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    await Promise.resolve();
  }
}

async function waitFor(predicate: () => boolean, attempts = 20): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    await flushMicrotasks(3);
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail('Timed out waiting for predicate to become true.');
}

test('openSession serializes backend session.open requests through the lifecycle queue', async () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const sessionPaths = [`/workspace/session-a-${suffix}.jsonl`, `/workspace/session-b-${suffix}.jsonl`];
  const started: string[] = [];
  const resolvers: Array<() => void> = [];

  const backend = {
    request: async (_method: string, params: { sessionPath?: string }) => {
      started.push(String(params.sessionPath ?? ''));
      await new Promise<void>((resolve) => {
        resolvers.push(resolve);
      });
      return undefined;
    },
  } as any;

  const context = createExtensionContext();
  let archState = createInitialArchState();
  const getArchState = () => archState;
  const mutateArchState = (recipe: (draft: ArchState) => void) => {
    archState = produce(archState, recipe);
  };
  const state = new SessionServiceState(context, backend, () => undefined, getArchState, mutateArchState);
  const tabs = new SessionTabActions({
    context,
    backend,
    scheduleRender: () => undefined,
    runObserver: NOOP_RUN_OBSERVER,
    state,
    getArchState,
    mutateArchState,
  });

  tabs.openSession(sessionPaths[0]);
  tabs.openSession(sessionPaths[1]);

  await flushMicrotasks(2);

  assert.deepEqual(
    started,
    [sessionPaths[0]],
    'the second tab-open request should wait for the first lifecycle task to finish',
  );
  assert.equal(resolvers.length, 1);

  resolvers.shift()?.();
  await waitFor(() => started.length === 2);

  assert.deepEqual(started, sessionPaths);

  resolvers.shift()?.();
  await flushMicrotasks(2);
});
