/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { options, render } from 'preact';

import type {
  ChatMessage,
  ComposerInput,
  HostToWebviewMessage,
  SessionSummary,
  ViewState,
  WebviewToHostMessage,
} from '../../shared/protocol';
import { WEBVIEW_PROTOCOL_VERSION } from '../../shared/protocol';
import { App, EMPTY_VIEW_STATE, type AppAdapter } from './app';
import { defaultDevFixtureId, getDevFixture, getDevFixtureIds } from './dev-fixtures';

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

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function createId(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getQueryParam(name: string): string | null {
  return new URLSearchParams(window.location.search).get(name);
}

function applyTheme(rawTheme: string | null | undefined): void {
  const theme = rawTheme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}

function transcriptWindowFor(transcript: ChatMessage[], previous: ViewState['transcriptWindow']): ViewState['transcriptWindow'] {
  return {
    ...previous,
    totalCount: transcript.length,
    loadedEnd: transcript.length,
    hasUserMessages: transcript.some((message) => message.role === 'user'),
  };
}

function activeSessionWithCount(state: ViewState, messageCount: number): SessionSummary | null {
  if (!state.activeSession) {
    return null;
  }

  return {
    ...state.activeSession,
    modifiedAt: new Date().toISOString(),
    messageCount,
  };
}

function updateActiveSessionSummary(state: ViewState, nextActiveSession: SessionSummary | null): ViewState {
  if (!nextActiveSession) {
    return { ...state, activeSession: null };
  }

  return {
    ...state,
    activeSession: nextActiveSession,
    sessions: state.sessions.map((session) => (
      session.path === nextActiveSession.path ? nextActiveSession : session
    )),
  };
}

function appendMessages(state: ViewState, messages: ChatMessage[]): ViewState {
  const transcript = [...state.transcript, ...messages];
  return updateActiveSessionSummary({
    ...state,
    transcript,
    transcriptWindow: transcriptWindowFor(transcript, state.transcriptWindow),
  }, activeSessionWithCount(state, transcript.length));
}

function createAssistantResponse(text: string, status: ChatMessage['status'] = 'completed'): ChatMessage {
  return {
    id: createId('dev-assistant'),
    role: 'assistant',
    createdAt: new Date().toISOString(),
    markdown: text,
    parts: [{ kind: 'text', text }],
    modelId: 'gpt-5.4-mini',
    thinkingLevel: 'medium',
    status,
  };
}

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

  function postMessage(msg: WebviewToHostMessage): void {
    console.info('[pie webview dev]', msg);

    switch (msg.type) {
      case 'ready':
      case 'refreshState':
      case 'requestSnapshot':
        publishState();
        return;

      case 'send': {
        const text = msg.text || '(sent attachments)';
        const userMessage: ChatMessage = {
          id: msg.localId ?? createId('dev-user'),
          role: 'user',
          createdAt: new Date().toISOString(),
          markdown: text,
          status: 'completed',
        };
        const assistantMessage = createAssistantResponse('Browser dev host is simulating a response so layout changes can be inspected quickly.', 'streaming');

        mutate((current) => ({
          ...appendMessages(current, [userMessage, assistantMessage]),
          busy: true,
          runningSessionPaths: msg.sessionPath ? [msg.sessionPath] : current.runningSessionPaths,
          pendingComposerInputs: [],
        }));

        window.setTimeout(() => {
          mutate((current) => {
            const transcript = current.transcript.map((message) => (
              message.id === assistantMessage.id
                ? {
                    ...message,
                    markdown: 'Browser dev host response complete. Try `?state=long`, `?state=attachments`, or `?state=error` for other UI stress cases.',
                    parts: [{ kind: 'text' as const, text: 'Browser dev host response complete. Try `?state=long`, `?state=attachments`, or `?state=error` for other UI stress cases.' }],
                    status: 'completed' as const,
                    durationMs: 850,
                  }
                : message
            ));

            return {
              ...updateActiveSessionSummary({
                ...current,
                transcript,
                transcriptWindow: transcriptWindowFor(transcript, current.transcriptWindow),
              }, activeSessionWithCount(current, transcript.length)),
              busy: false,
              runningSessionPaths: [],
            };
          });
        }, 850);
        return;
      }

      case 'interrupt':
        mutate((current) => ({
          ...current,
          busy: false,
          runningSessionPaths: current.runningSessionPaths.filter((path) => path !== msg.sessionPath),
          transcript: current.transcript.map((message, index) => (
            index === current.transcript.length - 1 && message.role === 'assistant' && message.status === 'streaming'
              ? { ...message, status: 'interrupted' as const }
              : message
          )),
        }));
        return;

      case 'openFilePicker':
        addComposerInput({
          id: createId('input-path'),
          kind: 'filesystemPathRef',
          path: '/workspace/pi-config/docs/model-token-pricing-implementation-plan.md',
          name: 'model-token-pricing-implementation-plan.md',
          source: 'picker',
        });
        return;

      case 'addComposerInput':
        addComposerInput({ ...msg.input, id: createId('input') } as ComposerInput);
        return;

      case 'removeComposerInput':
        mutate((current) => ({
          ...current,
          pendingComposerInputs: current.pendingComposerInputs.filter((input) => input.id !== msg.inputId),
        }));
        return;

      case 'openSession':
        mutate((current) => ({
          ...current,
          activeSession: current.sessions.find((session) => session.path === msg.sessionPath) ?? current.activeSession,
          openTabPaths: current.openTabPaths.includes(msg.sessionPath)
            ? current.openTabPaths
            : [...current.openTabPaths, msg.sessionPath],
        }));
        return;

      case 'newSession': {
        const path = `/workspace/.pie/sessions/browser-dev-${Date.now()}.jsonl`;
        const session: SessionSummary = {
          path,
          name: 'Browser dev session',
          cwd: '/workspace/pi-config',
          modifiedAt: new Date().toISOString(),
          messageCount: 0,
          modelId: 'gpt-5.4-mini',
          thinkingLevel: 'medium',
        };
        mutate((current) => ({
          ...current,
          sessions: [session, ...current.sessions],
          openTabPaths: [path, ...current.openTabPaths],
          activeSession: session,
          transcript: [],
          transcriptWindow: transcriptWindowFor([], current.transcriptWindow),
          transcriptLoaded: true,
        }));
        return;
      }

      case 'closeSession':
        mutate((current) => {
          const openTabPaths = current.openTabPaths.filter((path) => path !== msg.sessionPath);
          const activeSession = current.activeSession?.path === msg.sessionPath
            ? current.sessions.find((session) => session.path === openTabPaths[0]) ?? null
            : current.activeSession;
          return { ...current, openTabPaths, activeSession };
        });
        return;

      case 'duplicateSession':
        mutate((current) => {
          const source = current.sessions.find((session) => session.path === msg.sessionPath);
          if (!source) return current;
          const duplicate = { ...source, path: `${source.path}.copy-${Date.now()}`, name: `${source.name} copy` };
          return {
            ...current,
            sessions: [duplicate, ...current.sessions],
            openTabPaths: [duplicate.path, ...current.openTabPaths],
            activeSession: duplicate,
          };
        });
        return;

      case 'moveSessionTab':
        mutate((current) => {
          const openTabPaths = [...current.openTabPaths];
          const [moved] = openTabPaths.splice(msg.fromIndex, 1);
          if (!moved) return current;
          openTabPaths.splice(msg.toIndex, 0, moved);
          return { ...current, openTabPaths };
        });
        return;

      case 'setModel':
        mutate((current) => updateActiveSessionSummary(current, current.activeSession
          ? { ...current.activeSession, modelId: msg.defaultModel, thinkingLevel: msg.defaultThinkingLevel }
          : null));
        return;

      case 'setPrefs':
        mutate((current) => ({
          ...current,
          prefs: {
            ...current.prefs,
            ...msg.prefs,
            extensionToggles: { ...current.prefs.extensionToggles, ...(msg.prefs.extensionToggles ?? {}) },
            providerToggles: { ...current.prefs.providerToggles, ...(msg.prefs.providerToggles ?? {}) },
          },
        }));
        return;

      case 'setPruningSettings':
        mutate((current) => ({
          ...current,
          pruningSettings: { ...current.pruningSettings, ...msg.settings },
        }));
        return;

      case 'startEdit':
        mutate((current) => ({ ...current, editingMessageId: msg.messageId }));
        return;

      case 'cancelEdit':
        mutate((current) => ({ ...current, editingMessageId: null }));
        return;

      case 'editMessage':
        mutate((current) => ({
          ...current,
          editingMessageId: null,
          transcript: current.transcript.map((message) => (
            message.id === msg.messageId ? { ...message, markdown: msg.text } : message
          )),
        }));
        return;

      case 'dismissNotice':
        mutate((current) => ({ ...current, notice: null }));
        return;

      case 'openOutcomeDialog':
        mutate((current) => ({ ...current, showOutcomeDialog: true }));
        return;

      case 'closeOutcomeDialog':
        mutate((current) => ({ ...current, showOutcomeDialog: false }));
        return;

      case 'recordOutcome':
        mutate((current) => ({
          ...current,
          showOutcomeDialog: false,
          notice: `Recorded ${msg.outcome.resolution} with satisfaction ${msg.outcome.satisfaction}.`,
        }));
        return;

      case 'openFile':
      case 'openFileDiff':
        mutate((current) => ({ ...current, notice: `Browser dev host would open ${'filePath' in msg ? msg.filePath : msg.path}.` }));
        return;

      case 'revertFile':
        mutate((current) => ({
          ...current,
          fileChanges: current.fileChanges.filter((change) => change.path !== msg.filePath),
          notice: `Browser dev host reverted ${msg.filePath}.`,
        }));
        return;

      case 'extensionUiResponse':
        mutate((current) => ({
          ...current,
          pendingExtensionUIRequest: null,
          notice: `Extension UI response captured for ${msg.response.id}.`,
        }));
        return;

      case 'stateApplied':
      case 'loadOlderTranscript':
      case 'loadNewerTranscript':
      case 'jumpToLatestTranscript':
      case 'startNewTask':
      case 'continueTask':
        return;
    }
  }

  return {
    initialState: clone(state),
    postMessage,
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
