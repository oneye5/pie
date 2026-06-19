/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useState, useEffect, useMemo, useCallback } from 'preact/hooks';
import type {
  ViewState,
  WebviewToHostMessage,
  ChatMessageToolCallPart,
  ChatMessage,
  ThinkingLevel,
} from '../../shared/protocol';
import { warmupCompletionSoundContext } from './completion-sound';
import { FileChangesPanel } from './file-changes-panel';
import { ExtensionUIPrompt } from './extension-ui-prompt';
import { resolvePanelSurface, resolveLoadingStatus, type PanelSurface } from './panel-state';
import { TranscriptHost } from './transcript/transcript-host';
import { isTranscriptHydrating } from './transcript/state';
import { ContextMenu, type ContextMenuState } from './components/context-menu';
import { LoadingIndicator } from './components/loading-indicator';
import { resolveComposerModelState } from './composer/model-state';
import { SessionTabs, Composer } from './ui';
import { RunOutcomeDialog } from './run-outcome-dialog';
import { NoticeBanner } from './components/notice-banner';
import { NoticeContext } from './hooks/notice-context';
import { AskUserContext } from './hooks/ask-user-context';
import { useHostSync } from './hooks/use-host-sync';
import { isPendingTabPath } from '../../shared/tab-behavior';
import { useAppHandlers, type AppHandlers } from './use-app-handlers';
import { useSessionRecovery } from './use-session-recovery';
import { accentContrastColor } from './accent-contrast';

export interface AppBodyProps {
  adapter: {
    postMessage: (msg: WebviewToHostMessage) => void;
    initialState?: ViewState;
  };
}

// ─── Hook: derived state ───────────────────────────────────────────────────

function useAppBodyDerivedState(
  viewState: ViewState,
  postMessage: (msg: WebviewToHostMessage) => void,
) {
  const {
    sessions,
    openTabPaths,
    backendReady,
    notice,
    activeSession,
    modelSettings,
    availableModels,
    pendingExtensionUIRequestsBySession,
    pendingExtensionUIRequest,
    transcript,
    systemPrompts,
    transcriptLoaded,
  } = viewState;

  const panelSurface = resolvePanelSurface({ backendReady, notice, openTabPaths });
  const hasActiveTabs = panelSurface === 'session';
  const showSessionChrome = panelSurface !== 'loading';
  const activeSessionPath = activeSession?.path ?? null;
  const recoverySessionPath = openTabPaths.find((p) => !isPendingTabPath(p)) ?? sessions[0]?.path ?? null;
  const needsSessionRecovery = hasActiveTabs && activeSession === null && recoverySessionPath !== null;
  const transcriptHydrating = isTranscriptHydrating({ transcript, systemPrompts, transcriptLoaded });
  const loadingStatus = resolveLoadingStatus({
    backendReady,
    hasOpenTabs: hasActiveTabs,
    transcriptHydrating,
    needsSessionRecovery,
  });

  // Extract primitive values for memo deps to avoid re-computing on every host update
  // when objects like availableModels[] and modelSettings{} get new references.
  const activeModelId = activeSession?.modelId;
  const activeThinkingLevel = activeSession?.thinkingLevel;
  const settingsDefaultModel = modelSettings?.defaultModel;
  const settingsDefaultThinkingLevel = modelSettings?.defaultThinkingLevel;
  const modelCount = availableModels.length;

  const {
    selectedModel: pendingAssistantModelId,
    selectedLevel: pendingAssistantThinkingLevel,
  } = useMemo(() => resolveComposerModelState({
    activeModelId,
    activeThinkingLevel,
    modelSettings,
    availableModels,
  }), [activeModelId, activeThinkingLevel, settingsDefaultModel, settingsDefaultThinkingLevel, modelCount]);

  // Only suppress the bottom-bar prompt when the request that would be shown
  // there is itself a `select` that is rendered inline in the transcript. The
  // previous check ("any select exists") hid confirm/input prompts too, leaving
  // them shown nowhere and blocking the extension.
  const isAskUserHandledInline =
    !!activeSessionPath &&
    pendingExtensionUIRequest?.method === 'select' &&
    transcript.some((msg) =>
      msg.parts?.some((p): p is ChatMessageToolCallPart =>
        p.kind === 'toolCall' && p.toolCall.name === 'ask_user' && p.toolCall.status === 'running'
      ),
    );

  const askUserContextValue = useMemo(() => ({
    sessionPath: activeSessionPath,
    postMessage,
    pendingRequests: activeSessionPath
      ? (pendingExtensionUIRequestsBySession[activeSessionPath] ?? {})
      : {},
  }), [activeSessionPath, postMessage, pendingExtensionUIRequestsBySession]);

  return {
    panelSurface,
    hasActiveTabs,
    showSessionChrome,
    activeSessionPath,
    recoverySessionPath,
    needsSessionRecovery,
    pendingAssistantModelId,
    pendingAssistantThinkingLevel,
    isAskUserHandledInline,
    askUserContextValue,
    transcriptHydrating,
    loadingStatus,
  };
}

