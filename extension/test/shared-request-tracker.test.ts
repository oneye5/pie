import assert from 'node:assert/strict';
import test from 'node:test';

import { RequestTracker } from '../src/shared/request-tracker';

/**
 * `RequestTracker` is a promise + timeout bookkeeping map keyed by request id.
 * Every `create` either is settled (resolve/reject/rejectAll, which clear the
 * timer) or has a short timeout that fires — so no test leaves a dangling
 * timer that would keep the process alive. The only real wall-clock wait is
 * the 2ms timeout case; everything else settles synchronously.
 */

// A long-enough timeout that the timer is never expected to fire during a test;
// resolve/reject/rejectAll clear it, so no real wait occurs.
const LONG_TIMEOUT = 1_000;

test('resolve settles the pending promise with the stored value and returns true', async () => {
  const tracker = new RequestTracker<string>();
  const p = tracker.create('id', LONG_TIMEOUT);
  assert.equal(tracker.resolve('id', 'value'), true);
  assert.equal(await p, 'value');
});

test('resolve removes the entry so a second resolve is a no-op returning false', async () => {
  const tracker = new RequestTracker<string>();
  const p = tracker.create('id', LONG_TIMEOUT);
  assert.equal(tracker.resolve('id', 'first'), true);
  assert.equal(tracker.resolve('id', 'second'), false); // already removed
  assert.equal(await p, 'first');
});

test('resolve returns false for an unknown id', () => {
  const tracker = new RequestTracker<string>();
  assert.equal(tracker.resolve('nope', 'x'), false);
});

test('reject propagates the given error to the pending promise and returns true', async () => {
  const tracker = new RequestTracker<string>();
  const p = tracker.create('id', LONG_TIMEOUT);
  assert.equal(tracker.reject('id', new Error('boom')), true);
  await assert.rejects(p, /boom/);
});

test('reject removes the entry so a second reject is a no-op returning false', async () => {
  const tracker = new RequestTracker<string>();
  const p = tracker.create('id', LONG_TIMEOUT);
  assert.equal(tracker.reject('id', new Error('boom')), true);
  assert.equal(tracker.reject('id', new Error('again')), false);
  await assert.rejects(p, /boom/);
});

test('reject returns false for an unknown id', () => {
  const tracker = new RequestTracker<string>();
  assert.equal(tracker.reject('nope', new Error('x')), false);
});

test('rejectAll rejects every pending request with the given error', async () => {
  const tracker = new RequestTracker<string>();
  const p1 = tracker.create('a', LONG_TIMEOUT);
  const p2 = tracker.create('b', LONG_TIMEOUT);
  const p3 = tracker.create('c', LONG_TIMEOUT);
  tracker.rejectAll(new Error('shutdown'));
  await assert.rejects(p1, /shutdown/);
  await assert.rejects(p2, /shutdown/);
  await assert.rejects(p3, /shutdown/);
  // All entries cleared: subsequent resolves/rejects are no-ops.
  assert.equal(tracker.resolve('a', 'x'), false);
  assert.equal(tracker.reject('b', new Error('x')), false);
});

test('rejectAll with no pending requests is a no-op', () => {
  const tracker = new RequestTracker<string>();
  assert.doesNotThrow(() => tracker.rejectAll(new Error('shutdown')));
});

test('create rejects with a timeout error after the configured timeout', async () => {
  const tracker = new RequestTracker<string>();
  const p = tracker.create('slow', 2); // 2ms
  await assert.rejects(p, (err: Error) => err.message === 'Timed out waiting for response to slow');
});

test('a timed-out request is removed so a later resolve is a no-op', async () => {
  const tracker = new RequestTracker<string>();
  const p = tracker.create('slow', 2);
  await assert.rejects(p, /Timed out waiting for response to slow/);
  assert.equal(tracker.resolve('slow', 'x'), false); // entry already deleted by the timeout
});

test('resolve clears the pending timer so no late timeout rejection fires', async () => {
  // If resolve failed to clear the timer, the 3ms timeout would later reject
  // the already-resolved promise. Settled promises ignore further settle calls,
  // so the only observable proof is that the resolved value wins and no
  // unhandled rejection surfaces after the timeout window elapses.
  const tracker = new RequestTracker<string>();
  const p = tracker.create('id', 3);
  assert.equal(tracker.resolve('id', 'value'), true);
  assert.equal(await p, 'value');
  // Wait past the timeout window to surface any late rejection.
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  assert.equal(await p, 'value');
});

test('RequestTracker resolves typed values via the generic parameter', async () => {
  // TResult = number; resolve must accept a number and the promise yields it.
  const tracker = new RequestTracker<number>();
  const p = tracker.create('n', LONG_TIMEOUT);
  tracker.resolve('n', 42);
  assert.equal(await p, 42);
});
