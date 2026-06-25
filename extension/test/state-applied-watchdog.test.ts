import test from 'node:test';
import assert from 'node:assert/strict';

import {
  StateAppliedWatchdog,
  STATE_APPLIED_RELOAD_LIMIT,
  STATE_APPLIED_RELOAD_WINDOW_MS,
  type StateAppliedWatchdogDeps,
} from '../src/host/sidebar/state-applied-watchdog';

/** No-op deps suitable for exercising the pure throttle/ack logic. */
function fakeDeps(overrides: Partial<StateAppliedWatchdogDeps> = {}): StateAppliedWatchdogDeps {
  return {
    getWebviewReady: () => true,
    getViewVisible: () => true,
    getRunningSessionCount: () => 0,
    getHostInstanceId: () => 'test-instance',
    onResnapshot: () => undefined,
    onForceReload: async () => undefined,
    ...overrides,
  };
}

interface FakeTimers {
  advance: (ms: number) => void;
  pendingCount: () => number;
  restore: () => void;
}

/** Virtual clock mirroring tool-call-close-lifecycle.test.ts. */
function useFakeTimers(): FakeTimers {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;

  type Pending = { fn: () => void; fireAt: number; id: number };
  let now = 0;
  let pending: Pending[] = [];
  let nextId = 1;

  globalThis.setTimeout = ((fn: () => void, ms?: number) => {
    const id = nextId++;
    pending.push({ fn, fireAt: now + (ms ?? 0), id });
    return id as unknown as ReturnType<typeof setTimeout>;
  }) as typeof globalThis.setTimeout;

  globalThis.clearTimeout = ((id: ReturnType<typeof setTimeout>) => {
    pending = pending.filter((t) => t.id !== (id as unknown as number));
  }) as typeof globalThis.clearTimeout;

  const advance = (ms: number) => {
    now += ms;
    for (;;) {
      const due = pending
        .filter((t) => t.fireAt <= now)
        .sort((a, b) => a.fireAt - b.fireAt);
      if (due.length === 0) break;
      const dueIds = new Set(due.map((t) => t.id));
      pending = pending.filter((t) => !dueIds.has(t.id));
      for (const t of due) {
        t.fn();
      }
    }
  };

  return {
    advance,
    pendingCount: () => pending.length,
    restore: () => {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    },
  };
}

test('shouldThrottleStateAppliedReload allows up to the limit within a 30s window then throttles', () => {
  const watchdog = new StateAppliedWatchdog(fakeDeps());
  const t0 = 1_000_000;

  // First call opens the window and consumes attempt 1 -> allow.
  assert.equal(watchdog.shouldThrottleStateAppliedReload(t0), false);
  // Second call within the window consumes attempt 2 -> allow.
  assert.equal(watchdog.shouldThrottleStateAppliedReload(t0 + 1_000), false);
  // Third call within the window hits the limit -> throttle.
  assert.equal(watchdog.shouldThrottleStateAppliedReload(t0 + 2_000), true);
  // Subsequent calls within the same window keep throttling.
  assert.equal(watchdog.shouldThrottleStateAppliedReload(t0 + 3_000), true);

  assert.equal(STATE_APPLIED_RELOAD_LIMIT, 2, 'guard: test assumes limit of 2');
  assert.equal(STATE_APPLIED_RELOAD_WINDOW_MS, 30_000, 'guard: test assumes a 30s window');
});

test('shouldThrottleStateAppliedReload resets after the rolling window elapses', () => {
  const watchdog = new StateAppliedWatchdog(fakeDeps());
  const t0 = 5_000_000;

  // Burn through the limit inside the first window.
  assert.equal(watchdog.shouldThrottleStateAppliedReload(t0), false);
  assert.equal(watchdog.shouldThrottleStateAppliedReload(t0 + 500), false);
  assert.equal(watchdog.shouldThrottleStateAppliedReload(t0 + 1_000), true);

  // Past the 30s window: the counter resets and reloads are allowed again.
  const afterWindow = t0 + STATE_APPLIED_RELOAD_WINDOW_MS + 1;
  assert.equal(watchdog.shouldThrottleStateAppliedReload(afterWindow), false);
  assert.equal(watchdog.shouldThrottleStateAppliedReload(afterWindow + 100), false);
  assert.equal(watchdog.shouldThrottleStateAppliedReload(afterWindow + 200), true);
});

test('recordStateApplied clears the pending watchdog when ack revision >= pending revision', () => {
  const timers = useFakeTimers();
  try {
    const watchdog = new StateAppliedWatchdog(fakeDeps());

    watchdog.armStateAppliedWatchdog(7);
    assert.equal(timers.pendingCount(), 1, 'arming schedules a timeout timer');
    assert.equal(watchdog.getPendingStateAppliedRevision(), 7);

    // An ack for the armed revision clears the timer and pending state.
    watchdog.recordStateApplied(7);
    assert.equal(timers.pendingCount(), 0, 'matching ack clears the timer');
    assert.equal(watchdog.getPendingStateAppliedRevision(), null);

    // A later ack for a higher revision also clears an armed watchdog.
    watchdog.armStateAppliedWatchdog(12);
    assert.equal(timers.pendingCount(), 1);
    watchdog.recordStateApplied(15);
    assert.equal(timers.pendingCount(), 0);
    assert.equal(watchdog.getPendingStateAppliedRevision(), null);
  } finally {
    timers.restore();
  }
});

test('recordStateApplied does not clear the pending watchdog when ack revision < pending revision', () => {
  const timers = useFakeTimers();
  try {
    const watchdog = new StateAppliedWatchdog(fakeDeps());

    watchdog.armStateAppliedWatchdog(20);
    assert.equal(timers.pendingCount(), 1);

    // A stale ack for an older revision must not clear the armed watchdog.
    watchdog.recordStateApplied(5);
    assert.equal(timers.pendingCount(), 1, 'stale ack keeps the timer armed');
    assert.equal(watchdog.getPendingStateAppliedRevision(), 20);
  } finally {
    timers.restore();
  }
});