// ─── Sub-component: panel main area ─────────────────────────────────────────

interface PanelMainProps {
  panelSurface: PanelSurface;
  hasActiveTabs: boolean;
  showSessionChrome: boolean;
  needsSessionRecovery: boolean;
  loadingStatus: string;
  activeSessionPath: string | null;
  activeSession: ViewState['activeSession'];
  fileChanges: ViewState['fileChanges'];
  handlers: Pick<AppHandlers, 'handleOpenFileDiff' | 'handleOpenFileInEditor' | 'handleRevertFile' | 'handleEditRequest' | 'handleEditSend' | 'handleCancelEdit' | 'handleOpenFile' | 'handleOpenContextMenu' | 'handleNewSession'>;
  postMessage: (msg: WebviewToHostMessage) => void;
  mergedTranscript: ChatMessage[];
  transcriptWindow: ViewState['transcriptWindow'];
  transcriptLoaded: ViewState['transcriptLoaded'];
  busy: ViewState['busy'];
  prefs: ViewState['prefs'];
  pruningSettings: ViewState['pruningSettings'];
  systemPrompts: ViewState['systemPrompts'];
  pruningResult: ViewState['pruningResult'];
  pendingAssistantModelId: string;
  pendingAssistantThinkingLevel: ThinkingLevel;
  editingMessageId: ViewState['editingMessageId'];
  workspaceCwd: ViewState['workspaceCwd'];
  openTabPaths: ViewState['openTabPaths'];
}

function PanelMain({
  panelSurface,
  hasActiveTabs,
  showSessionChrome,
  needsSessionRecovery,
  loadingStatus,
  activeSessionPath,
  activeSession,
  fileChanges,
  handlers,
  postMessage,
  mergedTranscript,
  transcriptWindow,
  transcriptLoaded,
  busy,
  prefs,
  pruningSettings,
  systemPrompts,
  pruningResult,
  pendingAssistantModelId,
  pendingAssistantThinkingLevel,
  editingMessageId,
  workspaceCwd,
  openTabPaths,
}: PanelMainProps) {
  return (
    <div class="panel-main">
      {showSessionChrome && (
        <FileChangesPanel
          fileChanges={fileChanges}
          onOpenDiff={handlers.handleOpenFileDiff}
          onOpenInEditor={handlers.handleOpenFileInEditor}
          onRevertFile={handlers.handleRevertFile}
        />
      )}
      {panelSurface === 'loading' ? (
        <div class="empty-state empty-state--loading">
          <LoadingIndicator status={loadingStatus} />
        </div>
      ) : !hasActiveTabs ? (
        <div class="empty-state">
          <div class="empty-state-title">Start a session</div>
          <div class="empty-state-sub">
            Sessions stay in tabs, and model settings remain visible while you work.
          </div>
          <button class="btn" onClick={handlers.handleNewSession}>New Session</button>
        </div>
      ) : needsSessionRecovery ? (
        <div class="empty-state empty-state--loading">
          <LoadingIndicator status={loadingStatus} />
        </div>
      ) : (
        <TranscriptHost
          openTabPaths={openTabPaths}
          activeSessionPath={activeSessionPath}
          loadingStatus={loadingStatus}
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
          onEditRequest={handlers.handleEditRequest}
          onEditConfirm={handlers.handleEditSend}
          onEditCancel={handlers.handleCancelEdit}
          onOpenFile={handlers.handleOpenFile}
          onContextMenu={handlers.handleOpenContextMenu}
          postMessage={postMessage}
        />
      )}
    </div>
  );
}

// ─── Sub-component: bottom chrome (composer + extension UI) ───────────────────

