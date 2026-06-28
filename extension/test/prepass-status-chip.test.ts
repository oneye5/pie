/**
 * Brief F — Pruning prepass UX: live, cancelable status chip (webview-only).
 *
 * Uses the app-smoke pattern (mount App, post a `state` message) to verify the
 * chip renders off the host-projected `prepassPhase` / `prepassStartedAt` /
 * `prepassLatencyMs` fields, the elapsed display is derived deterministically,
 * and Cancel reuses Brief E's interrupt dispatch (posts an `interrupt` for the
 * active session — the host turns it into `abortInFlightSend` + `message.interrupt`).
 *
 * A fake clock stubs `Date.now` / `window.setInterval` / `window.clearInterval`
 * so the elapsed display is deterministic and no real timer fires (the tick is
 * allowlisted webview-local animation/telemetry state; tests assert on the
 * rendered phase/startedAt, never on real setInterval timing).
 */
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { installDom } from './_helpers/dom';
installDom();

// Stub DOMPurify before any component imports
import DOMPurify from 'dompurify';
DOMPurify.sanitize = ((html: string) => html) as typeof DOMPurify.sanitize;

import { h, render } from 'preact';
import { act } from 'preact/test-utils';

import { App, EMPTY_VIEW_STATE } from '../src/webview/panel/app';
import type { AppAdapter } from '../src/webview/panel/app';
import type { ViewState, ChatMessage, HostToWebviewMessage } from '../src/shared/protocol';
import { EMPTY_TRANSCRIPT_WINDOW } from '../src/shared/protocol';

function makeAdapter(): AppAdapter & { messages: any[] } {
  const messages: any[] = [];
  return { messages, postMessage: (msg: any) => messages.push(msg) };
}

function sessionViewState(overrides: Partial<ViewState> = {}): ViewState {
  return {
    ...EMPTY_VIEW_STATE,
    backendReady: true,
    openTabPaths: ['/session/a'],
    activeSession: {
      path: '/session/a',
      name: 'Session A',
      cwd: '/workspace',
      modifiedAt: '2026-01-01T00:00:00.000Z',
      messageCount: 2,
    },
    transcript: [
      {
        id: 'user-1',
        role: 'user',
        createdAt: '2026-01-01T12:00:00.000Z',
        markdown: 'Hello world',
        status: 'completed',
      } as ChatMessage,
    ],
    transcriptWindow: { ...EMPTY_TRANSCRIPT_WINDOW, hasNewer: false, hasOlder: false },
    transcriptLoaded: true,
    ...overrides,
  };
}

/** Deterministic clock: `Date.now` is pinned and `setInterval`/`clearInterval`
 *  are no-ops so the chip's elapsed display is a pure function of the
 *  `prepassStartedAt` we feed it (no real timer ever fires). */
function installFakeClock(nowMs: number): () => void {
  const originalDateNow = Date.now;
  const originalSetInterval = window.setInterval;
  const originalClearInterval = window.clearInterval;
  Date.now = () => nowMs;
  window.setInterval = (() => 1) as unknown as typeof window.setInterval;
  window.clearInterval = (() => {}) as unknown as typeof window.clearInterval;
  return () => {
    Date.now = originalDateNow;
    window.setInterval = originalSetInterval;
    window.clearInterval = originalClearInterval;
  };
}

let container: HTMLElement;

beforeEach(() => {
  container = document.createElement('div');
  container.id = 'app';
  document.body.appendChild(container);
  return () => {
    render(null, container);
    container.remove();
  };
});

function postState(state: ViewState, revision = 1): void {
  const msg: HostToWebviewMessage = {
    type: 'state',
    hostInstanceId: 'host-1',
    revision,
    state,
  } as any;
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: msg }));
  });
}

test('Brief F: no prepass chip while phase is idle', () => {
  const restore = installFakeClock(10_000);
  try {
    const adapter = makeAdapter();
    adapter.initialState = sessionViewState({ prepassPhase: 'idle', prepassStartedAt: null });

    act(() => {
      render(h(App, { adapter }), container);
    });

    assert.equal(container.querySelector('.prepass-status-chip'), null, 'no chip while idle');
  } finally {
    restore();
  }
});

