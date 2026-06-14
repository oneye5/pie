import * as crypto from 'node:crypto';

import * as vscode from 'vscode';

import type { WebviewToHostMessage, SessionSummary, ChatPrefs, PruningSettings, ComposerInputDraft, ThinkingLevel } from '../../shared/protocol';
import type { Event } from './events';
import type { ArchState } from './reducer';
import type { StatsService } from '../stats-service';
import type { FileDiffService } from './file-diff-service';
import type { BackendLike } from './effect-runner';
import { selectViewState } from './projection';
import { bootLog } from '../util/audit';
import { buildOptimisticUserParts, buildPromptText } from './composer';
import { QueueManager, type QueueManagerDeps } from './queue-manager';

/** Minimal sidebar provider surface the router needs. */
export interface SidebarProviderLike {
  reveal(): void;
  postState(): void;
  postImperative(msg: any): void;
}

/** Minimal context surface the router needs (for persistence). */
export interface ContextLike {
  globalState: {
    update(key: string, value: any): Thenable<void>;
  };
}

/** Minimal session-service surface the router needs. */
export interface SessionServiceLike {
  hydrateModelState(sessionPath: string): Promise<void>;
  bumpSessionDataEpoch(sessionPath: string): void;
  suppressNextCompletionNotificationFor(sessionPath: string): void;
  addFilesystemPaths(requestedSessionPath: string | undefined, paths: string[], source: 'picker' | 'drop'): Promise<void>;
  addComposerInput(requestedSessionPath: string | undefined, inputDraft: ComposerInputDraft): Promise<void>;
  removeComposerInput(requestedSessionPath: string | undefined, inputId: string): void;
  createNewSession(): string;
  openSession(sessionPath: string): void;
  closeSession(sessionPath: string): Promise<void>;
  moveSessionTab(sessionPath: string | undefined, fromIndex: number, toIndex: number): void;
  loadOlderTranscript(sessionPath?: string): Promise<void>;
  loadNewerTranscript(sessionPath?: string): Promise<void>;
  jumpToLatestTranscript(sessionPath?: string): Promise<void>;
  setModel(requestedSessionPath: string | undefined, defaultModel: string, defaultThinkingLevel: ThinkingLevel): Promise<void>;
  setPrefs(prefs: Partial<ChatPrefs>): void;
  setPruningSettings(updates: Partial<PruningSettings>): Promise<void>;
  dropSessionLocalState(sessionPath: string): void;
}

/**
 * Routes incoming {@link WebviewToHostMessage} instances to the appropriate
 * handler logic. Each `type` case is a private method; the public {@link handle}
 * dispatches to it.
 *
 * Extracted from `PieExtension` (design decision #10) so that the extension
 * class remains a thin orchestrator — wiring, lifecycle, CQRS dispatch, and
 * the render pipeline.
 */
export class MessageRouter {
  private readonly queueManager: QueueManager;

  constructor(
    private readonly dispatchEvent: (event: Event) => void,
    private readonly getArchState: () => ArchState,
    private readonly service: SessionServiceLike,
    private readonly statsService: StatsService,
    private readonly sidebarProvider: SidebarProviderLike,
    private readonly fileDiffService: FileDiffService,
    private readonly backend: BackendLike,
    private readonly scheduleRender: () => void,
    private readonly flushRender: () => void,
    private readonly deriveSessionNameFromTextFn: (text: string) => { name: string; isPlaceholder: boolean },
    private readonly isPendingTabPathFn: (path: string) => boolean,
    private readonly context: ContextLike,
  ) {
    const queueDeps: QueueManagerDeps = {
      dispatchEvent: (event) => void this.dispatchEvent(event),
      getArchState,
      scheduleRender,
      isPendingTabPath: isPendingTabPathFn,
      dropSessionLocalState: (sessionPath: string) => service.dropSessionLocalState(sessionPath),
      deriveSessionNameFromText: deriveSessionNameFromTextFn,
    };
    this.queueManager = new QueueManager(queueDeps, (msg) => this.handle(msg));
  }