interface BottomSectionProps {
  hasActiveTabs: boolean;
  needsSessionRecovery: boolean;
  pendingExtensionUIRequest: ViewState['pendingExtensionUIRequest'];
  activeSessionPath: string | null;
  isAskUserHandledInline: boolean;
  postMessage: (msg: WebviewToHostMessage) => void;
  busy: ViewState['busy'];
  activeSession: ViewState['activeSession'];
  modelSettings: ViewState['modelSettings'];
  availableModels: ViewState['availableModels'];
  availableExtensions: ViewState['availableExtensions'];
  contextUsage: ViewState['contextUsage'];
  prefs: ViewState['prefs'];
  pruningSettings: ViewState['pruningSettings'];
  pruningCatalog: ViewState['pruningCatalog'];
  pruningResult: ViewState['pruningResult'];
  systemPrompts: ViewState['systemPrompts'];
  transcript: ChatMessage[];
  transcriptWindow: ViewState['transcriptWindow'];
  draftRestore: { text: string; nonce: number } | null;
  draftText: string;
  pendingComposerInputs: ViewState['pendingComposerInputs'];
  activeRunSummary: ViewState['activeRunSummary'];
  handlers: Pick<AppHandlers, 'handleSend' | 'handleInterrupt' | 'handleOpenFilePicker' | 'handleAddComposerInput' | 'handleRemoveComposerInput' | 'handleModelChange' | 'handleSetPrefs' | 'handleSetPruningSettings' | 'handleMarkComplete'>;
}

function BottomSection({
  hasActiveTabs,
  needsSessionRecovery,
  pendingExtensionUIRequest,
  activeSessionPath,
  isAskUserHandledInline,
  postMessage,
  busy,
  activeSession,
  modelSettings,
  availableModels,
  availableExtensions,
  contextUsage,
  prefs,
  pruningSettings,
  pruningCatalog,
  pruningResult,
  systemPrompts,
  transcript,
  transcriptWindow,
  draftRestore,
  draftText,
  pendingComposerInputs,
  activeRunSummary,
  handlers,
}: BottomSectionProps) {
  if (!hasActiveTabs || needsSessionRecovery) return null;

  return (
    <>
      {pendingExtensionUIRequest && activeSessionPath && !isAskUserHandledInline && (
        <ExtensionUIPrompt sessionPath={activeSessionPath} request={pendingExtensionUIRequest} postMessage={postMessage} />
      )}
      <Composer
        sessionPath={activeSessionPath}
        draftText={draftText}
        postMessage={postMessage}
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
        onSend={handlers.handleSend}
        onInterrupt={handlers.handleInterrupt}
        onOpenFilePicker={handlers.handleOpenFilePicker}
        onAddInput={handlers.handleAddComposerInput}
        onRemoveInput={handlers.handleRemoveComposerInput}
        onModelChange={handlers.handleModelChange}
        onSetPrefs={handlers.handleSetPrefs}
        onSetPruningSettings={handlers.handleSetPruningSettings}
        onMarkComplete={handlers.handleMarkComplete}
      />
    </>
  );
}

// ─── Main component ──────────────────────────────────────────────────────────

