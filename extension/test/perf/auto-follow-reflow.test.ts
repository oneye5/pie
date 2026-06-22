/**
 * Auto-follow reflow harness for `useSmoothAutoFollow`'s `scrollHeight`-read
 * gating (Step 3 of the streaming-perf work).
 *
 * The loop used to read `el.scrollHeight` (a forced layout reflow) every
 * animation frame while auto-follow was active. The fix caches the target and
 * re-reads only when the transcript content signature changed (the streaming
 * message grew) or on a fallback cadence (`AUTO_FOLLOW_FALLBACK_READ_MS`) for
 * height changes the signature can't see (late image / markdown loads).
 *
 * happy-dom has no layout engine — `scrollHeight`/`clientHeight` are always 0
 * and reading them is free — so the *forced-reflow* cost can't be measured
 * here (that needs a real browser). What this harness DOES prove, faithfully:
 *   (1) auto-follow still tracks growth (correctness — the cache didn't break
 *       following), reading `scrollHeight` exactly once per content change;
 *   (2) stable-content frames read `scrollHeight` ZERO times (the reflow is
 *       skipped while only the cached target is reused);
 *   (3) the fallback cadence re-reads after the interval, catching an
 *       unsignaled height change (late load) so the view re-pins.
 *
 * Determinism: `requestAnimationFrame` is faked and flushed synchronously one
 * frame at a time; `Date.now` is pinned so the fallback cadence is exact (no
 * wall-clock dependence). `scrollHeight`/`clientHeight`/`scrollTop` are own-
 * property getters on the scroll element (so reads/writes are observable and
 * no real scroll events fire to perturb `autoFollow`).
 */
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { installDom } from '../_helpers/dom';
installDom();

import { h, render } from 'preact';
import { act } from 'preact/test-utils';

import { EMPTY_TRANSCRIPT_WINDOW } from '../../src/shared/protocol';
import {
  AUTO_FOLLOW_FALLBACK_READ_MS,
  useTranscriptScroll,
} from '../../src/webview/panel/transcript/use-transcript-scroll';

type ScrollResult = ReturnType<typeof useTranscriptScroll>;

const noop = () => {};
const TRANSCRIPT_WINDOW = { ...EMPTY_TRANSCRIPT_WINDOW, hasUserMessages: true };

// ── Controlled rAF + Date.now (deterministic frame/time driving) ──────────────

let rafMap = new Map<number, () => void>();
let rafCounter = 0;
let nowMs = 1000;
let origRaf: unknown;
let origCaf: unknown;
let origDateNow: typeof Date.now;

function installFakeTimers(): void {
  origRaf = globalThis.requestAnimationFrame;
  origCaf = globalThis.cancelAnimationFrame;
  origDateNow = Date.now;
  rafMap = new Map();
  rafCounter = 0;
  nowMs = 1000;
  globalThis.requestAnimationFrame = ((cb: (t: number) => void) => {
    const id = ++rafCounter;
    rafMap.set(id, () => cb(nowMs));
    return id;
  }) as typeof globalThis.requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((id: number) => {
    rafMap.delete(id);
  }) as typeof globalThis.cancelAnimationFrame;
  Date.now = (() => nowMs) as typeof Date.now;
}

function restoreTimers(): void {
  globalThis.requestAnimationFrame = origRaf as typeof globalThis.requestAnimationFrame;
  globalThis.cancelAnimationFrame = origCaf as typeof globalThis.cancelAnimationFrame;
  Date.now = origDateNow;
}

/** Run `n` animation frames. Each frame executes every rAF callback queued at
 *  the start of the frame (a tick re-queues for the next frame). */
function flushFrames(n: number): void {
  for (let i = 0; i < n; i++) {
    const batch = Array.from(rafMap.values());
    rafMap.clear();
    for (const fn of batch) fn();
  }
}

// ── Probe + metric spies ──────────────────────────────────────────────────────

const capture: { r: ScrollResult | null } = { r: null };

function Probe({ contentSignature, busy }: { contentSignature: string; busy: boolean }) {
  const r = useTranscriptScroll({
    sessionKey: '/s',
    transcriptWindow: TRANSCRIPT_WINDOW,
    transcriptLength: 1,
    busy,
    onLoadOlder: noop,
    onLoadNewer: noop,
    onJumpToLatest: noop,
    contentSignature,
  });
  capture.r = r;
  return h('div', { id: 'scroll-host', ref: r.scrollRef });
}

let scrollHeightValue = 1000;
let scrollHeightReads = 0;
const clientHeightValue = 200;
let scrollTopValue = 0;