test('Brief F: live chip renders while prepassPhase is running with a deterministic elapsed + Cancel affordance', () => {
  // Date.now pinned to 10000; startedAt 5000 → elapsed = floor(5000/1000) = 5s.
  const restore = installFakeClock(10_000);
  try {
    const adapter = makeAdapter();
    adapter.initialState = sessionViewState();

    act(() => {
      render(h(App, { adapter }), container);
    });

    postState(sessionViewState({ prepassPhase: 'running', prepassStartedAt: 5_000 }));

    const runningChip = container.querySelector('.prepass-status-chip-running');
    assert.ok(runningChip, 'live chip should render while running');
    assert.match(runningChip!.textContent!, /Pruning context/);
    // Deterministic elapsed (derived from the pinned clock, not real timing).
    assert.match(runningChip!.textContent!, /5s/);

    const cancelBtn = container.querySelector('[aria-label="Cancel pruning prepass"]');
    assert.ok(cancelBtn, 'Cancel affordance should be present on the running chip');
  } finally {
    restore();
  }
});

test('Brief F: Cancel reuses Brief E interrupt dispatch (posts interrupt for the active session)', () => {
  const restore = installFakeClock(10_000);
  try {
    const adapter = makeAdapter();
    adapter.initialState = sessionViewState();

    act(() => {
      render(h(App, { adapter }), container);
    });

    postState(sessionViewState({ prepassPhase: 'running', prepassStartedAt: 5_000 }));

    const cancelBtn = container.querySelector('[aria-label="Cancel pruning prepass"]') as HTMLButtonElement;
    assert.ok(cancelBtn);

    const interruptsBefore = adapter.messages.filter((m) => m.type === 'interrupt').length;
    act(() => {
      cancelBtn.click();
    });

    const interrupts = adapter.messages.filter((m) => m.type === 'interrupt');
    assert.equal(interrupts.length, interruptsBefore + 1, 'Cancel posts exactly one interrupt');
    assert.equal(interrupts.at(-1)!.sessionPath, '/session/a', 'interrupt targets the active session');
  } finally {
    restore();
  }
});

test('Brief F: post-hoc summary shows latency + actionable hint when the prepass exceeded the high-latency threshold', () => {
  const restore = installFakeClock(10_000);
  try {
    const adapter = makeAdapter();
    adapter.initialState = sessionViewState();

    act(() => {
      render(h(App, { adapter }), container);
    });

    // 12s latency > 10s threshold → hint surfaces the `prepassTimeoutSec` lever.
    postState(sessionViewState({ prepassPhase: 'succeeded', prepassLatencyMs: 12_000 }));

    const succeededChip = container.querySelector('.prepass-status-chip-succeeded');
    assert.ok(succeededChip, 'succeeded chip should render');
    assert.match(succeededChip!.textContent!, /Pruned in 12\.0s/);
    assert.match(container.textContent!, /prepassTimeoutSec/);
    assert.match(container.textContent!, /skip pruning/i);
  } finally {
    restore();
  }
});

test('Brief F: post-hoc summary is compact (no hint) when latency is under the threshold', () => {
  const restore = installFakeClock(10_000);
  try {
    const adapter = makeAdapter();
    adapter.initialState = sessionViewState();

    act(() => {
      render(h(App, { adapter }), container);
    });

    postState(sessionViewState({ prepassPhase: 'succeeded', prepassLatencyMs: 2_000 }));

    const succeededChip = container.querySelector('.prepass-status-chip-succeeded');
    assert.ok(succeededChip);
    assert.match(succeededChip!.textContent!, /Pruned in 2\.0s/);
    assert.doesNotMatch(container.textContent!, /prepassTimeoutSec/);
  } finally {
    restore();
  }
});

test('Brief F: failed phase renders a minimal failure note (Brief H owns the full error copy)', () => {
  const restore = installFakeClock(10_000);
  try {
    const adapter = makeAdapter();
    adapter.initialState = sessionViewState();

    act(() => {
      render(h(App, { adapter }), container);
    });

    postState(sessionViewState({ prepassPhase: 'failed' }));

    const failedChip = container.querySelector('.prepass-status-chip-failed');
    assert.ok(failedChip, 'failed chip should render');
    assert.match(failedChip!.textContent!, /Pruning failed/);
  } finally {
    restore();
  }
});

test('Brief F: chip disappears when the phase returns to idle (commit point clears the promoted op)', () => {
  const restore = installFakeClock(10_000);
  try {
    const adapter = makeAdapter();
    adapter.initialState = sessionViewState();

    act(() => {
      render(h(App, { adapter }), container);
    });

    postState(sessionViewState({ prepassPhase: 'running', prepassStartedAt: 5_000 }), 1);
    assert.ok(container.querySelector('.prepass-status-chip-running'), 'chip present while running');

    // Host clears the phase at the commit point (MessageStarted) → idle.
    postState(sessionViewState({ prepassPhase: 'idle', prepassStartedAt: null }), 2);
    assert.equal(container.querySelector('.prepass-status-chip'), null, 'chip cleared on idle');
  } finally {
    restore();
  }
});
