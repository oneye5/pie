/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { render } from 'preact';
import { useState, useEffect, useRef, useCallback } from 'preact/hooks';

import type {
  ChatPrefs,
  ComposerInputDraft,
  HostToWebviewMessage,
  RunOutcome,
  ThinkingLevel,
  ViewState,
  WebviewToHostMessage,
} from '../../shared/protocol';
import { DEFAULT_CHAT_PREFS, EMPTY_TRANSCRIPT_WINDOW } from '../../shared/protocol';
import { emptyOverlay, applyPatch } from './overlay';
import { FileChangesPanel } from './file-changes-panel';
import { resolvePanelSurface } from './panel-state';
import { StreamSmoother } from './stream-smoother';
import { TranscriptView } from './transcript';
import {
  type ChatPrefContextType,
  type TranscriptContextMenuType,
  getChatPrefContextLabel,
  getChatPrefContextValue,
  toggleChatPrefForContext,
} from './chat-prefs';
import { SessionTabs, Composer } from './ui';
import { RunOutcomeDialog } from './run-outcome-dialog';

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
  unreadFinishedSessionPaths: [],
  activeSession: null,
  transcript: [],
  transcriptWindow: { ...EMPTY_TRANSCRIPT_WINDOW },
  pendingComposerInputs: [],
  activeRunSummary: null,
  runSummariesBySession: {},
  busy: false,
  notice: null,
  backendReady: false,
  workspaceCwd: null,
  systemPrompts: [],
  modelSettings: null,
  availableModels: [],
  contextUsage: null,
  prefs: { ...DEFAULT_CHAT_PREFS },
  availableExtensions: [],
  fileChanges: [],
};

// ─── ContextMenu ─────────────────────────────────────────────────────────────

interface ContextMenuState {
  type: TranscriptContextMenuType;
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
  const style = `position:fixed;top:${Math.min(menu.y, window.innerHeight - 120)}px;left:${Math.min(menu.x, window.innerWidth - 220)}px`;

  const prefType: ChatPrefContextType | null = menu.type === 'message' ? null : menu.type;
  const checked = prefType ? getChatPrefContextValue(prefs, prefType) : false;
  const expandLabel = prefType ? getChatPrefContextLabel(prefType) : '';
  const expandToggle = prefType ? (
    <button
      class="context-menu-item"
      type="button"
      onClick={() => {
        onSetPrefs(toggleChatPrefForContext(prefs, prefType));
        onClose();
      }}
    >
      <svg class="context-menu-check" width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style={checked ? '' : 'opacity:0'}>
        <polyline points="2.5,6.5 5,9 10.5,3.5" />
      </svg>
      {expandLabel}
    </button>
  ) : null;

