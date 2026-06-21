/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useState, useEffect, useMemo, useCallback } from 'preact/hooks';
import type {
  ViewState,
  WebviewToHostMessage,
  ChatMessageToolCallPart,
  ChatMessage,
  ThinkingLevel,
  UiDensity,
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

/** Gap scale (px) per density. 'comfortable' reproduces the bundled defaults
 *  (xs 4 / sm 6 / md 8 / lg 12 / xl 16) so the default leaves the layout
 *  unchanged. Unknown densities fall back to comfortable in the effect. */
const DENSITY_GAPS: Record<UiDensity, { xs: number; sm: number; md: number; lg: number; xl: number }> = {
  compact: { xs: 3, sm: 5, md: 6, lg: 8, xl: 10 },
  comfortable: { xs: 4, sm: 6, md: 8, lg: 12, xl: 16 },
  spacious: { xs: 6, sm: 8, md: 10, lg: 14, xl: 20 },
};

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
  //
  // Memoized: the host posts a fresh `transcript` array reference on every
  // snapshot (~7/sec while streaming), so an un-memoized `transcript.some()`
  // would walk the whole transcript on every render even when nothing relevant
  // changed. The deps are the three values this actually depends on.
  const isAskUserHandledInline = useMemo(
    () =>
      !!activeSessionPath &&
      pendingExtensionUIRequest?.method === 'select' &&
      transcript.some((msg) =>
        msg.parts?.some((p): p is ChatMessageToolCallPart =>
          p.kind === 'toolCall' && p.toolCall.name === 'ask_user' && p.toolCall.status === 'running'
        ),
      ),
    [activeSessionPath, pendingExtensionUIRequest, transcript],
  );

  const askUserContextValue = useMemo(() => ({
    sessionPath: activeSessionPath,
    postMessage,
    pendingRequests: activeSessionPath
      ? (pendingExtensionUIRequestsBySession[activeSessionPath] ?? {})
      : {},
  }), [activeSessionPath, postMessage, pendingExtensionUIRequestsBySession]);

  // Stable notice context value: `dismiss` is fixed for the AppBody lifetime
  // so consumers only re-render when `notice` actually changes, mirroring the
  // memoized `askUserContextValue` above.
  const dismiss = useCallback(() => postMessage({ type: 'dismissNotice' }), []);
  const noticeValue = useMemo(() => ({ notice, dismiss }), [notice, dismiss]);

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
    noticeValue,
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
  fileChangesExpanded: ViewState['fileChangesExpanded'];
  handlers: Pick<AppHandlers, 'handleOpenFileDiff' | 'handleOpenFileInEditor' | 'handleRevertFile' | 'handleSetFileChangesExpanded' | 'handleEditRequest' | 'handleEditSend' | 'handleCancelEdit' | 'handleOpenFile' | 'handleOpenContextMenu' | 'handleNewSession'>;
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
  fileChangesExpanded,
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
      <div class="panel-content">
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
      {showSessionChrome && fileChanges.length > 0 && (
        <FileChangesPanel
          key={activeSessionPath ?? 'none'}
          fileChanges={fileChanges}
          expanded={fileChangesExpanded}
          onToggleExpanded={handlers.handleSetFileChangesExpanded}
          onOpenDiff={handlers.handleOpenFileDiff}
          onOpenInEditor={handlers.handleOpenFileInEditor}
          onRevertFile={handlers.handleRevertFile}
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
  tokenRateBySession: ViewState['tokenRateBySession'];
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
  tokenRateBySession,
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
        tokenRateBySession={tokenRateBySession}
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

  // Apply UI prefs as CSS custom properties on :root so every component picks
  // them up via var(). Overrides are removed with removeProperty() when they
  // are empty so the bundled stylesheet defaults on :root win; setting an
  // empty string would create an invalid custom-property value and break var()
  // resolution instead of falling back.
  //
  // Color derivations: the background drives the whole --panel-ink ramp
  // (every surface token — cards, inputs, hover, overlays — derives from it via
  // var(), so overriding the ramp cascades automatically). Foreground reuses
  // color-mix toward --panel-ink for the soft/muted shades; border derives its
  // subtle variant by thinning alpha. Radius/density always apply (their
  // defaults reproduce the bundled tokens exactly). Accent keeps its existing
  // hover/contrast derivation.
  const { prefs } = viewState;
  useEffect(() => {
    const root = document.documentElement.style;
    root.setProperty('--expanded-font-size', `${prefs.expandedSectionFontSize}px`);
    if (prefs.uiFontSans) {
      root.setProperty('--panel-font-sans', prefs.uiFontSans);
    } else {
      root.removeProperty('--panel-font-sans');
    }
    if (prefs.uiFontMono) {
      root.setProperty('--panel-font-mono', prefs.uiFontMono);
    } else {
      root.removeProperty('--panel-font-mono');
    }
    const width = prefs.uiMessageWidth;
    root.setProperty('--message-assistant-width', `${width}%`);
    root.setProperty('--message-assistant-width-narrow', `${Math.min(100, width + 4)}%`);

    // Background → ink ramp. ink == base; lighter shades mix toward white at
    // small percentages so the default base (#050506) approximates the
    // bundled ramp; black is darkened slightly to preserve the shell layering.
    const bg = prefs.uiBackground;
    if (bg) {
      root.setProperty('--panel-black', `color-mix(in srgb, ${bg} 82%, black)`);
      root.setProperty('--panel-ink', bg);
      root.setProperty('--panel-ink-2', `color-mix(in srgb, ${bg} 98%, white)`);
      root.setProperty('--panel-ink-3', `color-mix(in srgb, ${bg} 96%, white)`);
      root.setProperty('--panel-ink-4', `color-mix(in srgb, ${bg} 93%, white)`);
      root.setProperty('--panel-ink-5', `color-mix(in srgb, ${bg} 89%, white)`);
    } else {
      for (const t of ['--panel-black', '--panel-ink', '--panel-ink-2', '--panel-ink-3', '--panel-ink-4', '--panel-ink-5'] as const) {
        root.removeProperty(t);
      }
    }

    // Foreground → foreground + derived soft/muted toward the background.
    const fg = prefs.uiForeground;
    if (fg) {
      root.setProperty('--panel-foreground', fg);
      root.setProperty('--panel-foreground-soft', `color-mix(in srgb, ${fg} 90%, var(--panel-ink))`);
      root.setProperty('--panel-muted', `color-mix(in srgb, ${fg} 60%, var(--panel-ink))`);
    } else {
      root.removeProperty('--panel-foreground');
      root.removeProperty('--panel-foreground-soft');
      root.removeProperty('--panel-muted');
    }

    // Border → border + derived subtle (thinned alpha, ~0.58× to match the
    // bundled subtle/border ratio). Empty restores the bundled cream lines.
    const bd = prefs.uiBorder;
    if (bd) {
      root.setProperty('--panel-border', bd);
      root.setProperty('--panel-border-subtle', `color-mix(in srgb, ${bd} 58%, transparent)`);
    } else {
      root.removeProperty('--panel-border');
      root.removeProperty('--panel-border-subtle');
    }

    // Accent → accent + hover shade + readable foreground.
    const accent = prefs.uiAccentColor;
    if (accent) {
      root.setProperty('--panel-accent', accent);
      root.setProperty('--panel-accent-strong', 'color-mix(in srgb, var(--panel-accent) 82%, white)');
      const contrast = accentContrastColor(accent);
      if (contrast) {
        root.setProperty('--panel-accent-contrast', contrast);
      } else {
        root.removeProperty('--panel-accent-contrast');
      }
    } else {
      root.removeProperty('--panel-accent');
      root.removeProperty('--panel-accent-strong');
      root.removeProperty('--panel-accent-contrast');
    }

    // Corner radius → sm/md/lg/xl as r-2/r/r+2/r+4 (default 8 = 6/8/10/12).
    const r = prefs.uiCornerRadius;
    root.setProperty('--panel-radius-sm', `${Math.max(0, r - 2)}px`);
    root.setProperty('--panel-radius-md', `${r}px`);
    root.setProperty('--panel-radius-lg', `${r + 2}px`);
    root.setProperty('--panel-radius-xl', `${r + 4}px`);

    // Density → gap scale. 'comfortable' reproduces the bundled defaults.
    const gaps = DENSITY_GAPS[prefs.uiDensity] ?? DENSITY_GAPS.comfortable;
    root.setProperty('--panel-gap-xs', `${gaps.xs}px`);
    root.setProperty('--panel-gap-sm', `${gaps.sm}px`);
    root.setProperty('--panel-gap-md', `${gaps.md}px`);
    root.setProperty('--panel-gap-lg', `${gaps.lg}px`);
    root.setProperty('--panel-gap-xl', `${gaps.xl}px`);
  }, [
    prefs.expandedSectionFontSize,
    prefs.uiFontSans,
    prefs.uiFontMono,
    prefs.uiAccentColor,
    prefs.uiMessageWidth,
    prefs.uiBackground,
    prefs.uiForeground,
    prefs.uiBorder,
    prefs.uiCornerRadius,
    prefs.uiDensity,
  ]);

  return (
    <NoticeContext.Provider value={derived.noticeValue}>
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
          pinnedTabPaths={viewState.pinnedTabPaths}
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
          onTogglePin={handlers.handleTogglePinTab}
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
        fileChangesExpanded={viewState.fileChangesExpanded}
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
        tokenRateBySession={viewState.tokenRateBySession}
        handlers={handlers}
      />
    </div>
    </AskUserContext.Provider>
    </NoticeContext.Provider>
  );
}
