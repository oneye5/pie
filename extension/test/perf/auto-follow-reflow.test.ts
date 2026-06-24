/**
 * Auto-follow target-refresh harness for `useSmoothAutoFollow`.
 *
 * The loop eases `scrollTop` toward a cached *bottom* target
 * (`scrollHeight - clientHeight`) that `useRefreshFollowTarget` keeps fresh.
 * It NEVER reads `scrollHeight`/`clientHeight` itself (no per-frame forced
 * reflow). The target is re-read exactly once per content-height change, keyed
 * on the virtualizer's `totalSize` — which changes for EVERY height-relevant
 * mutation (streaming markdown, tool-body output, reasoning/preview
 * expand-collapse, late image/table loads, drag-resizes), because each measured
 * row's ResizeObserver → `measureElement` → `totalSize`.
 *
 * This replaced a data-model content signature + 250ms fallback cadence. That
 * signature only observed streaming-message prose, so every OTHER growth source
 * (tool output, reasoning, previews, late loads) was seen at most once per 250ms
 * — up to ~250px of persistent drift during regular agent work. `totalSize`
 * sees all of them immediately, so the follow stays pinned.
 *
 * happy-dom has no layout engine — `scrollHeight`/`clientHeight` are always 0
 * and reading them is free — so the *forced-reflow* cost can't be measured
 * here (that needs a real browser). What this harness DOES prove, faithfully:
 *   (1) auto-follow tracks growth (correctness) — a `totalSize` change re-reads
 *       `scrollHeight` exactly once and advances `scrollTop` toward the new
 *       bottom, for ANY growth source (totalSize is source-agnostic);
 *   (2) stable-content frames read `scrollHeight` ZERO times (the loop reuses
 *       the cached target — no per-frame reflow);
 *   (3) every `totalSize` change re-pins IMMEDIATELY — there is no timed
 *       fallback cadence anymore (no `Date.now` dependency), so a late image /
 *       table load is caught the same frame its row re-measures, not 250ms
 *       later.
 *
 * Determinism: `requestAnimationFrame` is faked and flushed synchronously one
 * frame at a time. `scrollHeight`/`clientHeight`/`scrollTop` are own-property
 * getters on the scroll element (so reads/writes are observable and no real
 * scroll events fire to perturb `autoFollow`). `totalSize` is driven as a pure
 * change-trigger tick (its value is irrelevant — only that it changes), decoupled
 * from the spied `scrollHeight`.
 */
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { installDom } from '../_helpers/dom';
installDom();

import { h, render } from 'preact';
import { useRef } from 'preact/hooks';
import { act } from 'preact/test-utils';

import { EMPTY_TRANSCRIPT_WINDOW } from '../../src/shared/protocol';
import { useTranscriptScroll } from '../../src/webview/panel/transcript/use-transcript-scroll';

type ScrollResult = ReturnType<typeof useTranscriptScroll>;

const noop = () => {};
const TRANSCRIPT_WINDOW = { ...EMPTY_TRANSCRIPT_WINDOW, hasUserMessages: true };

// ── Controlled rAF (deterministic frame driving) ──────────────────────────────

let rafMap = new Map<number, () => void>();
let rafCounter = 0;
let origRaf: unknown;
let origCaf: unknown;

function installFakeRaf(): void {
  origRaf = globalThis.requestAnimationFrame;
  origCaf = globalThis.cancelAnimationFrame;
  rafMap = new Map();
  rafCounter = 0;
  globalThis.requestAnimationFrame = ((cb: (t: number) => void) => {
    const id = ++rafCounter;
    rafMap.set(id, () => cb(0));
    return id;
  }) as typeof globalThis.requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((id: number) => {
    rafMap.delete(id);
  }) as typeof globalThis.cancelAnimationFrame;
}

