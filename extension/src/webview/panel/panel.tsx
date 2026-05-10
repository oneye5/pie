/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { render } from 'preact';
import { useState, useEffect, useRef, useCallback } from 'preact/hooks';

import type {
  ChatPrefs,
  HostToWebviewMessage,
  ModelInfo,
  ModelSettings,
  SessionSummary,
  ThinkingLevel,
  ViewState,
  WebviewToHostMessage,
} from '../../shared/protocol';
import { emptyOverlay, applyPatch } from './overlay';
import { TranscriptView } from './transcript';
import { SessionTabs, Composer } from './ui';

// ─── VS Code API ─────────────────────────────────────────────────────────────

declare function acquireVsCodeApi(): {
  postMessage(msg: WebviewToHostMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscodeApi = acquireVsCodeApi();

function postMessage(msg: WebviewToHostMessage): void {
  vscodeApi.postMessage(msg);
}

// ─── Default state ───────────────────────────────────────────────────────────

const EMPTY_VIEW_STATE: ViewState = {
  sessions: [],
  openTabPaths: [],
  runningSessionPaths: [],
  activeSession: null,
  transcript: [],
  busy: false,
  notice: null,
  backendReady: false,
  workspaceCwd: null,
  systemPrompt: null,
  modelSettings: null,
  availableModels: [],
  prefs: { autoExpandReasoning: false, autoExpandToolCalls: false },
};

// ─── App ─────────────────────────────────────────────────────────────────────

function App() {
  const [viewState, setViewState] = useState<ViewState>(EMPTY_VIEW_STATE);
  const [overlay, setOverlay] = useState(emptyOverlay);
  const [pendingPaths, setPendingPaths] = useState<string[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);

  // Track last revision via ref (not state) to avoid triggering snapshot requests on every re-render
  const lastRevisionRef = useRef(0);
  const hostInstanceIdRef = useRef('');

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const msg = event.data as HostToWebviewMessage;

      if (msg.type === 'state') {
        if (hostInstanceIdRef.current && msg.hostInstanceId !== hostInstanceIdRef.current) {
          lastRevisionRef.current = 0;
        }
        hostInstanceIdRef.current = msg.hostInstanceId;
        lastRevisionRef.current = msg.revision;
        setViewState(msg.state);
        setOverlay(emptyOverlay());
        return;
      }

      if (msg.type === 'patch') {
        if (hostInstanceIdRef.current && msg.hostInstanceId !== hostInstanceIdRef.current) {
          hostInstanceIdRef.current = msg.hostInstanceId;
          lastRevisionRef.current = 0;
        }
        const expected = lastRevisionRef.current + 1;
        if (lastRevisionRef.current > 0 && msg.revision !== expected) {
          postMessage({ type: 'requestSnapshot' });
          lastRevisionRef.current = msg.revision;
          return;
        }
        lastRevisionRef.current = msg.revision;
        setOverlay((prev) => applyPatch(prev, msg.op));
        return;
      }

      if (msg.type === 'filePickerResult') {
        setPendingPaths((prev) => {
          const next = [...prev];
          for (const p of msg.paths) {
            if (!next.includes(p)) next.push(p);
          }
          return next;
        });
      }
    };

    window.addEventListener('message', handleMessage);
    postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  const handleSend = useCallback(
    (text: string) => {
      const fullText = pendingPaths.length > 0
        ? `${pendingPaths.map((p) => `@${p}`).join('\n')}\n\n${text}`
        : text;
      setPendingPaths([]);
      postMessage({ type: 'send', text: fullText });
    },
    [pendingPaths],
  );

  const handleEditSend = useCallback((messageId: string, text: string) => {
    postMessage({ type: 'editMessage', messageId, text });
    setEditingId(null);
  }, []);

  const handleCancelEdit = useCallback(() => setEditingId(null), []);
  const handleInterrupt = useCallback(() => postMessage({ type: 'interrupt' }), []);
  const handleOpenFilePicker = useCallback(() => postMessage({ type: 'openFilePicker' }), []);
  const handleNewSession = useCallback(() => postMessage({ type: 'newSession' }), []);
  const handleSelectTab = useCallback((path: string) => postMessage({ type: 'openSession', sessionPath: path }), []);
  const handleCloseTab = useCallback((path: string) => postMessage({ type: 'closeSession', sessionPath: path }), []);

  const handleModelChange = useCallback((model: string, thinkingLevel: ThinkingLevel) => {
    postMessage({ type: 'setModel', defaultModel: model, defaultThinkingLevel: thinkingLevel });
  }, []);

  const handleEditRequest = useCallback((messageId: string) => {
    setEditingId(messageId);
  }, []);

  const handleSetPrefs = useCallback((partial: Partial<ChatPrefs>) => {
    postMessage({ type: 'setPrefs', prefs: partial });
  }, []);

  const {
    sessions, openTabPaths, runningSessionPaths, activeSession,
    transcript, busy, notice, backendReady, modelSettings, availableModels, prefs, systemPrompt,
  } = viewState;

  const hasActiveTabs = openTabPaths.length > 0;
  const statusLabel = busy ? 'Thinking' : backendReady ? 'Ready' : 'Starting';
  const statusClass = busy ? 'busy' : backendReady ? 'ready' : 'starting';

  return (
    <div id="app">
      {notice && (
        <div class={`notice${notice.toLowerCase().includes('error') || notice.toLowerCase().includes('fail') ? ' error' : ''}`}>
          {notice}
        </div>
      )}

      <SessionTabs
        sessions={sessions}
        openTabPaths={openTabPaths}
        runningSessionPaths={runningSessionPaths}
        activeSession={activeSession}
        backendReady={backendReady}
        statusLabel={statusLabel}
        statusClass={statusClass}
        onSelect={handleSelectTab}
        onClose={handleCloseTab}
        onNew={handleNewSession}
      />

      <div class="panel-main">
        {!hasActiveTabs ? (
          <div class="empty-state">
            <div class="empty-state-title">Start a session</div>
            <div class="empty-state-sub">
              {backendReady
                ? 'Sessions stay in tabs, and model settings remain visible while you work.'
                : 'The backend is still starting. New sessions will unlock once it is ready.'}
            </div>
            <button class="btn" onClick={handleNewSession} disabled={!backendReady}>New Session</button>
          </div>
        ) : (
          <TranscriptView
            transcript={transcript}
            busy={busy}
            overlay={overlay}
            prefs={prefs}
            systemPrompt={systemPrompt}
            editingId={editingId}
            onEditRequest={handleEditRequest}
            onEditConfirm={handleEditSend}
            onEditCancel={handleCancelEdit}
          />
        )}
      </div>

      {hasActiveTabs && (
        <Composer
          busy={busy}
          modelSettings={modelSettings}
          availableModels={availableModels}
          pendingPaths={pendingPaths}
          prefs={prefs}
          onSend={handleSend}
          onInterrupt={handleInterrupt}
          onOpenFilePicker={handleOpenFilePicker}
          onRemovePath={(p) => setPendingPaths((prev) => prev.filter((x) => x !== p))}
          onModelChange={handleModelChange}
          onSetPrefs={handleSetPrefs}
        />
      )}
    </div>
  );
}

// ─── Mount ───────────────────────────────────────────────────────────────────

const container = document.getElementById('app');
if (container) {
  render(<App />, container);
}

