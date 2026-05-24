/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useState, useCallback } from 'preact/hooks';

import type {
  ChatPrefs,
  ComposerInputDraft,
  PruningSettings,
  RunOutcome,
  ThinkingLevel,
  ViewState,
  WebviewToHostMessage,
} from '../../shared/protocol';
import { FileChangesPanel } from './file-changes-panel';
import { resolvePanelSurface } from './panel-state';
import { TranscriptHost } from './transcript/transcript-host';
import { type TranscriptContextMenuType } from './chat-prefs';
import { ContextMenu, type ContextMenuState } from './components/context-menu';
import { SessionTabs, Composer } from './ui';
import { RunOutcomeDialog } from './run-outcome-dialog';
import { useHostSync, EMPTY_VIEW_STATE } from './hooks/use-host-sync';

export { EMPTY_VIEW_STATE };

// ─── App ─────────────────────────────────────────────────────────────────────

export interface AppAdapter {
  postMessage: (msg: WebviewToHostMessage) => void;
  initialState?: ViewState;
}

export function App({ adapter }: { adapter: AppAdapter }) {
  const { postMessage } = adapter;
  const { viewState, draftRestore, tokenRateState, activeSessionPathRef, setDraftRestore } =
    useHostSync(postMessage, adapter.initialState);

  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  const handleSend = useCallback((text: string) => {
    const sessionPath = activeSessionPathRef.current;
    if (!sessionPath) return;
    setDraftRestore(null);
    postMessage({ type: 'send', sessionPath, text });
  }, [postMessage, activeSessionPathRef, setDraftRestore]);

  const handleInterrupt = useCallback(() => {
    const sessionPath = activeSessionPathRef.current;
    if (!sessionPath) return;
    postMessage({ type: 'interrupt', sessionPath });
  }, [postMessage, activeSessionPathRef]);

  const handleOpenFilePicker = useCallback(() => postMessage({ type: 'openFilePicker' }), [postMessage]);
  const handleOpenFile = useCallback((path: string) => postMessage({ type: 'openFile', path }), [postMessage]);
  const handleNewSession = useCallback(() => postMessage({ type: 'newSession' }), [postMessage]);
  const handleCloseTab = useCallback((path: string) => postMessage({ type: 'closeSession', sessionPath: path }), [postMessage]);
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

  // ─── Derived state ───────────────────────────────────────────────────────

  const { sessions, openTabPaths, runningSessionPaths, unreadFinishedSessionPaths,
    activeSession, transcript, transcriptWindow, pendingComposerInputs, activeRunSummary,
    busy, notice, backendReady, workspaceCwd, modelSettings, availableModels, contextUsage,
    prefs, systemPrompts, fileChanges, pruningResult, pruningSettings, availableExtensions,
    editingMessageId, showOutcomeDialog } = viewState;

  const panelSurface = resolvePanelSurface({ backendReady, notice, openTabPaths });
  const hasActiveTabs = panelSurface === 'session';
  const showSessionChrome = panelSurface !== 'loading';
  const activeSessionPath = activeSession?.path ?? null;

  // ─── Render ──────────────────────────────────────────────────────────────

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
          <TranscriptHost
            openTabPaths={openTabPaths}
            activeSessionPath={activeSessionPath}
            transcript={transcript}
            transcriptWindow={transcriptWindow}
            busy={busy}
            prefs={prefs}
            systemPrompts={systemPrompts}
            pruningResult={pruningResult}
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
          pruningSettings={pruningSettings}
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
  );
}