function restoreRaf(): void {
  globalThis.requestAnimationFrame = origRaf as typeof globalThis.requestAnimationFrame;
  globalThis.cancelAnimationFrame = origCaf as typeof globalThis.cancelAnimationFrame;
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

function Probe({ totalSize, busy }: { totalSize: number; busy: boolean }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const r = useTranscriptScroll({
    scrollRef,
    sessionKey: '/s',
    transcriptWindow: TRANSCRIPT_WINDOW,
    transcriptLength: 1,
    busy,
    onLoadOlder: noop,
    onLoadNewer: noop,
    onJumpToLatest: noop,
    totalSize,
  });
  capture.r = r;
  return h('div', { id: 'scroll-host', ref: scrollRef });
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

const bottom = () => scrollHeightValue - clientHeightValue;

let container: HTMLElement;
let el: HTMLElement;
let tick = 0;

beforeEach(() => {
  installFakeRaf();
  container = document.createElement('div');
  document.body.appendChild(container);
  capture.r = null;
  tick = 0;
});

afterEach(() => {
  act(() => { render(null, container); });
  container.remove();
  restoreRaf();
});

/** Re-render the Probe with a fresh `totalSize` tick so the target-refresh
 *  layout effect re-runs (it keys on totalSize). `flush` rAF frames after. */
function rerender(busy: boolean, flush: number): void {
  tick += 1;
  act(() => {
    render(h(Probe, { totalSize: tick, busy }), container);
    if (flush > 0) flushFrames(flush);
  });
}

function mountProbe(busy: boolean): void {
  tick = 1;
  act(() => { render(h(Probe, { totalSize: tick, busy }), container); });
  el = container.querySelector('#scroll-host') as HTMLElement;
  spyMetrics(el);
}

/** Let the mount-time positioning window settle (clear `isInitialPositioning`)
 *  and ease `scrollTop` to the cached bottom, then reset the read counter so
 *  subsequent reads are attributable to the behavior under test.
 *
 *  The rerender here is load-bearing: `mountProbe` spies metrics AFTER the
 *  initial render, so the mount-time layout effect seeded the target with
 *  happy-dom's un-spied 0. Bumping `totalSize` forces the layout effect to
 *  re-run under the spy, seeding the real bottom before the ease. */
function settle(): void {
  rerender(true, 12);
  scrollHeightReads = 0;
}

test('auto-follow tracks totalSize growth and reads scrollHeight only once per change', () => {
  mountProbe(true);
  settle();
  assert.equal(capture.r!.autoFollowRef.current, true, 'auto-follow must be engaged after settle');
  assert.equal(scrollHeightReads, 0, 'sanity: reads reset after settle');
  assert.equal(scrollTopValue, bottom(), 'sanity: pinned to the bottom');

  const scrollTopBefore = scrollTopValue;

  // Grow content: totalSize changes (the source-agnostic signal for ANY row
  // growth — streaming markdown, tool-body output, reasoning, previews, late
  // loads) + scrollHeight grows. The totalSize-keyed layout effect re-reads
  // scrollHeight exactly once; the loop then eases scrollTop toward the new
  // bottom without reading scrollHeight itself.
  scrollHeightValue = 1500;
  rerender(true, 1);
  assert.equal(scrollHeightReads, 1, 'a totalSize change should trigger exactly one scrollHeight read');
  assert.ok(scrollTopValue > scrollTopBefore, `scrollTop should advance toward the grown bottom (got ${scrollTopValue})`);

  // Stable frames: totalSize unchanged → the layout effect doesn't re-run and
  // the loop reuses the cached target, so NO new scrollHeight reads, while the
  // ease still advances scrollTop toward it.
  const readsBeforeStable = scrollHeightReads;
  act(() => flushFrames(40));
  assert.equal(scrollHeightReads, readsBeforeStable, 'stable-content frames must not re-read scrollHeight (no forced reflow)');
  assert.equal(scrollTopValue, bottom(), 'scrollTop should have eased to the cached bottom (auto-follow tracks growth)');
});

test('idle-but-busy frames with stable content force no scrollHeight read', () => {
  mountProbe(true);
  settle();
  assert.equal(capture.r!.autoFollowRef.current, true, 'auto-follow engaged');
  assert.equal(scrollTopValue, bottom(), 'sanity: pinned to the bottom');
  const readsBefore = scrollHeightReads;

  // busy + auto-follow + stable content → the loop runs but must NOT read
  // scrollHeight (cached target is still valid).
  act(() => flushFrames(10));
  assert.equal(scrollHeightReads, readsBefore, 'idle frames (busy, auto-follow, stable content) must not read scrollHeight');
});

test('every totalSize change re-pins immediately — no timed fallback cadence', () => {
  mountProbe(true);
  settle();
  // Simulate a late image / table load: scrollHeight grows, and because the
  // row re-measures, totalSize grows too. There is no longer a 250ms fallback
  // cadence — the totalSize-keyed layout effect re-reads on the change render,
  // so the view re-pins the same frame, not 250ms later.
  scrollHeightValue = 1800;
  const readsBefore = scrollHeightReads;
  const scrollTopBefore = scrollTopValue;

  rerender(true, 1);
  assert.equal(scrollHeightReads, readsBefore + 1, 'a totalSize change re-reads scrollHeight immediately (no wall-clock wait)');
  assert.ok(scrollTopValue > scrollTopBefore, 'scrollTop should advance toward the new bottom immediately');

  // No clock is advanced between changes; the read is purely change-driven.
  act(() => flushFrames(40));
  assert.equal(scrollTopValue, bottom(), 'scrollTop should re-pin to the late-loaded height');
});
