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
  systemPrompts: [],
  modelSettings: null,
  availableModels: [],
  contextUsage: null,
  prefs: { autoExpandReasoning: false, autoExpandToolCalls: false },
};

// ─── ContextMenu ─────────────────────────────────────────────────────────────

interface ContextMenuState {
  type: 'reasoning' | 'toolCalls' | 'message';
  rawData: string;
  x: number;
  y: number;
}

function ContextMenu({
  menu,
  prefs,
  onSetPrefs,
  onClose,
}: {
  menu: ContextMenuState;
  prefs: ChatPrefs;
  onSetPrefs: (p: Partial<ChatPrefs>) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', down);
      document.removeEventListener('keydown', key);
    };
  }, [onClose]);

  // Keep menu inside viewport
  const style = `position:fixed;top:${Math.min(menu.y, window.innerHeight - 120)}px;left:${Math.min(menu.x, window.innerWidth - 200)}px`;

  const isReasoning = menu.type === 'reasoning';
  const isMessage = menu.type === 'message';
  const checked = isReasoning ? prefs.autoExpandReasoning : prefs.autoExpandToolCalls;
  const expandLabel = isReasoning ? 'Expand reasoning by default' : 'Expand tool calls by default';

  return (
    <div ref={ref} class="block-context-menu" style={style} onMouseDown={(e) => e.stopPropagation()}>
      {!isMessage && (
        <button
          class="context-menu-item"
          type="button"
          onClick={() => {
            onSetPrefs(isReasoning ? { autoExpandReasoning: !checked } : { autoExpandToolCalls: !checked });
            onClose();
          }}
        >
          <svg class="context-menu-check" width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style={checked ? '' : 'opacity:0'}>
            <polyline points="2.5,6.5 5,9 10.5,3.5" />
          </svg>
          {expandLabel}
        </button>
      )}
      <button
        class="context-menu-item"
        type="button"
        onClick={() => {
          navigator.clipboard.writeText(menu.rawData);
          onClose();
        }}
      >
        <svg class="context-menu-check" width="13" height="13" viewBox="0 0 13 13" aria-hidden="true" style="opacity:0" />
        Copy raw
      </button>
    </div>
  );
}

// ─── App ─────────────────────────────────────────────────────────────────────

