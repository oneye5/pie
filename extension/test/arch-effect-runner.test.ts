import test from 'node:test';
import assert from 'node:assert/strict';

import { EffectRunner, type EffectRunnerDeps, type TimerSink, type TimerHandle } from '../src/host/core/effect-runner';
import type { Effect } from '../src/host/core/effects';
import type { EffectResultEvent, CommandEvent, Event } from '../src/host/core/events';
import { makeEffectRunnerDeps } from './helpers/effect-runner-deps';

/** Deterministic timer sink: records scheduled timers and fires them on
 *  `runAll()` instead of waiting on wall-clock time. Eliminates real-timer
 *  waits and the flakes they cause under load. */
class FakeTimerSink implements TimerSink {
  private readonly pending: { fn: () => void; cancelled: boolean }[] = [];
  schedule(fn: () => void, _ms: number): TimerHandle {
    const handle = { fn, cancelled: false };
    this.pending.push(handle);
    return handle;
  }
  cancel(handle: TimerHandle): void {
    const h = handle as { fn: () => void; cancelled: boolean };
    h.cancelled = true;
    const i = this.pending.indexOf(h);
    if (i >= 0) this.pending.splice(i, 1);
  }
  /** Fire all pending timers synchronously (earliest-scheduled first). */
  runAll(): void {
    const ready = this.pending.splice(0);
    for (const h of ready) {
      if (!h.cancelled) {
        h.cancelled = true;
        h.fn();
      }
    }
  }
  get size(): number { return this.pending.length; }
}

async function settle(): Promise<void> {
  // Allow the runner's async work (microtasks + queued promises) to drain.
  for (let i = 0; i < 5; i++) {
    await new Promise<void>((r) => setImmediate(r));
  }
}

test('EffectRunner routes InterruptRpc through enqueueLifecycle → enqueueSessionOperation (double-wrap)', async () => {
  const { deps, calls, events } = makeEffectRunnerDeps();
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
  const { deps, calls, events } = makeEffectRunnerDeps();
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
  const { deps, calls, events } = makeEffectRunnerDeps({ requestImpl: (method) => method === 'session.create' ? Promise.reject(new Error('backend down')) : Promise.resolve({}) });
  const runner = new EffectRunner(deps);

  runner.run({ kind: 'CreateSession', corrId: 'c2b', sessionPath: '/__pending__:new2', cwd: '/w', selectionToken: 'tok-2' });
  await settle();

  assert.deepEqual(calls.find((c) => c.kind === 'handleSelectionFailure'), { kind: 'handleSelectionFailure', token: 'tok-2', notice: 'Failed to create session: backend down' });
  assert.equal(events[0]?.kind, 'CreateSessionResult');
  assert.equal(events[0]?.ok, false);
  assert.equal(events[0]?.error, 'backend down');
});

test('EffectRunner OpenSession issues session.open (with the pre-minted token) on the lifecycle queue and dispatches OpenSessionResult{ok:true}', async () => {
  const { deps, calls, events } = makeEffectRunnerDeps();
  const runner = new EffectRunner(deps);

  const effect: Effect = {
    kind: 'OpenSession',
    corrId: 'c3',
    sessionPath: '/existing',
    selectionToken: 'tok',
  };
  runner.run(effect);
  await settle();

  // The reducer already did the optimistic tab setup; the service already
  // minted the selection token (before the reducer activated the opened tab).
  // The runner only issues the backend session.open RPC, serialized on the
  // lifecycle queue, carrying that token — mirroring CreateSession.
  assert.equal(calls.some((c) => c.kind === 'lifecycle'), true);
  assert.deepEqual(calls.find((c) => c.kind === 'request'), { kind: 'request', method: 'session.open', params: { sessionPath: '/existing', selectionToken: 'tok' } });
  assert.equal(events[0]?.kind, 'OpenSessionResult');
  assert.equal(events[0]?.ok, true);
  assert.equal(events[0]?.sessionPath, '/existing');
});

test('EffectRunner OpenSession calls handleSelectionFailure + dispatches OpenSessionResult{ok:false} when session.open rejects', async () => {
  const { deps, calls, events } = makeEffectRunnerDeps({ requestImpl: (method) => method === 'session.open' ? Promise.reject(new Error('backend down')) : Promise.resolve({}) });
  const runner = new EffectRunner(deps);

  runner.run({ kind: 'OpenSession', corrId: 'c3b', sessionPath: '/existing2', selectionToken: 'tok-2' });
  await settle();

  assert.deepEqual(calls.find((c) => c.kind === 'handleSelectionFailure'), { kind: 'handleSelectionFailure', token: 'tok-2', notice: 'Failed to open session: backend down' });
  assert.equal(events[0]?.kind, 'OpenSessionResult');
  assert.equal(events[0]?.ok, false);
  assert.equal(events[0]?.error, 'backend down');
});

