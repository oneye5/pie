import test from 'node:test';
import assert from 'node:assert/strict';

import { EffectRunner, type EffectRunnerDeps } from '../src/host/core/effect-runner';
import type { Effect } from '../src/host/core/effects';
import type { EffectResultEvent } from '../src/host/core/events';

type Call =
  | { kind: 'lifecycle' }
  | { kind: 'session'; sessionPath: string }
  | { kind: 'request'; method: string; params: unknown }
  | { kind: 'persistTabs'; openTabPaths: string[]; active: string | null }
  | { kind: 'log'; level: string; message: string }
  | { kind: 'openSession'; sessionPath: string }
  | { kind: 'showWarningModal'; message: string; confirmChoice: string }
  | { kind: 'bumpEpoch'; sessionPath: string }
  | { kind: 'onModelConfigChanged'; sessionPath: string; modelId: string; thinkingLevel: string }
  | { kind: 'handleSelectionFailure'; token: string; notice: string };

function makeDeps(opts: { requestImpl?: (method: string) => Promise<unknown>; modalChoice?: string | undefined } = {}): {
  deps: EffectRunnerDeps;
  calls: Call[];
  events: EffectResultEvent[];
} {
  const calls: Call[] = [];
  const events: EffectResultEvent[] = [];
  const deps: EffectRunnerDeps = {
    backend: {
      async request<T = unknown>(method: string, params?: unknown): Promise<T> {
        calls.push({ kind: 'request', method, params });
        if (opts.requestImpl) return (await opts.requestImpl(method)) as T;
        return {} as T;
      },
    },
    queues: {
      async enqueueLifecycle(task) {
        calls.push({ kind: 'lifecycle' });
        return task();
      },
      async enqueueSessionOperation(sessionPath, task) {
        calls.push({ kind: 'session', sessionPath });
        return task();
      },
    },
    tabs: {
      async persistTabs(openTabPaths, active) {
        calls.push({ kind: 'persistTabs', openTabPaths, active });
      },
    },
    log: {
      log(level, message) {
        calls.push({ kind: 'log', level, message });
      },
    },
    postImperative: { postImperative() {} },
    modal: {
      async showWarningModal(message: string, confirmChoice: string) {
        calls.push({ kind: 'showWarningModal', message, confirmChoice });
        return opts.modalChoice;
      },
    },
    fileDiffService: { openFileDiff: async () => {}, openFileInEditor: async () => {}, revertFile: async () => {} } as any,
    service: {
      async hydrateModelState() {},
      setPrefs() {},
      bumpSessionDataEpoch(sessionPath: string) {
        calls.push({ kind: 'bumpEpoch', sessionPath });
      },
      onModelConfigChanged(sessionPath: string, modelId: string, thinkingLevel: string) {
        calls.push({ kind: 'onModelConfigChanged', sessionPath, modelId, thinkingLevel });
      },
      suppressNextCompletionNotificationFor() {},
      async addFilesystemPaths() {},
      async loadOlderTranscript() {},
      async loadNewerTranscript() {},
      async jumpToLatestTranscript() {},
      async closeSession() {},
      async setPruningSettings() {},
      duplicateSession() {},
      handleSelectionFailure(token: string, notice: string) {
        calls.push({ kind: 'handleSelectionFailure', token, notice });
      },
      openSession(sessionPath: string) {
        calls.push({ kind: 'openSession', sessionPath });
      },
    },
    statsService: {
      prepareForSend() {},
      onTruncatedAfter() {},
      onMessageEdited() {},
      recordOutcome() {},
      startNewTask() {},
      continueTask() {},
    },
    dispatch: (e) => events.push(e),
  };
  return { deps, calls, events };
}

async function settle(): Promise<void> {
  // Allow the runner's async work (microtasks + queued promises) to drain.
  for (let i = 0; i < 5; i++) {
    await new Promise<void>((r) => setImmediate(r));
  }
}

test('EffectRunner routes InterruptRpc through enqueueLifecycle → enqueueSessionOperation (double-wrap)', async () => {
  const { deps, calls, events } = makeDeps();
  const runner = new EffectRunner(deps);

  const effect: Effect = { kind: 'InterruptRpc', corrId: 'c1', sessionPath: '/a' };
  runner.run(effect);
  await settle();

  // Expected order: outer lifecycle wrap, inner session wrap, then the RPC.
  assert.equal(calls[0]?.kind, 'lifecycle');
  assert.deepEqual(calls[1], { kind: 'session', sessionPath: '/a' });
  assert.deepEqual(calls[2], {
    kind: 'request',
    method: 'message.interrupt',
    params: { sessionPath: '/a' },
  });

  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, 'InterruptResult');
  assert.equal(events[0]?.corrId, 'c1');
  assert.equal(events[0]?.ok, true);
});

