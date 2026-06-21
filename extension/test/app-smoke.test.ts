/**
 * Smoke test: mounts the App shell with a canned ViewState and asserts basic
 * rendering + interactions work without acquireVsCodeApi.
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
import { DEFAULT_CHAT_PREFS, EMPTY_TRANSCRIPT_WINDOW } from '../src/shared/protocol';

function makeAdapter(): AppAdapter & { messages: any[] } {
  const messages: any[] = [];
  return {
    messages,
    postMessage: (msg: any) => messages.push(msg),
  };
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
      {
        id: 'assistant-1',
        role: 'assistant',
        createdAt: '2026-01-01T12:00:01.000Z',
        markdown: 'Hi there!',
        parts: [{ kind: 'text', text: 'Hi there!' }],
        status: 'completed',
        modelId: 'test-model',
        thinkingLevel: 'off',
      } as ChatMessage,
    ],
    transcriptWindow: { ...EMPTY_TRANSCRIPT_WINDOW, hasNewer: false, hasOlder: false },
    transcriptLoaded: true,
    ...overrides,
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

test('App renders composer when session is active', () => {
  const adapter = makeAdapter();
  adapter.initialState = sessionViewState();

  act(() => {
    render(h(App, { adapter }), container);
  });

  const textarea = container.querySelector('textarea');
  assert.ok(textarea, 'Composer textarea should be rendered');
});

test('App composer keeps the quiet prompt-box focus treatment', () => {
  const adapter = makeAdapter();
  adapter.initialState = sessionViewState();

  act(() => {
    render(h(App, { adapter }), container);
  });

  const textarea = container.querySelector('textarea');
  assert.ok(textarea, 'Composer textarea should be rendered');
  assert.match(textarea.className, /outline-none/);

  const composerShell = textarea.parentElement;
  assert.ok(composerShell, 'Composer shell should wrap the textarea');
  assert.match(composerShell.className, /border-transparent/);
  assert.match(composerShell.className, /focus-within:border-border-subtle\/80/);
  assert.doesNotMatch(composerShell.className, /focus-within:border-accent/);
});

test('App renders transcript area when session is active', () => {
  const adapter = makeAdapter();
  adapter.initialState = sessionViewState();

  act(() => {
    render(h(App, { adapter }), container);
  });

  // The transcript scroll container should be present even if virtualizer
  // doesn't render rows (no real layout in happy-dom).
  const panelMain = container.querySelector('.panel-main');
  assert.ok(panelMain, 'Should render panel-main container');
});

test('App does not keep the transcript loader for a loaded empty session', () => {
  const adapter = makeAdapter();
  adapter.initialState = sessionViewState({
    activeSession: {
      path: '/session/a',
      name: 'Session A',
      cwd: '/workspace',
      modifiedAt: '2026-01-01T00:00:00.000Z',
      messageCount: 0,
    },
    transcript: [],
    transcriptWindow: { ...EMPTY_TRANSCRIPT_WINDOW },
    transcriptLoaded: true,
    systemPrompts: [],
  });

  act(() => {
    render(h(App, { adapter }), container);
  });

  assert.equal(
    container.querySelector('.transcript-loading'),
    null,
    'Should stop showing the transcript loader once an empty session has loaded',
  );
  assert.ok(container.querySelector('textarea'), 'Composer should remain available for an empty session');
});

test('App posts ready message on mount', () => {
  const adapter = makeAdapter();
  adapter.initialState = sessionViewState();

  act(() => {
    render(h(App, { adapter }), container);
  });

  assert.ok(
    adapter.messages.some((m) => m.type === 'ready'),
    'Should post ready message on mount',
  );
  assert.ok(
    adapter.messages.some((m) => m.type === 'refreshState'),
    'Should request a fresh host snapshot on mount',
  );
});

test('App posts send message when composer submits', () => {
  const adapter = makeAdapter();
  adapter.initialState = sessionViewState();

  act(() => {
    render(h(App, { adapter }), container);
  });

  // The App seeds first paint from initialState, but handleSend gates on the
  // active-session ref, which is only populated when the host posts a `state`
  // message (use-host-sync.ts). Drive that round-trip so the composer submit
  // actually reaches the host — mirrors the "App handles host state message"
  // test below.
  const stateMsg: HostToWebviewMessage = {
    type: 'state',
    hostInstanceId: 'host-1',
    revision: 1,
    state: sessionViewState(),
  } as any;
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: stateMsg }));
  });

  const textarea = container.querySelector('textarea');
  assert.ok(textarea);

  // Type text
  act(() => {
    (textarea as HTMLTextAreaElement).value = 'test message';
    textarea!.dispatchEvent(new Event('input', { bubbles: true }));
  });

  // Submit: the composer has no <form>; Enter posts the send.
  act(() => {
    textarea!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });

  const sendMsg = adapter.messages.find((m) => m.type === 'send');
  assert.ok(sendMsg, 'Composer submit should post a send message to the host');
  assert.equal(sendMsg!.text, 'test message');
  assert.equal(sendMsg!.sessionPath, '/session/a');
});

test('App renders loading state when backend not ready', () => {
  const adapter = makeAdapter();
  adapter.initialState = { ...EMPTY_VIEW_STATE };

  act(() => {
    render(h(App, { adapter }), container);
  });

  const html = container.innerHTML;
  assert.ok(html.includes('Starting pie'), 'Should show loading state');
});

test('App suppresses the session-tab connecting wheel while the transcript surface is already loading (no double wheel)', () => {
  const adapter = makeAdapter();
  adapter.initialState = {
    ...EMPTY_VIEW_STATE,
    backendReady: false,
    sessions: [{
      path: '/session/a',
      name: 'Session A',
      cwd: '/workspace',
      modifiedAt: '2026-01-01T00:00:00.000Z',
      messageCount: 0,
    }],
    openTabPaths: ['/session/a'],
    activeSession: {
      path: '/session/a',
      name: 'Session A',
      cwd: '/workspace',
      modifiedAt: '2026-01-01T00:00:00.000Z',
      messageCount: 0,
    },
    transcript: [],
    transcriptLoaded: false,
    systemPrompts: [],
  };

  act(() => {
    render(h(App, { adapter }), container);
  });

  const html = container.innerHTML;
  // The main transcript area shows the loading wheel + status indicator.
  assert.ok(html.includes('transcript-loading'), 'main transcript area should show a loading wheel');
  assert.ok(html.includes('loading-ellipsis'), 'a status indicator should accompany the wheel');
  // The session-tab connecting wheel is suppressed to avoid two wheels at once.
  assert.ok(!html.includes('session-tabs-connecting'), 'tabs should not show a competing connecting wheel while the main area is loading');
});

test('App renders empty state when no tabs open', () => {
  const adapter = makeAdapter();
  adapter.initialState = { ...EMPTY_VIEW_STATE, backendReady: true };

  act(() => {
    render(h(App, { adapter }), container);
  });

  const html = container.innerHTML;
  assert.ok(html.includes('Start a session'), 'Should show empty state');
});

test('App recovers when tabs exist but no active session is projected', () => {
  const adapter = makeAdapter();
  adapter.initialState = {
    ...EMPTY_VIEW_STATE,
    backendReady: true,
    sessions: [{
      path: '/session/a',
      name: 'Session A',
      cwd: '/workspace',
      modifiedAt: '2026-01-01T00:00:00.000Z',
      messageCount: 2,
    }],
    openTabPaths: ['/session/a'],
    activeSession: null,
  };

  act(() => {
    render(h(App, { adapter }), container);
  });

  const html = container.innerHTML;
  assert.ok(html.includes('Restoring session'), 'Should show recovery state instead of a blank panel');
  assert.ok(
    adapter.messages.some((m) => m.type === 'openSession' && m.sessionPath === '/session/a'),
    'Should request reopening the first available tab',
  );
});

test('App waits for backend readiness before requesting session recovery', () => {
  const adapter = makeAdapter();
  adapter.initialState = {
    ...EMPTY_VIEW_STATE,
    backendReady: false,
    sessions: [{
      path: '/session/a',
      name: 'Session A',
      cwd: '/workspace',
      modifiedAt: '2026-01-01T00:00:00.000Z',
      messageCount: 2,
    }],
    openTabPaths: ['/session/a'],
    activeSession: null,
  };

  act(() => {
    render(h(App, { adapter }), container);
  });

  assert.ok(container.innerHTML.includes('Restoring session'));
  assert.equal(
    adapter.messages.some((m) => m.type === 'openSession'),
    false,
    'Should not ask the host to open a restored tab before backend startup finishes',
  );
});

test('App retries session recovery request when projection stays unresolved', () => {
  const adapter = makeAdapter();
  adapter.initialState = {
    ...EMPTY_VIEW_STATE,
    backendReady: true,
    sessions: [{
      path: '/session/a',
      name: 'Session A',
      cwd: '/workspace',
      modifiedAt: '2026-01-01T00:00:00.000Z',
      messageCount: 2,
    }],
    openTabPaths: ['/session/a'],
    activeSession: null,
    notice: null,
  };

  const originalSetInterval = window.setInterval;
  const originalClearInterval = window.clearInterval;
  const originalDateNow = Date.now;
  let intervalCallback: (() => void) | null = null;
  let nowMs = 1_000;

  Date.now = () => nowMs;

  window.setInterval = ((callback: TimerHandler) => {
    intervalCallback = callback as () => void;
    return 1 as unknown as number;
  }) as typeof window.setInterval;

  window.clearInterval = (() => {
    intervalCallback = null;
  }) as typeof window.clearInterval;

  try {
    act(() => {
      render(h(App, { adapter }), container);
    });

    const firstRecoveryRequests = adapter.messages.filter(
      (m) => m.type === 'openSession' && m.sessionPath === '/session/a',
    );
    assert.equal(firstRecoveryRequests.length, 1, 'Should send initial recovery request');
    assert.ok(intervalCallback, 'Should arm a retry timer while recovery is unresolved');

    nowMs += 3_000;
    act(() => {
      intervalCallback?.();
    });

    const allRecoveryRequests = adapter.messages.filter(
      (m) => m.type === 'openSession' && m.sessionPath === '/session/a',
    );
    assert.equal(allRecoveryRequests.length, 2, 'Should retry recovery request when state stays unresolved');
  } finally {
    window.setInterval = originalSetInterval;
    window.clearInterval = originalClearInterval;
    Date.now = originalDateNow;
  }
});

test('App handles host state message', () => {
  const adapter = makeAdapter();

  act(() => {
    render(h(App, { adapter }), container);
  });

  // Simulate host sending state
  const stateMsg: HostToWebviewMessage = {
    type: 'state',
    hostInstanceId: 'host-1',
    revision: 1,
    state: sessionViewState(),
  } as any;

  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: stateMsg }));
  });

  // After receiving state with active session, the panel-main should contain
  // the transcript area (virtualizer may not render rows without layout).
  const panelMain = container.querySelector('.panel-main');
  assert.ok(panelMain, 'Should render panel-main after state message');
  // Composer should appear
  const textarea = container.querySelector('textarea');
  assert.ok(textarea, 'Composer should render after state message');
});

test('stateApplied telemetry samples DOM after render commit', async () => {
  const adapter = makeAdapter();
  adapter.initialState = {
    ...EMPTY_VIEW_STATE,
    backendReady: false,
    openTabPaths: ['/session/a'],
    activeSession: {
      path: '/session/a',
      name: 'Session A',
      cwd: '/workspace',
      modifiedAt: '2026-01-01T00:00:00.000Z',
      messageCount: 0,
    },
    transcript: [],
    transcriptWindow: { ...EMPTY_TRANSCRIPT_WINDOW },
    transcriptLoaded: false,
    systemPrompts: [],
  };

  act(() => {
    render(h(App, { adapter }), container);
  });

  const loadedStateMsg: HostToWebviewMessage = {
    type: 'state',
    hostInstanceId: 'host-1',
    revision: 2,
    state: sessionViewState(),
  } as any;

  await act(async () => {
    window.dispatchEvent(new MessageEvent('message', { data: loadedStateMsg }));
    await Promise.resolve();
  });

  const applied = adapter.messages
    .filter((m) => m.type === 'stateApplied')
    .at(-1);

  assert.ok(applied, 'Should emit stateApplied after applying host state');
  assert.equal(applied.payload.revision, 2);
  assert.equal(applied.payload.backendReady, true);
  assert.equal(applied.payload.transcriptLoaded, true);
  assert.equal(applied.payload.domTranscriptLoaderPresent, false);
  assert.equal(applied.payload.domTabsConnectingPresent, false);
});
