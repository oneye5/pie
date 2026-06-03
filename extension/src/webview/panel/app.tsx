/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useState, useCallback, useEffect, useMemo, useRef } from 'preact/hooks';

import type {
  ChatPrefs,
  ComposerInputDraft,
  PruningSettings,
  RunOutcome,
  ThinkingLevel,
  ViewState,
  WebviewToHostMessage,
} from '../../shared/protocol';
import { createLocalMessageId } from '../../shared/local-message-id';
import { warmupCompletionSoundContext } from './completion-sound';
import { FileChangesPanel } from './file-changes-panel';
import { ExtensionUIPrompt } from './extension-ui-prompt';
import { resolvePanelSurface } from './panel-state';
import { TranscriptHost } from './transcript/transcript-host';
import { type TranscriptContextMenuType } from './chat-prefs';
import { ContextMenu, type ContextMenuState } from './components/context-menu';
import { resolveComposerModelState } from './composer/model-state';
import { SessionTabs, Composer } from './ui';
import { RunOutcomeDialog } from './run-outcome-dialog';
import { NoticeBanner } from './components/notice-banner';
import { NoticeContext } from './hooks/notice-context';
import { useHostSync, EMPTY_VIEW_STATE } from './hooks/use-host-sync';
import { isPendingTabPath } from '../../shared/tab-behavior';

export { EMPTY_VIEW_STATE };

// ─── App ─────────────────────────────────────────────────────────────────────

export interface AppAdapter {
  postMessage: (msg: WebviewToHostMessage) => void;
  initialState?: ViewState;
}

