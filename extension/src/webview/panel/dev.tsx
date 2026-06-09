/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { options, render } from 'preact';

import type {
  ComposerInput,
  HostToWebviewMessage,
  ViewState,
} from '../../shared/protocol';
import { WEBVIEW_PROTOCOL_VERSION } from '../../shared/protocol';
import { App, EMPTY_VIEW_STATE, type AppAdapter } from './app';
import { defaultDevFixtureId, getDevFixture, getDevFixtureIds } from './dev-fixtures';
import { applyTheme, clone, DevHostActions, dispatchMessage, getQueryParam } from './dev-host-helpers';

declare global {
  interface Window {
    __PIE_WEBVIEW_DEV__?: {
      fixtures: string[];
      getState: () => ViewState;
      setFixture: (id: string) => void;
      setTheme: (theme: 'dark' | 'light') => void;
    };
  }
}

const hostInstanceId = 'pie-browser-dev-host';

function createDevHost(initialState: ViewState): AppAdapter & {
  getState: () => ViewState;
  setFixture: (id: string) => void;
} {
  let state = clone(initialState);
  let revision = 0;

  function publishState(): void {
    const message: HostToWebviewMessage = {
      type: 'state',
      protocolVersion: WEBVIEW_PROTOCOL_VERSION,
      hostInstanceId,
      revision: ++revision,
      state: clone(state),
    };

    window.dispatchEvent(new MessageEvent('message', { data: message }));
  }

  function mutate(updater: (current: ViewState) => ViewState): void {
    state = updater(clone(state));
    publishState();
  }

  function addComposerInput(input: ComposerInput): void {
    mutate((current) => ({
      ...current,
      pendingComposerInputs: [...current.pendingComposerInputs, input],
    }));
  }

  const actions: DevHostActions = { mutate, addComposerInput, publishState };

  return {
    initialState: clone(state),
    postMessage: (msg) => dispatchMessage(actions, msg),
    getState: () => clone(state),
    setFixture: (id: string) => {
      state = clone(getDevFixture(id).state);
      revision = 0;
      publishState();
    },
  };
}

function createLiveHost(): AppAdapter {
  let eventSource: EventSource | null = null;

  try {
    eventSource = new EventSource('/api/events');
    eventSource.onmessage = (event) => {
      try {
        window.dispatchEvent(new MessageEvent('message', { data: JSON.parse(event.data) }));
      } catch (error) {
        console.error('[pie webview dev] Failed to parse host event', error);
      }
    };
    eventSource.onerror = () => {
      console.warn('[pie webview dev] Live host event stream disconnected.');
    };
  } catch (error) {
    console.error('[pie webview dev] Failed to connect to live host', error);
  }

  window.addEventListener('beforeunload', () => {
    eventSource?.close();
  });

  return {
    initialState: EMPTY_VIEW_STATE,
    postMessage: (msg) => {
      void fetch('/api/message', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(msg),
      }).catch((error) => {
        console.error('[pie webview dev] Failed to post message to live host', error);
      });
    },
  };
}

function showRenderErrorOverlay(error: unknown) {
  if (document.getElementById('pie-render-error-overlay')) return;

  const overlay = document.createElement('div');
  overlay.id = 'pie-render-error-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;padding:16px;overflow:auto;background:#1e1e1e;color:#f48771;font:12px/1.5 monospace;white-space:pre-wrap;';
  overlay.textContent = String((error as { stack?: unknown })?.stack ?? error);
  document.body.appendChild(overlay);
}

const prevCatchError = (options as any).__e;
(options as any).__e = (error: unknown, vnode: unknown, oldVNode: unknown) => {
  console.error('[pie webview dev] Preact render error:', error);
  showRenderErrorOverlay(error);
  if (prevCatchError) prevCatchError(error, vnode, oldVNode);
};

window.addEventListener('error', (event) => {
  console.error('[pie webview dev] Uncaught error:', event.error);
});

applyTheme(getQueryParam('theme'));

const fixtureId = getQueryParam('state');
const useFixtureHost = fixtureId !== null;
const fixtureHost = useFixtureHost
  ? createDevHost(getDevFixture(fixtureId ?? defaultDevFixtureId).state)
  : null;
const host = fixtureHost ?? createLiveHost();

window.__PIE_WEBVIEW_DEV__ = {
  fixtures: getDevFixtureIds(),
  getState: fixtureHost ? fixtureHost.getState : () => EMPTY_VIEW_STATE,
  setFixture: (id: string) => {
    const url = new URL(window.location.href);
    url.searchParams.set('state', id);
    history.replaceState(null, '', url);
    if (fixtureHost) {
      fixtureHost.setFixture(id);
    } else {
      window.location.assign(url.toString());
    }
  },
  setTheme: (theme: 'dark' | 'light') => {
    applyTheme(theme);
    const url = new URL(window.location.href);
    url.searchParams.set('theme', theme);
    history.replaceState(null, '', url);
  },
};

const container = document.getElementById('app');
if (container) {
  render(<App adapter={host} />, container);
}