test('EffectRunner CreateSession issues session.create (with the pre-minted token) on the lifecycle queue and dispatches CreateSessionResult{ok:true}', async () => {
  const { deps, calls, events } = makeDeps();
  const runner = new EffectRunner(deps);

  const effect: Effect = {
    kind: 'CreateSession',
    corrId: 'c2',
    sessionPath: '/__pending__:new',
    cwd: '/w',
    selectionToken: 'tok-1',
  };
  runner.run(effect);
  await settle();

  // The reducer already did the optimistic tab setup; the service already
  // minted the selection token (before the reducer activated the pending tab).
  // The runner only issues the backend session.create RPC, serialized on the
  // lifecycle queue, carrying that token.
  assert.equal(calls.some((c) => c.kind === 'lifecycle'), true);
  assert.deepEqual(calls.find((c) => c.kind === 'request'), { kind: 'request', method: 'session.create', params: { cwd: '/w', selectionToken: 'tok-1' } });
  assert.equal(events[0]?.kind, 'CreateSessionResult');
  assert.equal(events[0]?.ok, true);
  assert.equal(events[0]?.sessionPath, '/__pending__:new');
});

test('EffectRunner CreateSession calls handleSelectionFailure + dispatches CreateSessionResult{ok:false} when session.create rejects', async () => {
  const { deps, calls, events } = makeDeps({ requestImpl: (method) => method === 'session.create' ? Promise.reject(new Error('backend down')) : Promise.resolve({}) });
  const runner = new EffectRunner(deps);

  runner.run({ kind: 'CreateSession', corrId: 'c2b', sessionPath: '/__pending__:new2', cwd: '/w', selectionToken: 'tok-2' });
  await settle();

  assert.deepEqual(calls.find((c) => c.kind === 'handleSelectionFailure'), { kind: 'handleSelectionFailure', token: 'tok-2', notice: 'Failed to create session: backend down' });
  assert.equal(events[0]?.kind, 'CreateSessionResult');
  assert.equal(events[0]?.ok, false);
  assert.equal(events[0]?.error, 'backend down');
});

test('EffectRunner delegates OpenSession to the session service', async () => {
  const { deps, calls, events } = makeDeps();
  const runner = new EffectRunner(deps);

  const effect: Effect = {
    kind: 'OpenSession',
    corrId: 'c3',
    sessionPath: '/existing',
    selectionToken: 'tok',
  };
  runner.run(effect);
  await settle();

  assert.deepEqual(
    calls.find((c) => c.kind === 'openSession'),
    { kind: 'openSession', sessionPath: '/existing' },
  );
  assert.equal(calls.some((c) => c.kind === 'request'), false);
  assert.equal(events[0]?.kind, 'OpenSessionResult');
  assert.equal(events[0]?.ok, true);
});

test('EffectRunner dispatches a failure result when an RPC rejects', async () => {
  const { deps, events } = makeDeps({
    requestImpl: () => Promise.reject(new Error('boom')),
  });
  const runner = new EffectRunner(deps);

  runner.run({ kind: 'SendRpc', corrId: 'c3', sessionPath: '/a', text: 'hi', inputs: [], localId: 'local-1' });
  await settle();

  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, 'SendResult');
  assert.equal(events[0]?.ok, false);
  if (events[0]?.ok === false) {
    assert.equal(events[0].error, 'boom');
  }
});

test('EffectRunner runs PersistTabs synchronously without queueing', async () => {
  const { deps, calls, events } = makeDeps();
  const runner = new EffectRunner(deps);

  runner.run({
    kind: 'PersistTabs',
    corrId: 'c4',
    openTabPaths: ['/a', '/b'],
    activeSessionPath: '/a',
  });
  await settle();

  assert.equal(calls.some((c) => c.kind === 'lifecycle'), false);
  assert.deepEqual(calls[0], {
    kind: 'persistTabs',
    openTabPaths: ['/a', '/b'],
    active: '/a',
  });
  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, 'PersistTabsResult');
  assert.equal(events[0]?.ok, true);
});

