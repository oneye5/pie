import * as crypto from 'node:crypto';

import * as vscode from 'vscode';

import type { WebviewToHostMessage, SessionSummary, ChatPrefs, PruningSettings, ThinkingLevel } from '../../shared/protocol';
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
  bumpSessionDataEpoch(sessionPath: string): void;
  suppressNextCompletionNotificationFor(sessionPath: string): void;
  addFilesystemPaths(requestedSessionPath: string | undefined, paths: string[], source: 'picker' | 'drop'): Promise<void>;
  createNewSession(): string;
  openSession(sessionPath: string): void;
  closeSession(sessionPath: string): Promise<void>;
  duplicateSession(sessionPath: string): void;
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

      case 'setComposerDraft':
        return this.onSetComposerDraft(msg as Extract<WebviewToHostMessage, { type: 'setComposerDraft' }>);

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

      case 'duplicateSession':
        return await this.onDuplicateSession(msg as Extract<WebviewToHostMessage, { type: 'duplicateSession' }>);

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
        return this.onSetModel(msg as Extract<WebviewToHostMessage, { type: 'setModel' }>);

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
        return this.onCancelEdit(msg as Extract<WebviewToHostMessage, { type: 'cancelEdit' }>);

      case 'dismissNotice':
        return this.onDismissNotice();

      case 'openOutcomeDialog':
        return this.onOpenOutcomeDialog(msg as Extract<WebviewToHostMessage, { type: 'openOutcomeDialog' }>);

      case 'closeOutcomeDialog':
        return this.onCloseOutcomeDialog(msg as Extract<WebviewToHostMessage, { type: 'closeOutcomeDialog' }>);

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
      // Phase 2: route through the CQRS reducer + effect runner instead of
      // calling the service directly. The HydrateModel effect is fire-and-forget;
      // the service's dispatched SetModel/AvailableModelsChanged events apply
      // the results.
      this.dispatchEvent({
        kind: 'Command',
        cmd: { kind: 'HydrateModel', corrId: crypto.randomUUID(), sessionPath: activeSessionPath },
      });
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
    const composedText = buildPromptText(text, inputs);
    const userParts = buildOptimisticUserParts(text, inputs);
    const localId = webviewLocalId ?? `local:${crypto.randomUUID()}`;

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
      cmd: { kind: 'Send', corrId, sessionPath, text, inputs, composedText, localId, userParts, previousSummary, timestamp: Date.now() },
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

    const webviewLocalId = msg.localId;
    const localId = webviewLocalId ?? `local:edit:${crypto.randomUUID()}`;

    // Dispatch through CQRS spine.
    const corrId = crypto.randomUUID();
    this.dispatchEvent({
      kind: 'Command',
      cmd: { kind: 'Edit', corrId, sessionPath, messageId, text, localId, timestamp: Date.now() },
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
    const corrId = crypto.randomUUID();
    this.dispatchEvent({
      kind: 'Command',
      cmd: { kind: 'AddFilesystemPaths', corrId, sessionPath: undefined, paths: uris.map((u) => u.fsPath), source: 'picker' },
    });
  }

  private async onAddComposerInput(msg: Extract<WebviewToHostMessage, { type: 'addComposerInput' }>): Promise<void> {
    const corrId = crypto.randomUUID();
    this.dispatchEvent({
      kind: 'Command',
      cmd: { kind: 'AddComposerInput', corrId, sessionPath: msg.sessionPath, input: msg.input },
    });
  }

  private onSetComposerDraft(msg: Extract<WebviewToHostMessage, { type: 'setComposerDraft' }>): void {
    const corrId = crypto.randomUUID();
    this.dispatchEvent({
      kind: 'Command',
      cmd: { kind: 'SetComposerDraft', corrId, sessionPath: msg.sessionPath, text: msg.text },
    });
  }

  private onRemoveComposerInput(msg: Extract<WebviewToHostMessage, { type: 'removeComposerInput' }>): void {
    const corrId = crypto.randomUUID();
    this.dispatchEvent({
      kind: 'Command',
      cmd: { kind: 'RemoveComposerInput', corrId, sessionPath: msg.sessionPath, inputId: msg.inputId },
    });
  }

  private async onOpenFile(msg: Extract<WebviewToHostMessage, { type: 'openFile' }>): Promise<void> {
    if (typeof msg.path !== 'string' || !msg.path.trim()) return;
    const corrId = crypto.randomUUID();
    this.dispatchEvent({
      kind: 'Command',
      cmd: { kind: 'OpenFile', corrId, path: msg.path },
    });
  }

  private onNewSession(): void {
    const corrId = crypto.randomUUID();
    this.dispatchEvent({
      kind: 'Command',
      cmd: { kind: 'CreateSession', corrId, selectionToken: crypto.randomUUID() },
    });
    this.sidebarProvider.postState();
  }

  private onOpenSession(msg: Extract<WebviewToHostMessage, { type: 'openSession' }>): void {
    this.dispatchEvent({ kind: 'Command', cmd: { kind: 'SetEditingMessage', corrId: crypto.randomUUID(), sessionPath: msg.sessionPath, messageId: null } });
    this.dispatchEvent({ kind: 'Command', cmd: { kind: 'SetOutcomeDialog', corrId: crypto.randomUUID(), sessionPath: msg.sessionPath, visible: false } });
    const corrId = crypto.randomUUID();
    this.dispatchEvent({
      kind: 'Command',
      cmd: { kind: 'OpenSession', corrId, sessionPath: msg.sessionPath, selectionToken: crypto.randomUUID() },
    });
    this.sidebarProvider.postState();
  }

  private onDuplicateSession(msg: Extract<WebviewToHostMessage, { type: 'duplicateSession' }>): void {
    const sessionPath = typeof msg.sessionPath === 'string' ? msg.sessionPath : null;
    if (!sessionPath) {
      this.dispatchEvent({ kind: 'NoticeShown', notice: 'Protocol defect: duplicateSession arrived without a sessionPath.' });
      return;
    }
    const corrId = crypto.randomUUID();
    this.dispatchEvent({
      kind: 'Command',
      cmd: { kind: 'DuplicateSession', corrId, sessionPath },
    });
  }

  private onCloseSession(msg: Extract<WebviewToHostMessage, { type: 'closeSession' }>): void {
    this.dispatchEvent({ kind: 'Command', cmd: { kind: 'CloseSession', corrId: crypto.randomUUID(), sessionPath: msg.sessionPath } });
    this.dispatchEvent({ kind: 'Command', cmd: { kind: 'SetEditingMessage', corrId: crypto.randomUUID(), sessionPath: msg.sessionPath, messageId: null } });
    this.dispatchEvent({ kind: 'Command', cmd: { kind: 'SetOutcomeDialog', corrId: crypto.randomUUID(), sessionPath: msg.sessionPath, visible: false } });
    this.sidebarProvider.postState();
  }

  private onMoveSessionTab(msg: Extract<WebviewToHostMessage, { type: 'moveSessionTab' }>): void {
    const corrId = crypto.randomUUID();
    this.dispatchEvent({
      kind: 'Command',
      cmd: { kind: 'MoveSessionTab', corrId, sessionPath: msg.sessionPath, fromIndex: msg.fromIndex, toIndex: msg.toIndex },
    });
    this.sidebarProvider.postState();
  }

  private async onLoadOlderTranscript(msg: Extract<WebviewToHostMessage, { type: 'loadOlderTranscript' }>): Promise<void> {
    const sessionPath = typeof msg.sessionPath === 'string' ? msg.sessionPath : null;
    if (!sessionPath) {
      this.dispatchEvent({ kind: 'NoticeShown', notice: 'Protocol defect: loadOlderTranscript arrived without a sessionPath.' });
      return;
    }
    const corrId = crypto.randomUUID();
    this.dispatchEvent({
      kind: 'Command',
      cmd: { kind: 'LoadOlderTranscript', corrId, sessionPath },
    });
  }

  private async onLoadNewerTranscript(msg: Extract<WebviewToHostMessage, { type: 'loadNewerTranscript' }>): Promise<void> {
    const sessionPath = typeof msg.sessionPath === 'string' ? msg.sessionPath : null;
    if (!sessionPath) {
      this.dispatchEvent({ kind: 'NoticeShown', notice: 'Protocol defect: loadNewerTranscript arrived without a sessionPath.' });
      return;
    }
    const corrId = crypto.randomUUID();
    this.dispatchEvent({
      kind: 'Command',
      cmd: { kind: 'LoadNewerTranscript', corrId, sessionPath },
    });
  }

  private async onJumpToLatestTranscript(msg: Extract<WebviewToHostMessage, { type: 'jumpToLatestTranscript' }>): Promise<void> {
    const sessionPath = typeof msg.sessionPath === 'string' ? msg.sessionPath : null;
    if (!sessionPath) {
      this.dispatchEvent({ kind: 'NoticeShown', notice: 'Protocol defect: jumpToLatestTranscript arrived without a sessionPath.' });
      return;
    }
    const corrId = crypto.randomUUID();
    this.dispatchEvent({
      kind: 'Command',
      cmd: { kind: 'JumpToLatestTranscript', corrId, sessionPath },
    });
  }

  private onRecordOutcome(msg: Extract<WebviewToHostMessage, { type: 'recordOutcome' }>): void {
    const corrId = crypto.randomUUID();
    this.dispatchEvent({
      kind: 'Command',
      cmd: { kind: 'RecordOutcome', corrId, sessionPath: msg.sessionPath, outcome: msg.outcome },
    });
  }

  private onStartNewTask(msg: Extract<WebviewToHostMessage, { type: 'startNewTask' }>): void {
    const corrId = crypto.randomUUID();
    this.dispatchEvent({
      kind: 'Command',
      cmd: { kind: 'StartNewTask', corrId, sessionPath: msg.sessionPath },
    });
  }

  private onContinueTask(msg: Extract<WebviewToHostMessage, { type: 'continueTask' }>): void {
    const corrId = crypto.randomUUID();
    this.dispatchEvent({
      kind: 'Command',
      cmd: { kind: 'ContinueTask', corrId, sessionPath: msg.sessionPath },
    });
  }

  private onSetModel(msg: Extract<WebviewToHostMessage, { type: 'setModel' }>): void {
    this.dispatchEvent({
      kind: 'Command',
      cmd: {
        kind: 'SetModel',
        corrId: crypto.randomUUID(),
        sessionPath: msg.sessionPath || '',
        modelSettings: {
          defaultModel: msg.defaultModel,
          defaultThinkingLevel: msg.defaultThinkingLevel,
        },
      },
    });
  }

  private onOpenFileDiff(msg: Extract<WebviewToHostMessage, { type: 'openFileDiff' }>): void {
    const corrId = crypto.randomUUID();
    this.dispatchEvent({
      kind: 'Command',
      cmd: { kind: 'OpenFileDiff', corrId, sessionPath: msg.sessionPath, filePath: msg.filePath, status: 'modified' },
    });
  }

  private async onOpenFileInEditor(msg: Extract<WebviewToHostMessage, { type: 'openFileInEditor' }>): Promise<void> {
    const corrId = crypto.randomUUID();
    this.dispatchEvent({
      kind: 'Command',
      cmd: { kind: 'OpenFileInEditor', corrId, sessionPath: msg.sessionPath, filePath: msg.filePath },
    });
  }

  private onRevertFile(msg: Extract<WebviewToHostMessage, { type: 'revertFile' }>): void {
    const corrId = crypto.randomUUID();
    this.dispatchEvent({
      kind: 'Command',
      cmd: { kind: 'RevertFile', corrId, sessionPath: msg.sessionPath, filePath: msg.filePath },
    });
    this.dispatchEvent({ kind: 'FileChangeRemoved', sessionPath: msg.sessionPath, filePath: msg.filePath });
    this.scheduleRender();
  }

  private onSetPrefs(msg: Extract<WebviewToHostMessage, { type: 'setPrefs' }>): void {
    this.dispatchEvent({
      kind: 'Command',
      cmd: { kind: 'SetPrefs', corrId: crypto.randomUUID(), prefs: msg.prefs },
    });
  }

  private async onSetPruningSettings(msg: Extract<WebviewToHostMessage, { type: 'setPruningSettings' }>): Promise<void> {
    const corrId = crypto.randomUUID();
    this.dispatchEvent({
      kind: 'Command',
      cmd: { kind: 'SetPruningSettings', corrId, settings: msg.settings },
    });
    this.scheduleRender();
  }

  private onStartEdit(msg: Extract<WebviewToHostMessage, { type: 'startEdit' }>): void {
    const corrId = crypto.randomUUID();
    this.dispatchEvent({
      kind: 'Command',
      cmd: { kind: 'SetEditingMessage', corrId, sessionPath: msg.sessionPath, messageId: msg.messageId },
    });
  }

  private onCancelEdit(msg: Extract<WebviewToHostMessage, { type: 'cancelEdit' }>): void {
    const corrId = crypto.randomUUID();
    this.dispatchEvent({
      kind: 'Command',
      cmd: { kind: 'SetEditingMessage', corrId, sessionPath: msg.sessionPath, messageId: null },
    });
  }

  private onDismissNotice(): void {
    const corrId = crypto.randomUUID();
    this.dispatchEvent({
      kind: 'Command',
      cmd: { kind: 'DismissNotice', corrId },
    });
  }

  private onOpenOutcomeDialog(msg: Extract<WebviewToHostMessage, { type: 'openOutcomeDialog' }>): void {
    const corrId = crypto.randomUUID();
    this.dispatchEvent({
      kind: 'Command',
      cmd: { kind: 'SetOutcomeDialog', corrId, sessionPath: msg.sessionPath, visible: true },
    });
  }

  private onCloseOutcomeDialog(msg: Extract<WebviewToHostMessage, { type: 'closeOutcomeDialog' }>): void {
    const corrId = crypto.randomUUID();
    this.dispatchEvent({
      kind: 'Command',
      cmd: { kind: 'SetOutcomeDialog', corrId, sessionPath: msg.sessionPath, visible: false },
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
      cmd: { kind: 'RespondExtensionUI', corrId, sessionPath, requestId: msg.response.id, approved: msg.response.confirmed === true, response: msg.response },
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