  async handle(msg: WebviewToHostMessage): Promise<void> {
    if (msg.type === 'ready' || msg.type === 'refreshState' || msg.type === 'requestSnapshot') {
      const viewState = selectViewState(this.getArchState());
      bootLog('extension-host', `webview.${msg.type}`, {
        activeSessionPath: viewState.activeSession?.path ?? null,
        backendReady: viewState.backendReady,
        notice: viewState.notice,
        openTabCount: viewState.openTabPaths.length,
        transcriptLoaded: viewState.transcriptLoaded,
      });
    }

    switch (msg.type) {
      case 'ready':
        return this.onReady();

      case 'refreshState':
        return await this.onRefreshState();

      case 'requestSnapshot':
        return this.onRequestSnapshot();

      case 'send':
        return await this.onSend(msg as Extract<WebviewToHostMessage, { type: 'send' }>);

      case 'editMessage':
        return await this.onEditMessage(msg as Extract<WebviewToHostMessage, { type: 'editMessage' }>);

      case 'interrupt':
        return this.onInterrupt(msg as Extract<WebviewToHostMessage, { type: 'interrupt' }>);

      case 'openFilePicker':
        return await this.onOpenFilePicker();

      case 'addComposerInput':
        return await this.onAddComposerInput(msg as Extract<WebviewToHostMessage, { type: 'addComposerInput' }>);

      case 'removeComposerInput':
        return this.onRemoveComposerInput(msg as Extract<WebviewToHostMessage, { type: 'removeComposerInput' }>);

      case 'openFile':
        return await this.onOpenFile(msg as Extract<WebviewToHostMessage, { type: 'openFile' }>);

      case 'newSession':
        return this.onNewSession();

      case 'openSession':
        return this.onOpenSession(msg as Extract<WebviewToHostMessage, { type: 'openSession' }>);

      case 'closeSession':
        return await this.onCloseSession(msg as Extract<WebviewToHostMessage, { type: 'closeSession' }>);

      case 'moveSessionTab':
        return this.onMoveSessionTab(msg as Extract<WebviewToHostMessage, { type: 'moveSessionTab' }>);

      case 'loadOlderTranscript':
        return await this.onLoadOlderTranscript(msg as Extract<WebviewToHostMessage, { type: 'loadOlderTranscript' }>);

      case 'loadNewerTranscript':
        return await this.onLoadNewerTranscript(msg as Extract<WebviewToHostMessage, { type: 'loadNewerTranscript' }>);

      case 'jumpToLatestTranscript':
        return await this.onJumpToLatestTranscript(msg as Extract<WebviewToHostMessage, { type: 'jumpToLatestTranscript' }>);

      case 'recordOutcome':
        return this.onRecordOutcome(msg as Extract<WebviewToHostMessage, { type: 'recordOutcome' }>);

      case 'startNewTask':
        return this.onStartNewTask(msg as Extract<WebviewToHostMessage, { type: 'startNewTask' }>);

      case 'continueTask':
        return this.onContinueTask(msg as Extract<WebviewToHostMessage, { type: 'continueTask' }>);

      case 'setModel':
        return await this.onSetModel(msg as Extract<WebviewToHostMessage, { type: 'setModel' }>);

      case 'openFileDiff':
        return await this.onOpenFileDiff(msg as Extract<WebviewToHostMessage, { type: 'openFileDiff' }>);

      case 'openFileInEditor':
        return await this.onOpenFileInEditor(msg as Extract<WebviewToHostMessage, { type: 'openFileInEditor' }>);

      case 'revertFile':
        return await this.onRevertFile(msg as Extract<WebviewToHostMessage, { type: 'revertFile' }>);

      case 'setPrefs':
        return this.onSetPrefs(msg as Extract<WebviewToHostMessage, { type: 'setPrefs' }>);

      case 'setPruningSettings':
        return await this.onSetPruningSettings(msg as Extract<WebviewToHostMessage, { type: 'setPruningSettings' }>);

      case 'startEdit':
        return this.onStartEdit(msg as Extract<WebviewToHostMessage, { type: 'startEdit' }>);

      case 'cancelEdit':
        return this.onCancelEdit();

      case 'dismissNotice':
        return this.onDismissNotice();

      case 'openOutcomeDialog':
        return this.onOpenOutcomeDialog();

      case 'closeOutcomeDialog':
        return this.onCloseOutcomeDialog();

      case 'stateApplied':
        return this.onStateApplied(msg as Extract<WebviewToHostMessage, { type: 'stateApplied' }>);

      case 'extensionUiResponse':
        return await this.onExtensionUiResponse(msg as Extract<WebviewToHostMessage, { type: 'extensionUiResponse' }>);

      default:
        return;
    }
  }