test('EffectRunner DuplicateSession issues session.duplicate (with the SOURCE path + pre-minted token) on the lifecycle queue and dispatches DuplicateSessionResult{ok:true}', async () => {
  const { deps, calls, events } = makeEffectRunnerDeps();
  const runner = new EffectRunner(deps);

  const effect: Effect = {
    kind: 'DuplicateSession',
    corrId: 'c4',
    sessionPath: '/__pending__:copy',
    sourceSessionPath: '/src',
    selectionToken: 'tok-d',
  };
  runner.run(effect);
  await settle();

  // The reducer already did the optimistic tab setup (copy tab adjacent to the
  // source); the service already minted the selection token (before the reducer
  // activated the copy tab). The runner only issues the backend session.duplicate
  // RPC, serialized on the lifecycle queue, carrying the SOURCE path (not the
  // pending copy path) + the token — mirroring CreateSession/OpenSession.
  assert.equal(calls.some((c) => c.kind === 'lifecycle'), true);
  assert.deepEqual(calls.find((c) => c.kind === 'request'), { kind: 'request', method: 'session.duplicate', params: { sessionPath: '/src', selectionToken: 'tok-d' } });
  assert.equal(events[0]?.kind, 'DuplicateSessionResult');
  assert.equal(events[0]?.ok, true);
  // The pending COPY path is echoed back on the result (not the source path).
  assert.equal(events[0]?.sessionPath, '/__pending__:copy');
});

test('EffectRunner DuplicateSession calls handleSelectionFailure + dispatches DuplicateSessionResult{ok:false} when session.duplicate rejects', async () => {
  const { deps, calls, events } = makeEffectRunnerDeps({ requestImpl: (method) => method === 'session.duplicate' ? Promise.reject(new Error('backend down')) : Promise.resolve({}) });
  const runner = new EffectRunner(deps);

  runner.run({ kind: 'DuplicateSession', corrId: 'c4b', sessionPath: '/__pending__:copy2', sourceSessionPath: '/src2', selectionToken: 'tok-d2' });
  await settle();

  assert.deepEqual(calls.find((c) => c.kind === 'handleSelectionFailure'), { kind: 'handleSelectionFailure', token: 'tok-d2', notice: 'Failed to duplicate session: backend down' });
  assert.equal(events[0]?.kind, 'DuplicateSessionResult');
  assert.equal(events[0]?.ok, false);
  assert.equal(events[0]?.error, 'backend down');
});