test('EffectRunner runs Log directly via the log sink (no dispatch event)', async () => {
  const { deps, calls, events } = makeDeps();
  const runner = new EffectRunner(deps);

  runner.run({ kind: 'Log', corrId: 'c5', level: 'warn', message: 'hello' });
  await settle();

  assert.deepEqual(calls, [{ kind: 'log', level: 'warn', message: 'hello' }]);
  assert.equal(events.length, 0);
});

test('EffectRunner ShowModelSwitchConfirm dispatches ModelSwitchConfirmResult matching the user choice', async () => {
  const { deps, calls, events } = makeDeps({ modalChoice: 'Switch Model' });
  const runner = new EffectRunner(deps);

  runner.run({
    kind: 'ShowModelSwitchConfirm',
    corrId: 'm1',
    sessionPath: '/s',
    modelSettings: { defaultModel: 'text-only', defaultThinkingLevel: 'high' },
    message: 'remove images?',
    confirmChoice: 'Switch Model',
  });
  await settle();

  assert.deepEqual(calls, [{ kind: 'showWarningModal', message: 'remove images?', confirmChoice: 'Switch Model' }]);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, 'ModelSwitchConfirmResult');
  assert.equal(events[0]?.corrId, 'm1');
  assert.equal(events[0]?.confirmed, true);
});

test('EffectRunner ShowModelSwitchConfirm maps a dismissal (undefined choice) to confirmed:false', async () => {
  const { deps, events } = makeDeps({ modalChoice: undefined });
  const runner = new EffectRunner(deps);

  runner.run({
    kind: 'ShowModelSwitchConfirm',
    corrId: 'm2',
    sessionPath: '/s',
    modelSettings: { defaultModel: 'text-only', defaultThinkingLevel: 'high' },
    message: 'remove images?',
    confirmChoice: 'Switch Model',
  });
  await settle();

  assert.equal(events[0]?.kind, 'ModelSwitchConfirmResult');
  assert.equal(events[0]?.confirmed, false);
});

test('EffectRunner SetModelRpc writes settings.set, bumps the epoch, notifies the observer, and dispatches SetModelResult{ok:true}', async () => {
  const { deps, calls, events } = makeDeps();
  const runner = new EffectRunner(deps);

  runner.run({
    kind: 'SetModelRpc',
    corrId: 'sm1',
    sessionPath: '/s',
    modelSettings: { defaultModel: 'image-model', defaultThinkingLevel: 'medium' },
  });
  await settle();

  // Serialized through the lifecycle queue (single-wrap, matching the old
  // service path), then the backend write.
  assert.equal(calls[0]?.kind, 'lifecycle');
  const req = calls.find((c) => c.kind === 'request');
  assert.deepEqual(req, { kind: 'request', method: 'settings.set', params: { sessionPath: '/s', defaultModel: 'image-model', defaultThinkingLevel: 'medium' } });
  // Effect-side concerns (host-local epoch + disk-persisting analytics).
  assert.deepEqual(calls.find((c) => c.kind === 'bumpEpoch'), { kind: 'bumpEpoch', sessionPath: '/s' });
  assert.deepEqual(calls.find((c) => c.kind === 'onModelConfigChanged'), { kind: 'onModelConfigChanged', sessionPath: '/s', modelId: 'image-model', thinkingLevel: 'medium' });
  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, 'SetModelResult');
  assert.equal(events[0]?.corrId, 'sm1');
  assert.equal(events[0]?.ok, true);
});

test('EffectRunner SetModelRpc dispatches SetModelResult{ok:false} when settings.set rejects (no epoch/observer call)', async () => {
  const { deps, calls, events } = makeDeps({ requestImpl: () => Promise.reject(new Error('backend down')) });
  const runner = new EffectRunner(deps);

  runner.run({
    kind: 'SetModelRpc',
    corrId: 'sm2',
    sessionPath: '/s',
    modelSettings: { defaultModel: 'image-model', defaultThinkingLevel: 'medium' },
  });
  await settle();

  assert.equal(calls.some((c) => c.kind === 'bumpEpoch'), false);
  assert.equal(calls.some((c) => c.kind === 'onModelConfigChanged'), false);
  assert.equal(events[0]?.kind, 'SetModelResult');
  assert.equal(events[0]?.ok, false);
  assert.equal(events[0]?.error, 'backend down');
});