export function App({ adapter }: { adapter: AppAdapter }) {
  const { postMessage } = adapter;
  const { viewState, mergedTranscript, draftRestore, tokenRateState, activeSessionPathRef, setDraftRestore, addOptimisticMessage } =
    useHostSync(postMessage, adapter.initialState);

  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  const handleSend = useCallback((text: string) => {
    const sessionPath = activeSessionPathRef.current;
    if (!sessionPath) return;
    setDraftRestore(null);

    // Show the user's message instantly in the transcript before the host confirms it.
    const localId = createLocalMessageId();
    addOptimisticMessage({ localId, text, sessionPath });

    postMessage({ type: 'send', sessionPath, text, localId });
  }, [postMessage, activeSessionPathRef, setDraftRestore, addOptimisticMessage]);

  const handleInterrupt = useCallback(() => {
    const sessionPath = activeSessionPathRef.current;
    if (!sessionPath) return;
    postMessage({ type: 'interrupt', sessionPath });
  }, [postMessage, activeSessionPathRef]);

  const handleOpenFilePicker = useCallback(() => postMessage({ type: 'openFilePicker' }), [postMessage]);
  const handleOpenFile = useCallback((path: string) => postMessage({ type: 'openFile', path }), [postMessage]);
  const handleNewSession = useCallback(() => postMessage({ type: 'newSession' }), [postMessage]);
  const handleCloseTab = useCallback((path: string) => postMessage({ type: 'closeSession', sessionPath: path }), [postMessage]);
  const handleDuplicateTab = useCallback((path: string) => postMessage({ type: 'duplicateSession', sessionPath: path }), [postMessage]);
  const handleMarkComplete = useCallback(() => postMessage({ type: 'openOutcomeDialog' }), [postMessage]);
  const handleCancelOutcome = useCallback(() => postMessage({ type: 'closeOutcomeDialog' }), [postMessage]);
  const handleCancelEdit = useCallback(() => postMessage({ type: 'cancelEdit' }), [postMessage]);
  const handleSetPrefs = useCallback((partial: Partial<ChatPrefs>) => postMessage({ type: 'setPrefs', prefs: partial }), [postMessage]);
  const handleSetPruningSettings = useCallback((partial: Partial<PruningSettings>) => postMessage({ type: 'setPruningSettings', settings: partial }), [postMessage]);
  const handleEditRequest = useCallback((messageId: string) => postMessage({ type: 'startEdit', messageId }), [postMessage]);

  const handleAddComposerInput = useCallback((input: ComposerInputDraft) => {
    const sessionPath = activeSessionPathRef.current;
    if (!sessionPath) return;
    postMessage({ type: 'addComposerInput', sessionPath, input });
  }, [postMessage, activeSessionPathRef]);

  const handleRemoveComposerInput = useCallback((inputId: string) => {
    const sessionPath = activeSessionPathRef.current;
    if (!sessionPath) return;
    postMessage({ type: 'removeComposerInput', sessionPath, inputId });
  }, [postMessage, activeSessionPathRef]);

  const handleSelectTab = useCallback((path: string) => {
    activeSessionPathRef.current = path;
    postMessage({ type: 'openSession', sessionPath: path });
  }, [postMessage, activeSessionPathRef]);

  const handleMoveTab = useCallback((sessionPath: string | undefined, fromIndex: number, toIndex: number) => {
    postMessage({ type: 'moveSessionTab', sessionPath, fromIndex, toIndex });
  }, [postMessage]);

  const handleRecordOutcome = useCallback((outcome: RunOutcome) => {
    const sessionPath = activeSessionPathRef.current;
    if (!sessionPath) return;
    postMessage({ type: 'recordOutcome', sessionPath, outcome });
    postMessage({ type: 'closeSession', sessionPath });
    postMessage({ type: 'closeOutcomeDialog' });
  }, [postMessage, activeSessionPathRef]);

  const handleModelChange = useCallback((model: string, thinkingLevel: ThinkingLevel) => {
    postMessage({ type: 'setModel', sessionPath: viewState.activeSession?.path, defaultModel: model, defaultThinkingLevel: thinkingLevel });
  }, [viewState.activeSession?.path, postMessage]);

  const handleEditSend = useCallback((messageId: string, text: string) => {
    const sessionPath = activeSessionPathRef.current;
    if (!sessionPath) return;
    postMessage({ type: 'editMessage', sessionPath, messageId, text });
  }, [postMessage, activeSessionPathRef]);

  const handleOpenFileDiff = useCallback((filePath: string) => {
    const sessionPath = activeSessionPathRef.current;
    if (!sessionPath) return;
    postMessage({ type: 'openFileDiff', sessionPath, filePath });
  }, [postMessage, activeSessionPathRef]);

  const handleRevertFile = useCallback((filePath: string) => {
    const sessionPath = activeSessionPathRef.current;
    if (!sessionPath) return;
    postMessage({ type: 'revertFile', sessionPath, filePath });
  }, [postMessage, activeSessionPathRef]);

  const handleOpenContextMenu = useCallback((type: TranscriptContextMenuType, rawData: string, e: MouseEvent) => {
    setContextMenu({ type, rawData, x: e.clientX, y: e.clientY });
  }, []);

  // Warm the AudioContext on the first user click so the completion sound
  // works even when triggered from a non-gesture postMessage handler.
  useEffect(() => {
    const warmup = () => {
      warmupCompletionSoundContext();
      document.removeEventListener('click', warmup, true);
    };
    document.addEventListener('click', warmup, true);
    return () => document.removeEventListener('click', warmup, true);
  }, []);

  // ─── Derived state ───────────────────────────────────────────────────────

  const { sessions, openTabPaths, runningSessionPaths, unreadFinishedSessionPaths,
    activeSession, transcript, transcriptWindow, transcriptLoaded, pendingComposerInputs, activeRunSummary,
    busy, notice, backendReady, workspaceCwd, modelSettings, availableModels, contextUsage,
    prefs, systemPrompts, fileChanges, pruningResult, pruningSettings, pruningCatalog, availableExtensions,
    editingMessageId, showOutcomeDialog, pendingExtensionUIRequest } = viewState;

  const recoveryRequestRef = useRef<{ path: string | null; lastSentAt: number }>({
    path: null,
    lastSentAt: 0,
  });

  const panelSurface = resolvePanelSurface({ backendReady, notice, openTabPaths });
  const hasActiveTabs = panelSurface === 'session';
  const showSessionChrome = panelSurface !== 'loading';
  const activeSessionPath = activeSession?.path ?? null;
  const recoverySessionPath = openTabPaths.find((p) => !isPendingTabPath(p)) ?? sessions[0]?.path ?? null;
  const needsSessionRecovery = hasActiveTabs && activeSession === null && recoverySessionPath !== null;
  const {
    selectedModel: pendingAssistantModelId,
    selectedLevel: pendingAssistantThinkingLevel,
  } = useMemo(() => resolveComposerModelState({
    activeModelId: activeSession?.modelId,
    activeThinkingLevel: activeSession?.thinkingLevel,
    modelSettings,
    availableModels,
  }), [activeSession?.modelId, activeSession?.thinkingLevel, availableModels, modelSettings]);

  useEffect(() => {
    if (!backendReady || !needsSessionRecovery || !recoverySessionPath || notice) {
      recoveryRequestRef.current = {
        path: null,
        lastSentAt: 0,
      };
      return;
    }

    const sendRecoveryRequest = () => {
      const now = Date.now();
      const { path, lastSentAt } = recoveryRequestRef.current;
      if (path === recoverySessionPath && now - lastSentAt < 2500) {
        return;
      }

      recoveryRequestRef.current = {
        path: recoverySessionPath,
        lastSentAt: now,
      };
      postMessage({ type: 'openSession', sessionPath: recoverySessionPath });
    };

    sendRecoveryRequest();
    const retryId = window.setInterval(sendRecoveryRequest, 2500);
    return () => window.clearInterval(retryId);
  }, [backendReady, needsSessionRecovery, recoverySessionPath, notice, postMessage]);

  // ─── Render ──────────────────────────────────────────────────────────────

  return (
    <NoticeContext.Provider value={notice}>
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
        <NoticeBanner notice={notice} onDismiss={() => postMessage({ type: 'dismissNotice' })} />
      )}

      {showSessionChrome && (
        <SessionTabs
          sessions={sessions}
          openTabPaths={openTabPaths}
          runningSessionPaths={runningSessionPaths}
          unreadFinishedSessionPaths={unreadFinishedSessionPaths}
          activeSession={activeSession}
          activeRunSummary={activeRunSummary}
          backendReady={backendReady}
          hasPendingExtensionUIRequest={!!pendingExtensionUIRequest}
          onSelect={handleSelectTab}
          onClose={handleCloseTab}
          onMove={handleMoveTab}
          onNew={handleNewSession}
          onMarkComplete={handleMarkComplete}
          onDuplicate={handleDuplicateTab}
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
            <div class="loading-wheel" aria-hidden="true" />
            <div class="empty-state-title">Starting pie</div>
            <div class="empty-state-sub">Restoring sessions and starting the backend.</div>
          </div>
        ) : !hasActiveTabs ? (
          <div class="empty-state">
            <div class="empty-state-title">Start a session</div>
            <div class="empty-state-sub">
              Sessions stay in tabs, and model settings remain visible while you work.
            </div>
            <button class="btn" onClick={handleNewSession}>New Session</button>
          </div>
        ) : needsSessionRecovery ? (
          <div class="empty-state">
            <div class="loading-wheel" aria-hidden="true" />
            <div class="empty-state-title">Restoring session</div>
            <div class="empty-state-sub">Reopening your active tab.</div>
          </div>
        ) : (
          <TranscriptHost
            openTabPaths={openTabPaths}
            activeSessionPath={activeSessionPath}
            transcript={mergedTranscript}
            transcriptWindow={transcriptWindow}
            transcriptLoaded={transcriptLoaded}
            busy={busy}
            prefs={prefs}
            pruningSettings={pruningSettings}
            systemPrompts={systemPrompts}
            pruningResult={pruningResult}
            pendingAssistantModelId={pendingAssistantModelId}
            pendingAssistantThinkingLevel={pendingAssistantThinkingLevel}
            workingDirectory={activeSession?.cwd ?? workspaceCwd}
            editingId={editingMessageId}
            onEditRequest={handleEditRequest}
            onEditConfirm={handleEditSend}
            onEditCancel={handleCancelEdit}
            onOpenFile={handleOpenFile}
            onContextMenu={handleOpenContextMenu}
            postMessage={postMessage}
          />
        )}
        {hasActiveTabs && !needsSessionRecovery && pendingExtensionUIRequest && activeSessionPath && (
          <ExtensionUIPrompt sessionPath={activeSessionPath} request={pendingExtensionUIRequest} postMessage={postMessage} />
        )}
      </div>

      {hasActiveTabs && !needsSessionRecovery && (
        <Composer
          busy={busy}
          activeModelId={activeSession?.modelId}
          activeThinkingLevel={activeSession?.thinkingLevel}
          modelSettings={modelSettings}
          availableModels={availableModels}
          availableExtensions={availableExtensions}
          contextUsage={contextUsage}
          prefs={prefs}
          pruningSettings={pruningSettings}
          pruningCatalog={pruningCatalog}
          pruningResult={pruningResult}
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
          onSetPruningSettings={handleSetPruningSettings}
          onMarkComplete={handleMarkComplete}
          tokenRate={tokenRateState}
        />
      )}
    </div>
    </NoticeContext.Provider>
  );
}