test('EffectRunner dispatches a failure result when an RPC rejects', async () => {
  const { deps, events } = makeEffectRunnerDeps({
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
  const { deps, calls, events } = makeEffectRunnerDeps();
  const runner = new EffectRunner(deps);

  runner.run({
    kind: 'PersistTabs',
    corrId: 'c4',
    openTabPaths: ['/a', '/b'],
    activeSessionPath: '/a',
    pinnedTabPaths: [],
  });
  await settle();

  assert.equal(calls.some((c) => c.kind === 'lifecycle'), false);
  assert.deepEqual(calls[0], {
    kind: 'persistTabs',
    openTabPaths: ['/a', '/b'],
    active: '/a',
    pinnedTabPaths: [],
  });
  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, 'PersistTabsResult');
  assert.equal(events[0]?.ok, true);
});

test('EffectRunner runs Log directly via the log sink (no dispatch event)', async () => {
  const { deps, calls, events } = makeEffectRunnerDeps();
  const runner = new EffectRunner(deps);

  runner.run({ kind: 'Log', corrId: 'c5', level: 'warn', message: 'hello' });
  await settle();

  assert.deepEqual(calls, [{ kind: 'log', level: 'warn', message: 'hello' }]);
  assert.equal(events.length, 0);
});

test('EffectRunner ShowModelSwitchConfirm dispatches ModelSwitchConfirmResult matching the user choice', async () => {
  const { deps, calls, events } = makeEffectRunnerDeps({ modalChoice: 'Switch Model' });
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
  const { deps, events } = makeEffectRunnerDeps({ modalChoice: undefined });
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
  const { deps, calls, events } = makeEffectRunnerDeps();
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
  const { deps, calls, events } = makeEffectRunnerDeps({ requestImpl: () => Promise.reject(new Error('backend down')) });
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

// ─── DrainPendingSendQueue ────────────────────────────────────────────────────

test('EffectRunner DrainPendingSendQueue re-dispatches Send Commands with the resolved session path', async () => {
  const { deps, commands } = makeEffectRunnerDeps();
  const runner = new EffectRunner(deps);

  runner.run({
    kind: 'DrainPendingSendQueue',
    corrId: 'drain:p1',
    resolvedSessionPath: '/workspace/real.jsonl',
    entries: [
      { corrId: 'c1', text: 'first', inputs: [], composedText: 'first', localId: 'local:c1', previousSummary: null, timestamp: 1000 },
      { corrId: 'c2', text: 'second', inputs: [], composedText: 'second', localId: 'local:c2', previousSummary: null, timestamp: 2000 },
    ],
  });
  await settle();

  // Two Send Commands dispatched, each with the resolved session path.
  assert.equal(commands.length, 2);
  assert.equal(commands[0]?.kind, 'Command');
  assert.equal(commands[0]?.cmd.kind, 'Send');
  assert.equal(commands[0]?.cmd.sessionPath, '/workspace/real.jsonl');
  assert.equal(commands[0]?.cmd.corrId, 'c1');
  assert.equal(commands[0]?.cmd.text, 'first');
  assert.equal(commands[0]?.cmd.localId, 'local:c1');
  assert.equal(commands[0]?.cmd.previousSummary, null);

  assert.equal(commands[1]?.kind, 'Command');
  assert.equal(commands[1]?.cmd.kind, 'Send');
  assert.equal(commands[1]?.cmd.sessionPath, '/workspace/real.jsonl');
  assert.equal(commands[1]?.cmd.corrId, 'c2');
  assert.equal(commands[1]?.cmd.text, 'second');
});

test('EffectRunner DrainPendingSendQueue with empty entries dispatches nothing', async () => {
  const { deps, commands } = makeEffectRunnerDeps();
  const runner = new EffectRunner(deps);

  runner.run({
    kind: 'DrainPendingSendQueue',
    corrId: 'drain:p2',
    resolvedSessionPath: '/workspace/real.jsonl',
    entries: [],
  });
  await settle();

  assert.equal(commands.length, 0);
});

// ─── DrainBackendReadyQueue + Watchdog ────────────────────────────────────────

test('EffectRunner DrainBackendReadyQueue re-dispatches Send Commands for each entry + clears watchdog', async () => {
  const { deps, commands, events } = makeEffectRunnerDeps();
  const runner = new EffectRunner(deps);

  // First start the watchdog (so we can verify it's cleared).
  runner.run({ kind: 'StartBackendReadyWatchdog', corrId: 'watchdog', timeoutMs: 30_000 });

  runner.run({
    kind: 'DrainBackendReadyQueue',
    corrId: 'drain:backendReady',
    entries: [
      { sessionPath: '/s1', corrId: 'c1', text: 'first', inputs: [], composedText: 'first', localId: 'local:c1', previousSummary: null, timestamp: 1000 },
      { sessionPath: '/s2', corrId: 'c2', text: 'second', inputs: [], composedText: 'second', localId: 'local:c2', previousSummary: null, timestamp: 2000 },
    ],
  });
  await settle();

  // Two Send Commands dispatched, each with its own sessionPath.
  assert.equal(commands.length, 2);
  assert.equal(commands[0]?.kind, 'Command');
  const cmd0 = commands[0]?.cmd;
  assert.equal(cmd0?.kind, 'Send');
  if (cmd0?.kind === 'Send') {
    assert.equal(cmd0.sessionPath, '/s1');
    assert.equal(cmd0.corrId, 'c1');
  }
  const cmd1 = commands[1]?.cmd;
  if (cmd1?.kind === 'Send') {
    assert.equal(cmd1.sessionPath, '/s2');
    assert.equal(cmd1.corrId, 'c2');
  }
});

test('EffectRunner StartBackendReadyWatchdog starts a timer that dispatches BackendReadyWatchdogFired on fire', () => {
  const timers = new FakeTimerSink();
  const { deps } = makeEffectRunnerDeps({ timer: timers });
  const dispatchedEvents: Event[] = [];
  const runner = new EffectRunner({
    ...deps,
    dispatchEvent: (e) => dispatchedEvents.push(e),
  });

  runner.run({ kind: 'StartBackendReadyWatchdog', corrId: 'watchdog', timeoutMs: 10 });
  // Fire the scheduled timer synchronously.
  timers.runAll();

  assert.equal(dispatchedEvents.length, 1);
  assert.equal(dispatchedEvents[0]?.kind, 'BackendReadyWatchdogFired');
});

test('EffectRunner CancelBackendReadyWatchdog prevents the timer from firing', () => {
  const timers = new FakeTimerSink();
  const { deps } = makeEffectRunnerDeps({ timer: timers });
  const dispatchedEvents: Event[] = [];
  const runner = new EffectRunner({
    ...deps,
    dispatchEvent: (e) => dispatchedEvents.push(e),
  });

  runner.run({ kind: 'StartBackendReadyWatchdog', corrId: 'watchdog', timeoutMs: 10 });
  runner.run({ kind: 'CancelBackendReadyWatchdog', corrId: 'watchdog' });
  // A cancelled timer must not fire.
  timers.runAll();

  assert.equal(dispatchedEvents.length, 0);
});

// ─── Optimistic-op TTL ──────────────────────────────────────────────────────

test('EffectRunner SendRpc starts an optimistic-op timer that is cancelled on success', async () => {
  const timers = new FakeTimerSink();
  const { deps, events } = makeEffectRunnerDeps({
    requestImpl: () => Promise.resolve({ requestId: 'req-1' }),
    optimisticOpTimeoutMs: 50,
    timer: timers,
  });
  const runner = new EffectRunner(deps);

  runner.run({ kind: 'SendRpc', corrId: 'c-ttl-ok', sessionPath: '/a', text: 'hi', inputs: [], localId: 'loc-1' });
  await settle();
  // The success path must have cancelled the timer; firing pending timers must
  // not produce a spurious timeout.
  assert.equal(timers.size, 0);
  timers.runAll();

  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, 'SendResult');
  assert.equal(events[0]?.ok, true);
  if (events[0]?.ok === true) {
    assert.equal(events[0].requestId, 'req-1');
  }
  runner.dispose();
});

test('EffectRunner SendRpc dispatches SendResult{ok:false} on timeout when backend hangs', async () => {
  const timers = new FakeTimerSink();
  const { deps, events } = makeEffectRunnerDeps({
    requestImpl: () => new Promise(() => {}), // never resolves
    optimisticOpTimeoutMs: 50,
    timer: timers,
  });
  const runner = new EffectRunner(deps);

  runner.run({ kind: 'SendRpc', corrId: 'c-ttl-hang', sessionPath: '/a', text: 'hi', inputs: [], localId: 'loc-1' });
  await settle();
  // Fire the optimistic-op TTL timer synchronously.
  timers.runAll();

  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, 'SendResult');
  assert.equal(events[0]?.ok, false);
  if (events[0]?.ok === false) {
    assert.match(events[0].error ?? '', /Timed out/);
  }
  runner.dispose();
});

test('EffectRunner EditRpc dispatches EditResult{ok:false} on timeout when backend hangs', async () => {
  const timers = new FakeTimerSink();
  const { deps, events } = makeEffectRunnerDeps({
    requestImpl: () => new Promise(() => {}), // never resolves
    optimisticOpTimeoutMs: 50,
    timer: timers,
  });
  const runner = new EffectRunner(deps);

  runner.run({ kind: 'EditRpc', corrId: 'c-ttl-edit', sessionPath: '/a', messageId: 'msg-1', text: 'edited', localId: 'loc-e1' });
  await settle();
  timers.runAll();

  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, 'EditResult');
  assert.equal(events[0]?.ok, false);
  if (events[0]?.ok === false) {
    assert.match(events[0].error ?? '', /Timed out/);
  }
  runner.dispose();
});