  return (
    <div ref={ref} class="block-context-menu" style={style} onMouseDown={(e) => e.stopPropagation()}>
      {expandToggle}
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
  const [editingId, setEditingId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [draftRestore, setDraftRestore] = useState<{ text: string; nonce: number } | null>(null);
  const [showOutcomeDialog, setShowOutcomeDialog] = useState(false);

  // Stream smoother for gradual character emission
  const smootherRef = useRef<StreamSmoother | null>(null);

  // Token rate tracking: rolling window of output token samples
  const RATE_WINDOW_SECONDS = 10;
  const tokenRateRef = useRef<{ tokens: number; timestamp: number }[]>([]);
  const [tokenRateState, setTokenRateState] = useState<{ tokensPerSecond: number | null; windowSeconds: number }>({
    tokensPerSecond: null,
    windowSeconds: RATE_WINDOW_SECONDS,
  });

  // Track last revision via ref (not state) to avoid triggering snapshot requests on every re-render
  const lastRevisionRef = useRef(0);
  const awaitingSnapshotRef = useRef(false);
  const hostInstanceIdRef = useRef('');
  const activeSessionPathRef = useRef<string | null>(null);
  const pendingDraftRestoreRef = useRef(new Map<string, { text: string }>());

  const clearTransientUi = useCallback(() => {
    setEditingId(null);
    setContextMenu(null);
    setDraftRestore(null);
    setShowOutcomeDialog(false);
  }, []);

  useEffect(() => {
    smootherRef.current = new StreamSmoother(
      {},
      (newOverlay) => setOverlay(newOverlay),
    );
    return () => smootherRef.current?.reset();
  }, []);
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const msg = event.data as HostToWebviewMessage;

      if (msg.type === 'state') {
        // Flush any pending smoothed content when state changes
        smootherRef.current?.flushAll();
        smootherRef.current?.reset();
        const hostChanged = hostInstanceIdRef.current && msg.hostInstanceId !== hostInstanceIdRef.current;
        const nextActiveSessionPath = msg.state.activeSession?.path ?? null;
        const sessionChanged = activeSessionPathRef.current !== null && activeSessionPathRef.current !== nextActiveSessionPath;
        const queuedDraftRestore = nextActiveSessionPath
          ? pendingDraftRestoreRef.current.get(nextActiveSessionPath) ?? null
          : null;

        if (hostChanged) {
          lastRevisionRef.current = 0;
        }
        awaitingSnapshotRef.current = false;
        hostInstanceIdRef.current = msg.hostInstanceId;
        activeSessionPathRef.current = nextActiveSessionPath;
        lastRevisionRef.current = msg.revision;
        if (hostChanged || sessionChanged) {
          clearTransientUi();
          tokenRateRef.current = [];
          setTokenRateState({ tokensPerSecond: null, windowSeconds: RATE_WINDOW_SECONDS });
        }
        if (queuedDraftRestore && nextActiveSessionPath) {
          pendingDraftRestoreRef.current.delete(nextActiveSessionPath);
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
          awaitingSnapshotRef.current = true;
          clearTransientUi();
          setOverlay(emptyOverlay());
          postMessage({ type: 'requestSnapshot' });
          return;
        }
        if (msg.revision <= lastRevisionRef.current) {
          return;
        }
        const expected = lastRevisionRef.current + 1;
        if (awaitingSnapshotRef.current || (lastRevisionRef.current > 0 && msg.revision !== expected)) {
          if (!awaitingSnapshotRef.current) {
            postMessage({ type: 'requestSnapshot' });
          }
          awaitingSnapshotRef.current = true;
          return;
        }
        lastRevisionRef.current = msg.revision;
        // Use smoother for message deltas to create gradual character streaming
        const smoother = smootherRef.current;
        if (smoother) {
          setOverlay(smoother.processPatch(msg.op));
        } else {
          setOverlay((prev) => applyPatch(prev, msg.op));
        }
        // Track output token rate from streaming deltas
        if (msg.op.kind === 'messageDelta') {
          const now = Date.now();
          const chars = msg.op.delta.length;
          // Rough estimate: ~4 chars per token for typical English output
          const estimatedTokens = chars / 4;
          const samples = tokenRateRef.current;
          samples.push({ tokens: estimatedTokens, timestamp: now });
          // Evict samples outside the window
          const cutoff = now - RATE_WINDOW_SECONDS * 1000;
          let i = 0;
          while (i < samples.length && samples[i].timestamp < cutoff) i++;
          if (i > 0) samples.splice(0, i);
          // Compute smoothed rate
          if (samples.length >= 2) {
            const first = samples[0];
            const last = samples[samples.length - 1];
            const elapsed = (last.timestamp - first.timestamp) / 1000;
            if (elapsed > 0.5) {
              const totalTokens = samples.reduce((s, p) => s + p.tokens, 0);
              setTokenRateState({ tokensPerSecond: totalTokens / elapsed, windowSeconds: RATE_WINDOW_SECONDS });
            }
          }
        }
        return;
      }

      if (msg.type === 'sendRejected') {
        if (msg.sessionPath === activeSessionPathRef.current) {
          setDraftRestore({ text: msg.text, nonce: Date.now() });
        } else {
          pendingDraftRestoreRef.current.set(msg.sessionPath, { text: msg.text });
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

  const handleSend = useCallback((text: string) => {
    setDraftRestore(null);
    postMessage({ type: 'send', text });
  }, []);

  const handleEditSend = useCallback((messageId: string, text: string) => {
    postMessage({ type: 'editMessage', messageId, text });
    setEditingId(null);
  }, []);

  const handleCancelEdit = useCallback(() => setEditingId(null), []);
  const handleInterrupt = useCallback(() => postMessage({ type: 'interrupt' }), []);
  const handleOpenFilePicker = useCallback(() => postMessage({ type: 'openFilePicker' }), []);
  const handleAddComposerInput = useCallback((input: ComposerInputDraft) => {
    const sessionPath = activeSessionPathRef.current;
    if (!sessionPath) {
      return;
    }
    postMessage({ type: 'addComposerInput', sessionPath, input });
  }, []);
  const handleRemoveComposerInput = useCallback((inputId: string) => {
    const sessionPath = activeSessionPathRef.current;
    if (!sessionPath) {
      return;
    }
    postMessage({ type: 'removeComposerInput', sessionPath, inputId });
  }, []);
  const handleOpenFile = useCallback((path: string) => postMessage({ type: 'openFile', path }), []);
  const handleNewSession = useCallback(() => postMessage({ type: 'newSession' }), []);
  const handleSelectTab = useCallback((path: string) => {
    activeSessionPathRef.current = path;
    postMessage({ type: 'openSession', sessionPath: path });
  }, []);
  const handleCloseTab = useCallback((path: string) => postMessage({ type: 'closeSession', sessionPath: path }), []);
  const handleMoveTab = useCallback((sessionPath: string | undefined, fromIndex: number, toIndex: number) => {
    postMessage({ type: 'moveSessionTab', sessionPath, fromIndex, toIndex });
  }, []);

  const handleMarkComplete = useCallback(() => setShowOutcomeDialog(true), []);

  const handleRecordOutcome = useCallback((outcome: RunOutcome) => {
    const sessionPath = activeSessionPathRef.current;
    if (!sessionPath) return;
    postMessage({ type: 'recordOutcome', sessionPath, outcome });
    postMessage({ type: 'closeSession', sessionPath });
    setShowOutcomeDialog(false);
  }, []);

  const handleCancelOutcome = useCallback(() => setShowOutcomeDialog(false), []);

  const handleModelChange = useCallback((model: string, thinkingLevel: ThinkingLevel) => {
    postMessage({
      type: 'setModel',
      sessionPath: viewState.activeSession?.path,
      defaultModel: model,
      defaultThinkingLevel: thinkingLevel,
    });
  }, [viewState.activeSession?.path]);

  const handleEditRequest = useCallback((messageId: string) => {
    setEditingId(messageId);
  }, []);

  const handleOpenFileDiff = useCallback((filePath: string) => {
    const sessionPath = activeSessionPathRef.current;
    if (!sessionPath) return;
    postMessage({ type: 'openFileDiff', sessionPath, filePath });
  }, []);

  const handleRevertFile = useCallback((filePath: string) => {
    const sessionPath = activeSessionPathRef.current;
    if (!sessionPath) return;
    postMessage({ type: 'revertFile', sessionPath, filePath });
  }, []);

  const handleSetPrefs = useCallback((partial: Partial<ChatPrefs>) => {
    postMessage({ type: 'setPrefs', prefs: partial });
  }, []);

  const handleOpenContextMenu = useCallback((type: TranscriptContextMenuType, rawData: string, e: MouseEvent) => {
    setContextMenu({ type, rawData, x: e.clientX, y: e.clientY });
  }, []);

  const {
    sessions,
    openTabPaths,
    runningSessionPaths,
    unreadFinishedSessionPaths,
    activeSession,
    transcript,
    transcriptWindow,
    pendingComposerInputs,
    activeRunSummary,
    busy,
    notice,
    backendReady,
    workspaceCwd,
    modelSettings,
    availableModels,
    contextUsage,
    prefs,
    systemPrompts,
    fileChanges,
  } = viewState;

  const availableExtensions = viewState.availableExtensions;

  // Close outcome dialog if the active session changes.
  useEffect(() => {
    if (showOutcomeDialog) {
      setShowOutcomeDialog(false);
    }
  }, [activeSession?.path]);

  const panelSurface = resolvePanelSurface({ backendReady, notice, openTabPaths });
  const hasActiveTabs = panelSurface === 'session';
  const showSessionChrome = panelSurface !== 'loading';
  const activeSessionPath = activeSession?.path ?? null;

  return (
    <div id="app">
      {showOutcomeDialog && activeSession && (
        <RunOutcomeDialog
          sessionLabel={activeSession.name}
          onCancel={handleCancelOutcome}
          onSubmit={handleRecordOutcome}
        />
      )}
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

      {showSessionChrome && (
        <SessionTabs
          sessions={sessions}
          openTabPaths={openTabPaths}
          runningSessionPaths={runningSessionPaths}
          unreadFinishedSessionPaths={unreadFinishedSessionPaths}
          activeSession={activeSession}
          backendReady={backendReady}
          onSelect={handleSelectTab}
          onClose={handleCloseTab}
          onMove={handleMoveTab}
          onNew={handleNewSession}
        />
      )}

      <div class="panel-main">
        {showSessionChrome && (
          <FileChangesPanel
            fileChanges={fileChanges}
            onOpenDiff={handleOpenFileDiff}
            onRevertFile={handleRevertFile}
          />
        )}
        {panelSurface === 'loading' ? (
          <div class="empty-state">
            <div class="empty-state-title">Starting pie</div>
            <div class="empty-state-sub">Restoring sessions and starting the backend.</div>
          </div>
        ) : !hasActiveTabs ? (
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
            key={activeSessionPath ?? 'no-active-session'}
            sessionKey={activeSessionPath}
            transcript={transcript}
            transcriptWindow={transcriptWindow}
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
            onLoadOlder={() => postMessage({
              type: 'loadOlderTranscript',
              sessionPath: activeSessionPath ?? undefined,
            })}
            onLoadNewer={() => postMessage({
              type: 'loadNewerTranscript',
              sessionPath: activeSessionPath ?? undefined,
            })}
            onJumpToLatest={() => postMessage({
              type: 'jumpToLatestTranscript',
              sessionPath: activeSessionPath ?? undefined,
            })}
          />
        )}
      </div>

      {hasActiveTabs && backendReady && (
        <Composer
          busy={busy}
          activeModelId={activeSession?.modelId}
          activeThinkingLevel={activeSession?.thinkingLevel}
          modelSettings={modelSettings}
          availableModels={availableModels}
          availableExtensions={availableExtensions}
          contextUsage={contextUsage}
          prefs={prefs}
          systemPrompts={systemPrompts}
          transcript={transcript}
          transcriptWindow={transcriptWindow}
          draftRestore={draftRestore}
          pendingComposerInputs={pendingComposerInputs}
          activeRunSummary={activeRunSummary}
          focusTrigger={activeSession?.path}
          onSend={handleSend}
          onInterrupt={handleInterrupt}
          onOpenFilePicker={handleOpenFilePicker}
          onAddInput={handleAddComposerInput}
          onRemoveInput={handleRemoveComposerInput}
          onModelChange={handleModelChange}
          onSetPrefs={handleSetPrefs}
          onMarkComplete={handleMarkComplete}
          tokenRate={tokenRateState}
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
