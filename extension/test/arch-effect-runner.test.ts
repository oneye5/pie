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
  | { kind: 'log'; level: string; message: string };

function makeDeps(opts: { requestImpl?: (method: string) => Promise<unknown> } = {}): {
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
    sync: { execute() {} },
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

test('EffectRunner routes lifecycle effects through enqueueLifecycle only (no inner session queue)', async () => {
  const { deps, calls } = makeDeps({
    requestImpl: async (method) => (method === 'session.create' ? { sessionPath: '/new' } : {}),
  });
  const runner = new EffectRunner(deps);

  const effect: Effect = {
    kind: 'CreateSession',
    corrId: 'c2',
    selectionToken: 'tok',
  };
  runner.run(effect);
  await settle();

  assert.equal(calls[0]?.kind, 'lifecycle');
  // No inner session queue call.
  assert.equal(calls.some((c) => c.kind === 'session'), false);
  assert.equal(calls[1]?.kind, 'request');
});

test('EffectRunner dispatches a failure result when an RPC rejects', async () => {
  const { deps, events } = makeDeps({
    requestImpl: () => Promise.reject(new Error('boom')),
  });
  const runner = new EffectRunner(deps);

  runner.run({ kind: 'SendRpc', corrId: 'c3', sessionPath: '/a', text: 'hi', inputs: [] });
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