  // ---------------------------------------------------------------------------
  // Individual message handlers
  // ---------------------------------------------------------------------------

  private onReady(): void {
    this.sidebarProvider.postState();
  }

  private async onRefreshState(): Promise<void> {
    const activeSessionPath = this.getArchState().sessions.activeSessionPath;
    if (activeSessionPath) {
      await this.service.hydrateModelState(activeSessionPath);
    }
    this.sidebarProvider.postState();
  }

  private onRequestSnapshot(): void {
    this.sidebarProvider.postState();
  }

  private async onSend(msg: Extract<WebviewToHostMessage, { type: 'send' }>): Promise<void> {
    const sessionPath = typeof msg.sessionPath === 'string' ? msg.sessionPath : null;
    const text = typeof msg.text === 'string' ? msg.text : '';
    const webviewLocalId = msg.localId;
    if (!sessionPath) {
      this.dispatchEvent({ kind: 'NoticeShown', notice: 'Protocol defect: send arrived without a sessionPath.' });
      return;
    }

    // If the session is still being created, queue the send and show optimistic UI.
    if (this.isPendingTabPathFn(sessionPath)) {
      if (!text.trim()) return;
      this.queueManager.enqueuePendingSend(sessionPath, { text, localId: webviewLocalId });
      return;
    }
    // If the backend is still starting, queue the send and show optimistic UI.
    if (!this.getArchState().settings.backendReady) {
      if (!text.trim()) return;
      this.queueManager.enqueueBackendReadySend(sessionPath, { text, localId: webviewLocalId });
      return;
    }

    if (!this.getArchState().sessions.openTabPaths.includes(sessionPath)) {
      this.dispatchEvent({ kind: 'NoticeShown', notice: 'Cannot send: the selected session is no longer open.' });
      return;
    }

    const inputs = [
      ...(this.getArchState().composer.pendingComposerInputsBySession[sessionPath] ?? []),
    ];
    if (!text.trim() && inputs.length === 0) return;

    // Pre-compute values the reducer needs.
    this.service.bumpSessionDataEpoch(sessionPath);
    this.statsService.prepareForSend(sessionPath, inputs);
    const composedText = buildPromptText(text, inputs);
    const userParts = buildOptimisticUserParts(text, inputs);
    const localId = webviewLocalId ?? `local:${Date.now()}:${Math.random().toString(36).slice(2)}`;

    // Optimistic session name.
    let previousSummary = null as SessionSummary | null;
    const session = this.getSessionByPath(sessionPath);
    if (session?.isPlaceholder) {
      const derived = this.deriveSessionNameFromTextFn(composedText);
      if (!derived.isPlaceholder && derived.name !== session.name) {
        previousSummary = session;
        this.dispatchEvent({ kind: 'SessionNameDerived', sessionPath, name: derived.name });
        this.scheduleRender();
      }
    }

    // Dispatch through CQRS spine.
    const corrId = crypto.randomUUID();
    this.dispatchEvent({
      kind: 'Command',
      cmd: { kind: 'Send', corrId, sessionPath, text, inputs, composedText, localId, userParts, previousSummary },
    });
  }