function App() {
  const [viewState, setViewState] = useState<ViewState>(EMPTY_VIEW_STATE);
  const [overlay, setOverlay] = useState(emptyOverlay);
  const [pendingPaths, setPendingPaths] = useState<string[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [draftRestore, setDraftRestore] = useState<{ text: string; nonce: number } | null>(null);

  // Track last revision via ref (not state) to avoid triggering snapshot requests on every re-render
  const lastRevisionRef = useRef(0);
  const hostInstanceIdRef = useRef('');
  const activeSessionPathRef = useRef<string | null>(null);
  const pendingDraftRestoreRef = useRef(new Map<string, { text: string; pendingPaths: string[] }>());

  const clearTransientUi = useCallback(() => {
    setPendingPaths([]);
    setEditingId(null);
    setContextMenu(null);
    setDraftRestore(null);
  }, []);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const msg = event.data as HostToWebviewMessage;

      if (msg.type === 'state') {
        const hostChanged = hostInstanceIdRef.current && msg.hostInstanceId !== hostInstanceIdRef.current;
        const nextActiveSessionPath = msg.state.activeSession?.path ?? null;
        const sessionChanged = activeSessionPathRef.current !== null && activeSessionPathRef.current !== nextActiveSessionPath;
        const queuedDraftRestore = nextActiveSessionPath
          ? pendingDraftRestoreRef.current.get(nextActiveSessionPath) ?? null
          : null;

        if (hostChanged) {
          lastRevisionRef.current = 0;
        }
        hostInstanceIdRef.current = msg.hostInstanceId;
        activeSessionPathRef.current = nextActiveSessionPath;
        lastRevisionRef.current = msg.revision;
        if (hostChanged || sessionChanged) {
          clearTransientUi();
        }
        if (queuedDraftRestore && nextActiveSessionPath) {
          pendingDraftRestoreRef.current.delete(nextActiveSessionPath);
          setPendingPaths(queuedDraftRestore.pendingPaths);
          setDraftRestore({ text: queuedDraftRestore.text, nonce: Date.now() });
        }
        setViewState(msg.state);
        setOverlay(emptyOverlay());
        return;
      }

      if (msg.type === 'patch') {
        if (hostInstanceIdRef.current && msg.hostInstanceId !== hostInstanceIdRef.current) {
          hostInstanceIdRef.current = msg.hostInstanceId;
          lastRevisionRef.current = 0;
          clearTransientUi();
          setOverlay(emptyOverlay());
          postMessage({ type: 'requestSnapshot' });
          return;
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
        return;
      }

      if (msg.type === 'sendRejected') {
        if (msg.sessionPath === activeSessionPathRef.current) {
          setPendingPaths(msg.pendingPaths);
          setDraftRestore({ text: msg.text, nonce: Date.now() });
        } else {
          pendingDraftRestoreRef.current.set(msg.sessionPath, {
            text: msg.text,
            pendingPaths: msg.pendingPaths,
          });
        }
      }
    };

    window.addEventListener('message', handleMessage);
    postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', handleMessage);
  }, [clearTransientUi]);

  useEffect(() => {
    const refreshState = () => postMessage({ type: 'refreshState' });
    const handleVisibilityChange = () => {
      if (!document.hidden) {
        refreshState();
      }
    };

    window.addEventListener('focus', refreshState);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.removeEventListener('focus', refreshState);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  const handleSend = useCallback(
    (text: string) => {
      setPendingPaths([]);
      setDraftRestore(null);
      postMessage({ type: 'send', text, pendingPaths });
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
  const handleOpenFile = useCallback((path: string) => postMessage({ type: 'openFile', path }), []);
  const handleNewSession = useCallback(() => postMessage({ type: 'newSession' }), []);
  const handleSelectTab = useCallback((path: string) => postMessage({ type: 'openSession', sessionPath: path }), []);
  const handleCloseTab = useCallback((path: string) => postMessage({ type: 'closeSession', sessionPath: path }), []);
  const handleMoveTab = useCallback((sessionPath: string | undefined, fromIndex: number, toIndex: number) => {
    postMessage({ type: 'moveSessionTab', sessionPath, fromIndex, toIndex });
  }, []);

  const handleModelChange = useCallback((model: string, thinkingLevel: ThinkingLevel) => {
    postMessage({ type: 'setModel', defaultModel: model, defaultThinkingLevel: thinkingLevel });
  }, []);

  const handleEditRequest = useCallback((messageId: string) => {
    setEditingId(messageId);
  }, []);

  const handleSetPrefs = useCallback((partial: Partial<ChatPrefs>) => {
    postMessage({ type: 'setPrefs', prefs: partial });
  }, []);

  const handleOpenContextMenu = useCallback((type: 'reasoning' | 'toolCalls' | 'message', rawData: string, e: MouseEvent) => {
    setContextMenu({ type, rawData, x: e.clientX, y: e.clientY });
  }, []);

  const {
    sessions, openTabPaths, runningSessionPaths, activeSession,
    transcript, busy, notice, backendReady, workspaceCwd, modelSettings, availableModels, contextUsage, prefs, systemPrompts,
  } = viewState;

  const hasActiveTabs = openTabPaths.length > 0;

  return (
    <div id="app">
      {contextMenu && (
        <ContextMenu
          menu={contextMenu}
          prefs={prefs}
          onSetPrefs={handleSetPrefs}
          onClose={() => setContextMenu(null)}
        />
      )}
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
        onSelect={handleSelectTab}
        onClose={handleCloseTab}
        onMove={handleMoveTab}
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
            systemPrompts={systemPrompts}
            workingDirectory={activeSession?.cwd ?? workspaceCwd}
            editingId={editingId}
            onEditRequest={handleEditRequest}
            onEditConfirm={handleEditSend}
            onEditCancel={handleCancelEdit}
            onOpenFile={handleOpenFile}
            onContextMenu={handleOpenContextMenu}
          />
        )}
      </div>

      {hasActiveTabs && (
        <Composer
          busy={busy}
          modelSettings={modelSettings}
          availableModels={availableModels}
          contextUsage={contextUsage}
          systemPrompts={systemPrompts}
          transcript={transcript}
          draftRestore={draftRestore}
          pendingPaths={pendingPaths}
          focusTrigger={activeSession?.path}
          onSend={handleSend}
          onInterrupt={handleInterrupt}
          onOpenFilePicker={handleOpenFilePicker}
          onRemovePath={(p) => setPendingPaths((prev) => prev.filter((x) => x !== p))}
          onModelChange={handleModelChange}
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