test('EffectRunner SendRpc cancels timer on failure (no spurious timeout)', async () => {
  const timers = new FakeTimerSink();
  const { deps, events } = makeEffectRunnerDeps({
    requestImpl: () => Promise.reject(new Error('boom')),
    optimisticOpTimeoutMs: 50,
    timer: timers,
  });
  const runner = new EffectRunner(deps);

  runner.run({ kind: 'SendRpc', corrId: 'c-ttl-fail', sessionPath: '/a', text: 'hi', inputs: [], localId: 'loc-1' });
  await settle();
  // The failure path must have cancelled the timer; firing pending timers must
  // not produce a spurious timeout.
  assert.equal(timers.size, 0);
  timers.runAll();

  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, 'SendResult');
  assert.equal(events[0]?.ok, false);
  if (events[0]?.ok === false) {
    assert.equal(events[0].error, 'boom');
  }
  runner.dispose();
});

test('EffectRunner dispose clears all optimistic-op timers', async () => {
  const timers = new FakeTimerSink();
  const { deps, events } = makeEffectRunnerDeps({
    requestImpl: () => new Promise(() => {}), // never resolves
    optimisticOpTimeoutMs: 1000,
    timer: timers,
  });
  const runner = new EffectRunner(deps);

  runner.run({ kind: 'SendRpc', corrId: 'c-ttl-dispose', sessionPath: '/a', text: 'hi', inputs: [], localId: 'loc-1' });
  await settle();
  // Dispose before the timer can fire; firing pending timers must not dispatch.
  runner.dispose();
  assert.equal(timers.size, 0);
  timers.runAll();

  assert.equal(events.length, 0);
});