  private async onEditMessage(msg: Extract<WebviewToHostMessage, { type: 'editMessage' }>): Promise<void> {
    const sessionPath = typeof msg.sessionPath === 'string' ? msg.sessionPath : null;
    const text = typeof msg.text === 'string' ? msg.text : '';
    const messageId = typeof msg.messageId === 'string' ? msg.messageId : '';
    if (!sessionPath) {
      this.dispatchEvent({ kind: 'NoticeShown', notice: 'Protocol defect: editMessage arrived without a sessionPath.' });
      return;
    }
    if (!text.trim() || !messageId) return;

    // Pre-flight validation.
    if (this.isPendingTabPathFn(sessionPath)) {
      this.dispatchEvent({ kind: 'NoticeShown', notice: 'Cannot edit: the session is still opening.' });
      return;
    }
    if (!this.getArchState().sessions.openTabPaths.includes(sessionPath)) {
      this.dispatchEvent({ kind: 'NoticeShown', notice: 'Cannot edit: the selected session is no longer open.' });
      return;
    }

    this.service.bumpSessionDataEpoch(sessionPath);
    this.statsService.onTruncatedAfter(sessionPath, messageId);
    this.statsService.onMessageEdited(sessionPath, messageId);
    this.statsService.prepareForSend(sessionPath, []);
    const localId = `local:edit:${Date.now()}:${Math.random().toString(36).slice(2)}`;

    // Dispatch through CQRS spine.
    const corrId = crypto.randomUUID();
    this.dispatchEvent({
      kind: 'Command',
      cmd: { kind: 'Edit', corrId, sessionPath, messageId, text, localId },
    });
  }

  private onInterrupt(msg: Extract<WebviewToHostMessage, { type: 'interrupt' }>): void {
    const sessionPath = typeof msg.sessionPath === 'string' ? msg.sessionPath : null;
    if (!sessionPath) {
      this.dispatchEvent({ kind: 'NoticeShown', notice: 'Protocol defect: interrupt arrived without a sessionPath.' });
      return;
    }
    // Phase 3: route through the CQRS reducer + effect runner.
    const corrId = crypto.randomUUID();
    this.dispatchEvent({
      kind: 'Command',
      cmd: { kind: 'Interrupt', corrId, sessionPath },
    });
    this.service.suppressNextCompletionNotificationFor(sessionPath);
  }