function spyMetrics(el: HTMLElement): void {
  scrollHeightReads = 0;
  scrollHeightValue = 1000;
  scrollTopValue = 0;
  Object.defineProperty(el, 'scrollHeight', {
    get() { scrollHeightReads++; return scrollHeightValue; },
    configurable: true,
  });
  Object.defineProperty(el, 'clientHeight', {
    get() { return clientHeightValue; },
    configurable: true,
  });
  // Own-property scrollTop so writes don't dispatch a real scroll event (which
  // would perturb autoFollow via the scroll listener) and the value is
  // observable.
  Object.defineProperty(el, 'scrollTop', {
    get() { return scrollTopValue; },
    set(v: number) { scrollTopValue = v; },
    configurable: true,
  });
}

let container: HTMLElement;
let el: HTMLElement;

beforeEach(() => {
  installFakeTimers();
  container = document.createElement('div');
  document.body.appendChild(container);
  capture.r = null;
});

afterEach(() => {
  act(() => { render(null, container); });
  container.remove();
  restoreTimers();
});

function mountProbe(contentSignature: string, busy: boolean): void {
  act(() => { render(h(Probe, { contentSignature, busy }), container); });
  el = container.querySelector('#scroll-host') as HTMLElement;
  spyMetrics(el);
}

/** Let the mount-time positioning window settle (clear `isInitialPositioning`)
 *  and seed scrollTop at the bottom, then reset the read counter so subsequent
 *  reads are attributable to the behavior under test.
 *
 *  Two flush passes: the first clears the positioning window, which flips
 *  `isInitialPositioning` (a `useSmoothAutoFollow` dep) and rebuilds its effect
 *  during act's flush; the rebuilt effect's first tick then runs on the SECOND
 *  pass and does its one seeding `scrollHeight` read (lastReadAt starts at 0, so
 *  the fallback fires once to seed `cachedTarget`). After that, stable frames
 *  read nothing. */
function settle(): void {
  act(() => flushFrames(8));
  act(() => flushFrames(8));
  scrollHeightReads = 0;
}

test('auto-follow tracks scrollHeight growth and reads scrollHeight only when content changes', () => {
  mountProbe('sig0', true);
  settle();
  assert.equal(capture.r!.autoFollowRef.current, true, 'auto-follow must be engaged after settle');
  assert.equal(scrollHeightReads, 0, 'sanity: reads reset after settle');
  assert.equal(scrollTopValue, scrollHeightValue, 'sanity: pinned to the bottom');

  // Grow content: signature changes + scrollHeight grows. One frame should read
  // scrollHeight exactly once (signature changed) and advance scrollTop toward it.
  scrollHeightValue = 1500;
  act(() => {
    render(h(Probe, { contentSignature: 'sig1', busy: true }), container);
    flushFrames(1);
  });
  assert.equal(scrollHeightReads, 1, 'a content-signature change should trigger exactly one scrollHeight read');
  assert.ok(scrollTopValue > 1000, `scrollTop should advance toward the grown target (got ${scrollTopValue})`);

  // Stable frames: signature unchanged → cached target reused, NO new reads,
  // while the ease still advances scrollTop toward the cached target.
  const readsBeforeStable = scrollHeightReads;
  act(() => flushFrames(40));
  assert.equal(scrollHeightReads, readsBeforeStable, 'stable-content frames must not re-read scrollHeight (no forced reflow)');
  assert.equal(scrollTopValue, 1500, 'scrollTop should have eased to the cached target (auto-follow tracks growth)');
});

test('idle-but-busy frames with stable content force no scrollHeight read', () => {
  mountProbe('sig0', true);
  settle();
  assert.equal(capture.r!.autoFollowRef.current, true, 'auto-follow engaged');
  assert.equal(scrollTopValue, scrollHeightValue, 'sanity: pinned to the bottom');
  const readsBefore = scrollHeightReads;

  // busy + auto-follow + stable content → the loop runs but must NOT read
  // scrollHeight (cached target is still valid).
  act(() => flushFrames(10));
  assert.equal(scrollHeightReads, readsBefore, 'idle frames (busy, auto-follow, stable content) must not read scrollHeight');
});

test('fallback cadence re-reads to catch non-streaming height changes the signature cannot see', () => {
  mountProbe('sig0', true);
  settle();
  // Simulate a late image / markdown load: scrollHeight grows WITHOUT a
  // content-signature change (the signature only observes transcript content,
  // not reflows). The loop must eventually re-read so the view re-pins.
  scrollHeightValue = 1800;
  const readsBeforeFallback = scrollHeightReads;

  // No wall-clock advance yet → no fallback read; the unsignaled growth is not
  // seen (this is the accepted latency window for late loads).
  act(() => flushFrames(3));
  assert.equal(scrollHeightReads, readsBeforeFallback, 'before the fallback interval, an unsignaled height change is not yet read');

  // Advance wall-clock past the fallback cadence → the next frame re-reads.
  nowMs += AUTO_FOLLOW_FALLBACK_READ_MS + 50;
  act(() => flushFrames(40));
  assert.equal(scrollHeightReads, readsBeforeFallback + 1, 'after the fallback interval, an unsignaled height change is re-read exactly once');
  assert.equal(scrollTopValue, 1800, 'scrollTop should re-pin to the late-loaded height');
});