export function AppBody({ adapter }: AppBodyProps) {
  const { postMessage } = adapter;
  const { viewState, mergedTranscript, draftRestore, activeSessionPathRef, setDraftRestore, addOptimisticMessage } =
    useHostSync(postMessage, adapter.initialState);

  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  const handlers = useAppHandlers(
    postMessage,
    activeSessionPathRef,
    setDraftRestore,
    addOptimisticMessage,
    setContextMenu,
  );

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

  const derived = useAppBodyDerivedState(viewState, postMessage);

  useSessionRecovery(viewState.backendReady, derived.needsSessionRecovery, derived.recoverySessionPath, viewState.notice, postMessage);

  // Apply UI prefs (expanded-section font size, font stacks, accent color) as
  // CSS custom properties on :root so every component picks them up via var().
  // Empty-string font overrides are cleared so the bundled stylesheet defaults
  // win (setProperty(key, '') removes the inline declaration). The accent color
  // also derives its hover shade (--panel-accent-strong) and readable foreground
  // (--panel-accent-contrast); both are cleared when no accent is set so the
  // bundled gold defaults apply unchanged.
  useEffect(() => {
    const root = document.documentElement.style;
    root.setProperty('--expanded-font-size', `${viewState.prefs.expandedSectionFontSize}px`);
    root.setProperty('--panel-font-sans', viewState.prefs.uiFontSans);
    root.setProperty('--panel-font-mono', viewState.prefs.uiFontMono);
    const accent = viewState.prefs.uiAccentColor;
    if (accent) {
      root.setProperty('--panel-accent', accent);
      root.setProperty('--panel-accent-strong', 'color-mix(in srgb, var(--panel-accent) 82%, white)');
      const contrast = accentContrastColor(accent);
      root.setProperty('--panel-accent-contrast', contrast ?? '');
    } else {
      root.setProperty('--panel-accent', '');
      root.setProperty('--panel-accent-strong', '');
      root.setProperty('--panel-accent-contrast', '');
    }
  }, [
    viewState.prefs.expandedSectionFontSize,
    viewState.prefs.uiFontSans,
    viewState.prefs.uiFontMono,
    viewState.prefs.uiAccentColor,
  ]);

  return (
    <NoticeContext.Provider value={{ notice: viewState.notice, dismiss: () => postMessage({ type: 'dismissNotice' }) }}>
    <AskUserContext.Provider value={derived.askUserContextValue}>
    <div id="app">
      {viewState.showOutcomeDialog && viewState.activeSession && (
        <RunOutcomeDialog
          sessionLabel={viewState.activeSession.name}
          onCancel={handlers.handleCancelOutcome}
          onSubmit={handlers.handleRecordOutcome}
        />
      )}
      {contextMenu && (
        <ContextMenu
          menu={contextMenu}
          prefs={viewState.prefs}
          onSetPrefs={handlers.handleSetPrefs}
          onClose={closeContextMenu}
        />
      )}
      {viewState.notice && (
        <NoticeBanner notice={viewState.notice} onDismiss={() => postMessage({ type: 'dismissNotice' })} />
      )}

      {derived.showSessionChrome && (
        <SessionTabs
          sessions={viewState.sessions}
          openTabPaths={viewState.openTabPaths}
          runningSessionPaths={viewState.runningSessionPaths}
          unreadFinishedSessionPaths={viewState.unreadFinishedSessionPaths}
          activeSession={viewState.activeSession}
          activeRunSummary={viewState.activeRunSummary}
          backendReady={viewState.backendReady}
          hideConnectingWheel={derived.transcriptHydrating || derived.needsSessionRecovery}
          pendingExtensionUIRequestsBySession={viewState.pendingExtensionUIRequestsBySession}
          runSummariesBySession={viewState.runSummariesBySession}
          onSelect={handlers.handleSelectTab}
          onClose={handlers.handleCloseTab}
          onMove={handlers.handleMoveTab}
          onNew={handlers.handleNewSession}
          onMarkComplete={handlers.handleMarkComplete}
          onDuplicate={handlers.handleDuplicateTab}
          onRunAction={handlers.handleTabRunAction}
        />
      )}

      <PanelMain
        panelSurface={derived.panelSurface}
        hasActiveTabs={derived.hasActiveTabs}
        showSessionChrome={derived.showSessionChrome}
        needsSessionRecovery={derived.needsSessionRecovery}
        loadingStatus={derived.loadingStatus}
        activeSessionPath={derived.activeSessionPath}
        activeSession={viewState.activeSession}
        fileChanges={viewState.fileChanges}
        handlers={handlers}
        postMessage={postMessage}
        mergedTranscript={mergedTranscript}
        transcriptWindow={viewState.transcriptWindow}
        transcriptLoaded={viewState.transcriptLoaded}
        busy={viewState.busy}
        prefs={viewState.prefs}
        pruningSettings={viewState.pruningSettings}
        systemPrompts={viewState.systemPrompts}
        pruningResult={viewState.pruningResult}
        pendingAssistantModelId={derived.pendingAssistantModelId}
        pendingAssistantThinkingLevel={derived.pendingAssistantThinkingLevel}
        editingMessageId={viewState.editingMessageId}
        workspaceCwd={viewState.workspaceCwd}
        openTabPaths={viewState.openTabPaths}
      />

      <BottomSection
        hasActiveTabs={derived.hasActiveTabs}
        needsSessionRecovery={derived.needsSessionRecovery}
        pendingExtensionUIRequest={viewState.pendingExtensionUIRequest}
        activeSessionPath={derived.activeSessionPath}
        isAskUserHandledInline={derived.isAskUserHandledInline}
        postMessage={postMessage}
        busy={viewState.busy}
        activeSession={viewState.activeSession}
        modelSettings={viewState.modelSettings}
        availableModels={viewState.availableModels}
        availableExtensions={viewState.availableExtensions}
        contextUsage={viewState.contextUsage}
        prefs={viewState.prefs}
        pruningSettings={viewState.pruningSettings}
        pruningCatalog={viewState.pruningCatalog}
        pruningResult={viewState.pruningResult}
        systemPrompts={viewState.systemPrompts}
        transcript={viewState.transcript}
        transcriptWindow={viewState.transcriptWindow}
        draftRestore={draftRestore}
        draftText={viewState.draftText}
        pendingComposerInputs={viewState.pendingComposerInputs}
        activeRunSummary={viewState.activeRunSummary}
        handlers={handlers}
      />
    </div>
    </AskUserContext.Provider>
    </NoticeContext.Provider>
  );
}