  private async onOpenFilePicker(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: true,
      canSelectFiles: true,
      canSelectFolders: true,
      openLabel: 'Attach',
      title: 'Attach file path(s) to message',
    });
    if (!uris || uris.length === 0) return;
    await this.service.addFilesystemPaths(undefined, uris.map((u) => u.fsPath), 'picker');
  }

  private async onAddComposerInput(msg: Extract<WebviewToHostMessage, { type: 'addComposerInput' }>): Promise<void> {
    await this.service.addComposerInput(msg.sessionPath, msg.input);
  }

  private onRemoveComposerInput(msg: Extract<WebviewToHostMessage, { type: 'removeComposerInput' }>): void {
    this.service.removeComposerInput(msg.sessionPath, msg.inputId);
  }

  private async onOpenFile(msg: Extract<WebviewToHostMessage, { type: 'openFile' }>): Promise<void> {
    if (typeof msg.path !== 'string' || !msg.path.trim()) return;
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(msg.path));
  }

  private onNewSession(): void {
    this.service.createNewSession();
    this.sidebarProvider.postState();
  }

  private onOpenSession(msg: Extract<WebviewToHostMessage, { type: 'openSession' }>): void {
    this.dispatchEvent({ kind: 'Command', cmd: { kind: 'SetEditingMessage', corrId: crypto.randomUUID(), sessionPath: msg.sessionPath, messageId: null } });
    this.dispatchEvent({ kind: 'Command', cmd: { kind: 'SetOutcomeDialog', corrId: crypto.randomUUID(), sessionPath: msg.sessionPath, visible: false } });
    this.service.openSession(msg.sessionPath);
    this.sidebarProvider.postState();
  }

  private async onCloseSession(msg: Extract<WebviewToHostMessage, { type: 'closeSession' }>): Promise<void> {
    await this.service.closeSession(msg.sessionPath);
    // Cleanup per-session bookkeeping that lives outside the SessionService.
    // - Arch reducer state (pending RPCs, currentTurn map) via SessionClosed event.
    // - UI singletons (editing/outcome/extensionUI) when they belonged to this session.
    // - Host-owned queues + service-side per-session maps via purgeHostStateForSession.
    // This is the central fix for B4 cross-session bleed.
    this.dispatchEvent({ kind: 'SessionClosed', sessionPath: msg.sessionPath });
    this.purgeHostStateForSession(msg.sessionPath);
    this.dispatchEvent({ kind: 'Command', cmd: { kind: 'SetEditingMessage', corrId: crypto.randomUUID(), sessionPath: msg.sessionPath, messageId: null } });
    this.dispatchEvent({ kind: 'Command', cmd: { kind: 'SetOutcomeDialog', corrId: crypto.randomUUID(), sessionPath: msg.sessionPath, visible: false } });
    // Per-session pendingExtensionUIRequestsBySession is cleaned up by
    // removeSessionFromState (triggered by SessionClosed above).
    this.sidebarProvider.postState();
  }

  private onMoveSessionTab(msg: Extract<WebviewToHostMessage, { type: 'moveSessionTab' }>): void {
    this.service.moveSessionTab(msg.sessionPath, msg.fromIndex, msg.toIndex);
    this.sidebarProvider.postState();
  }

  private async onLoadOlderTranscript(msg: Extract<WebviewToHostMessage, { type: 'loadOlderTranscript' }>): Promise<void> {
    await this.service.loadOlderTranscript(msg.sessionPath);
  }

  private async onLoadNewerTranscript(msg: Extract<WebviewToHostMessage, { type: 'loadNewerTranscript' }>): Promise<void> {
    await this.service.loadNewerTranscript(msg.sessionPath);
  }

  private async onJumpToLatestTranscript(msg: Extract<WebviewToHostMessage, { type: 'jumpToLatestTranscript' }>): Promise<void> {
    await this.service.jumpToLatestTranscript(msg.sessionPath);
  }

  private onRecordOutcome(msg: Extract<WebviewToHostMessage, { type: 'recordOutcome' }>): void {
    this.statsService.recordOutcome(msg.sessionPath, msg.outcome);
  }

  private onStartNewTask(msg: Extract<WebviewToHostMessage, { type: 'startNewTask' }>): void {
    this.statsService.startNewTask(msg.sessionPath);
  }

  private onContinueTask(msg: Extract<WebviewToHostMessage, { type: 'continueTask' }>): void {
    this.statsService.continueTask(msg.sessionPath);
  }

  private async onSetModel(msg: Extract<WebviewToHostMessage, { type: 'setModel' }>): Promise<void> {
    await this.service.setModel(msg.sessionPath, msg.defaultModel, msg.defaultThinkingLevel);
  }

  private async onOpenFileDiff(msg: Extract<WebviewToHostMessage, { type: 'openFileDiff' }>): Promise<void> {
    await this.fileDiffService.openFileDiff(msg.sessionPath, msg.filePath);
  }

  private async onOpenFileInEditor(msg: Extract<WebviewToHostMessage, { type: 'openFileInEditor' }>): Promise<void> {
    await this.fileDiffService.openFileInEditor(msg.sessionPath, msg.filePath);
  }

  private async onRevertFile(msg: Extract<WebviewToHostMessage, { type: 'revertFile' }>): Promise<void> {
    await this.fileDiffService.revertFile(msg.sessionPath, msg.filePath);
    this.dispatchEvent({ kind: 'FileChangeRemoved', sessionPath: msg.sessionPath, filePath: msg.filePath });
    this.scheduleRender();
  }

  private onSetPrefs(msg: Extract<WebviewToHostMessage, { type: 'setPrefs' }>): void {
    this.service.setPrefs(msg.prefs);
    this.sidebarProvider.postState();
  }

  private async onSetPruningSettings(msg: Extract<WebviewToHostMessage, { type: 'setPruningSettings' }>): Promise<void> {
    await this.service.setPruningSettings(msg.settings);
    this.scheduleRender();
  }

  private onStartEdit(msg: Extract<WebviewToHostMessage, { type: 'startEdit' }>): void {
    const corrId = crypto.randomUUID();
    this.dispatchEvent({
      kind: 'Command',
      cmd: { kind: 'SetEditingMessage', corrId, sessionPath: this.getArchState().sessions.activeSessionPath ?? '', messageId: msg.messageId },
    });
  }

  private onCancelEdit(): void {
    const corrId = crypto.randomUUID();
    this.dispatchEvent({
      kind: 'Command',
      cmd: { kind: 'SetEditingMessage', corrId, sessionPath: this.getArchState().sessions.activeSessionPath ?? '', messageId: null },
    });
  }

  private onDismissNotice(): void {
    const corrId = crypto.randomUUID();
    this.dispatchEvent({
      kind: 'Command',
      cmd: { kind: 'DismissNotice', corrId },
    });
  }

  private onOpenOutcomeDialog(): void {
    const corrId = crypto.randomUUID();
    this.dispatchEvent({
      kind: 'Command',
      cmd: { kind: 'SetOutcomeDialog', corrId, sessionPath: this.getArchState().sessions.activeSessionPath ?? '', visible: true },
    });
  }

  private onCloseOutcomeDialog(): void {
    const corrId = crypto.randomUUID();
    this.dispatchEvent({
      kind: 'Command',
      cmd: { kind: 'SetOutcomeDialog', corrId, sessionPath: this.getArchState().sessions.activeSessionPath ?? '', visible: false },
    });
  }

  private onStateApplied(msg: Extract<WebviewToHostMessage, { type: 'stateApplied' }>): void {
    bootLog('webview', 'state.applied', { ...msg.payload });
  }

  private async onExtensionUiResponse(msg: Extract<WebviewToHostMessage, { type: 'extensionUiResponse' }>): Promise<void> {
    // STATE_CONTRACT: webview must address its response to a specific session.
    // Falling back to the active session would let a prompt opened in tab A be
    // resolved against tab B if the user switched tabs before clicking.
    const sessionPath = typeof msg.sessionPath === 'string' ? msg.sessionPath : null;
    if (!sessionPath) {
      this.dispatchEvent({ kind: 'NoticeShown', notice: 'Protocol defect: extensionUiResponse arrived without a sessionPath.' });
      return;
    }
    const corrId = crypto.randomUUID();
    this.dispatchEvent({
      kind: 'Command',
      cmd: { kind: 'RespondExtensionUI', corrId, sessionPath, requestId: msg.response.id, approved: msg.response.confirmed === true },
    });
    await this.backend.request('extension_ui.response', {
      sessionPath,
      response: msg.response,
    });
  }

  // ---------------------------------------------------------------------------
  // Queue delegation (delegated to QueueManager)
  // ---------------------------------------------------------------------------

  drainPendingSendQueue(pendingPath: string, resolvedPath: string): void {
    void this.queueManager.drainPendingSendQueue(pendingPath, resolvedPath);
  }

  drainBackendReadyQueue(): void {
    void this.queueManager.drainBackendReadyQueue();
  }

  purgeHostStateForSession(sessionPath: string): void {
    this.queueManager.purgeHostStateForSession(sessionPath);
  }

  clearBackendReadyQueueWatchdog(): void {
    this.queueManager.clearWatchdog();
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Look up a session from the arch state by path.
   */
  private getSessionByPath(path: string | null | undefined): SessionSummary | null {
    if (!path) return null;
    return this.getArchState().sessions.sessions.find(s => s.path === path) ?? null;
  }
}