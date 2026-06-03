import * as crypto from 'node:crypto';
import * as path from 'node:path';

import { EffectRunner } from '../host/core/effect-runner';
import type { SyncEffect } from '../host/core/effects';
import type { Event } from '../host/core/events';
import { initialArchState, reducer, type ArchState } from '../host/core/reducer';
import { NOOP_RUN_OBSERVER } from '../host/stats-service';
import { buildOptimisticUserParts, buildPromptText } from '../host/session-service/composer';
import { SessionServiceEvents } from '../host/session-service/events';
import { SessionMessageActions } from '../host/session-service/message-actions';
import { SessionServiceState } from '../host/session-service/state';
import { SessionTabActions } from '../host/session-service/tab-actions';
import {
  fileChangesActions,
  getSessionByPath,
  selectActiveSessionPath,
  selectViewState,
  sessionStateActions,
  sessionsActions,
  settingsActions,
  store,
  transcriptActions,
  uiActions,
} from '../host/store';
import { resolveChatPrefs } from '../shared/protocol';
import type {
  ChatPrefs,
  ComposerInputDraft,
  EventEnvelope,
  ExtensionInfo,
  ModelInfo,
  ModelSettings,
  PruningSettings,
  SessionOpenedPayload,
  SessionSummary,
  ThinkingLevel,
  TranscriptPagePayload,
  ViewState,
  WebviewToHostMessage,
} from '../shared/protocol';
import { deriveSessionNameFromText } from '../shared/session-name';
import { isPendingTabPath } from '../shared/tab-behavior';

interface BackendLike {
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
}

export interface HeadlessWebviewDevHostOptions {
  workspaceRoot: string;
  knownExtensions: ExtensionInfo[];
  initialPrefs: ChatPrefs;
  initialPruningSettings: PruningSettings;
}

export interface PendingSessionRequest {
  pendingPath: string;
  selectionToken: string;
}

const PREFS_STORAGE_KEY = 'chatPrefs';

function createMemoryMemento(): { get<T>(key: string): T | undefined; update(key: string, value: unknown): Promise<void> } {
  const values = new Map<string, unknown>();
  return {
    get<T>(key: string): T | undefined {
      return values.get(key) as T | undefined;
    },
    async update(key: string, value: unknown): Promise<void> {
      if (value === undefined) values.delete(key);
      else values.set(key, value);
    },
  };
}

function createHeadlessContext(workspaceRoot: string): any {
  return {
    extensionMode: 0,
    extensionPath: workspaceRoot,
    globalState: createMemoryMemento(),
    workspaceState: createMemoryMemento(),
    globalStorageUri: { fsPath: path.join(workspaceRoot, 'data') },
    subscriptions: [],
  };
}

export class HeadlessWebviewDevHost {
  private readonly context: any;
  private readonly state: SessionServiceState;
  private readonly events: SessionServiceEvents;
  private readonly tabs: SessionTabActions;
  private readonly messages: SessionMessageActions;
  private readonly effectRunner: EffectRunner;
  private readonly pendingSendQueue = new Map<string, { text: string; localId?: string }[]>();
  private readonly pendingInterruptRequests = new Set<string>();
  private readonly backendReadyQueue: { sessionPath: string; text: string; localId?: string; queuedAt: number }[] = [];
  private backend: BackendLike | null = null;
  private archState: ArchState = initialArchState;

  constructor(private readonly options: HeadlessWebviewDevHostOptions) {
    this.context = createHeadlessContext(options.workspaceRoot);
    const backendAdapter: BackendLike = {
      request: <T = unknown>(method: string, params?: unknown, timeoutMs?: number) => {
        if (!this.backend) return Promise.reject(new Error('PI backend is not connected.'));
        return this.backend.request<T>(method, params, timeoutMs);
      },
    };
    const scheduleRender = () => undefined;

    this.state = new SessionServiceState(this.context, backendAdapter as any, scheduleRender);
    this.events = new SessionServiceEvents({
      context: this.context,
      scheduleRender,
      onSessionPathResolved: (pendingPath, resolvedPath) => {
        this.drainPendingSendQueue(pendingPath, resolvedPath);
        this.drainPendingInterrupt(pendingPath, resolvedPath);
      },
      runObserver: NOOP_RUN_OBSERVER,
      state: this.state,
    });
    this.tabs = new SessionTabActions({
      context: this.context,
      backend: backendAdapter as any,
      scheduleRender,
      runObserver: NOOP_RUN_OBSERVER,
      state: this.state,
    });
    this.messages = new SessionMessageActions({
      context: this.context,
      backend: backendAdapter as any,
      scheduleRender,
      postImperative: () => undefined,
      runObserver: NOOP_RUN_OBSERVER,
      state: this.state,
      createNewSession: () => this.tabs.createNewSession(),
      confirmModelSwitch: async () => true,
    });
    this.effectRunner = new EffectRunner({
      backend: backendAdapter,
      queues: {
        enqueueLifecycle: (task) => this.state.enqueueLifecycle(task),
        enqueueSessionOperation: (sessionPath, task) => this.state.enqueueSessionOperation(sessionPath, task),
      },
      tabs: { persistTabs: async () => undefined },
      log: { log: (level, message, data) => level === 'error' ? console.error('[arch]', message, data) : undefined },
      sync: { execute: (effect) => this.executeSyncEffect(effect) },
      dispatch: (event) => this.dispatchArchEvent(event),
    });
    this.events.setArchDispatch((event) => this.dispatchArchEvent(event));

    store.dispatch(sessionsActions.setWorkspaceCwd(options.workspaceRoot));
    store.dispatch(uiActions.setPrefs(options.initialPrefs));
    store.dispatch(uiActions.setAvailableExtensions(options.knownExtensions));
    store.dispatch(settingsActions.setPruningSettings(options.initialPruningSettings));
    store.dispatch(uiActions.setNotice('Starting PI backend...'));
  }

  connectBackend(backend: BackendLike): void {
    this.backend = backend;
  }

  viewState(): ViewState {
    return selectViewState(store.getState());
  }

  activeSessionPath(): string | null {
    return selectActiveSessionPath(store.getState());
  }

  setBackendReady(ready: boolean): void {
    store.dispatch(uiActions.setBackendReady(ready));
    if (ready) this.drainBackendReadyQueue();
  }

  setNotice(notice: string | null): void {
    store.dispatch(uiActions.setNotice(notice));
  }

  setModelSettings(settings: ModelSettings): void {
    store.dispatch(settingsActions.setModelSettings(settings));
  }

  setSessions(sessions: SessionSummary[]): void {
    store.dispatch(sessionsActions.replaceSessionSummaries(sessions));
  }

  createPendingSession(): PendingSessionRequest {
    const pendingPath = this.tabs.createNewSession();
    return { pendingPath, selectionToken: pendingPath };
  }

  createPendingDuplicate(sourceSessionPath: string): PendingSessionRequest | null {
    const before = new Set(store.getState().sessions.openTabPaths);
    this.tabs.duplicateSession(sourceSessionPath);
    const pendingPath = store.getState().sessions.openTabPaths.find((sessionPath) => !before.has(sessionPath) && isPendingTabPath(sessionPath));
    return pendingPath ? { pendingPath, selectionToken: pendingPath } : null;
  }

  openSessionRequested(sessionPath: string): string {
    this.tabs.openSession(sessionPath);
    return sessionPath;
  }

  closeSession(sessionPath: string): void {
    void this.closeSessionInternal(sessionPath);
  }

  moveSessionTab(sessionPath: string | undefined, fromIndex: number, toIndex: number): void {
    this.tabs.moveSessionTab(sessionPath, fromIndex, toIndex);
  }

  applySessionOpened(payload: SessionOpenedPayload): void {
    this.events.applySessionOpened(payload);
  }

  applyTranscriptPage(sessionPath: string, payload: TranscriptPagePayload): void {
    store.dispatch(transcriptActions.setTranscript({
      sessionPath,
      transcript: payload.transcript ?? [],
      transcriptWindow: payload.transcriptWindow,
    }));
  }

  setModels(sessionPath: string, models: ModelInfo[]): void {
    store.dispatch(settingsActions.setAvailableModels({ sessionPath, availableModels: models }));
  }

  setPrefs(prefs: Partial<ChatPrefs>): void {
    const current = store.getState().ui.prefs;
    const deepMerged: Partial<ChatPrefs> = {
      ...prefs,
      ...(prefs.extensionToggles && { extensionToggles: { ...current.extensionToggles, ...prefs.extensionToggles } }),
      ...(prefs.providerToggles && { providerToggles: { ...current.providerToggles, ...prefs.providerToggles } }),
    };
    const merged = resolveChatPrefs({ ...current, ...deepMerged });
    store.dispatch(uiActions.setPrefs(merged));
    if (merged.suppressCompletionNotifications) store.dispatch(sessionsActions.clearUnreadFinishedSessions());
    void this.context.globalState.update(PREFS_STORAGE_KEY, merged);
    void this.backend?.request('runtimePrefs.set', {
      providerToggles: merged.providerToggles,
      extensionToggles: merged.extensionToggles,
    }).catch(() => undefined);
  }

  setPruningSettings(settings: Partial<PruningSettings>): void {
    store.dispatch(settingsActions.setPruningSettings({
      ...store.getState().settings.pruningSettings,
      ...settings,
    }));
  }

  setEditingMessageId(messageId: string | null): void {
    store.dispatch(uiActions.setEditingMessageId(messageId));
  }

  setShowOutcomeDialog(show: boolean): void {
    store.dispatch(uiActions.setShowOutcomeDialog(show));
  }

  setModelSettingsForSession(sessionPath: string | undefined, defaultModel: string, defaultThinkingLevel: ModelSettings['defaultThinkingLevel']): void {
    const current = store.getState().settings.modelSettings;
    store.dispatch(settingsActions.setModelSettings({
      ...(current ?? {}),
      defaultModel,
      defaultThinkingLevel,
    } as ModelSettings));
    if (!sessionPath) return;
    const session = getSessionByPath(store.getState(), sessionPath);
    if (session) store.dispatch(sessionsActions.upsertSession({ ...session, modelId: defaultModel, thinkingLevel: defaultThinkingLevel }));
  }

  removeFileChange(sessionPath: string, filePath: string): void {
    store.dispatch(fileChangesActions.removeFileChange({ sessionPath, path: filePath }));
  }

  setOutcomeNotice(resolution: string, satisfaction: number): void {
    store.dispatch(uiActions.setShowOutcomeDialog(false));
    store.dispatch(uiActions.setNotice(`Recorded outcome: ${resolution}, satisfaction ${satisfaction}`));
  }

  addComposerInput(sessionPath: string, draft: ComposerInputDraft): void {
    void this.messages.addComposerInput(sessionPath, draft);
  }

  removeComposerInput(sessionPath: string, inputId: string): void {
    this.messages.removeComposerInput(sessionPath, inputId);
  }

  beginSend(sessionPath: string, text: string, localId?: string): unknown[] {
    void this.handleSend(sessionPath, text, localId);
    return [];
  }

  handleBackendEvent(event: EventEnvelope): void {
    if (event.event === 'backend.ready') return;
    this.events.handleBackendEvent(event);
  }

  async handleWebviewMessage(msg: WebviewToHostMessage): Promise<void> {
    switch (msg.type) {
      case 'ready':
      case 'requestSnapshot':
        return;
      case 'refreshState': {
        const activeSessionPath = this.activeSessionPath();
        if (activeSessionPath) await this.messages.hydrateModelState(activeSessionPath);
        return;
      }
      case 'newSession':
        this.tabs.createNewSession();
        return;
      case 'openSession':
        store.dispatch(uiActions.setEditingMessageId(null));
        store.dispatch(uiActions.setShowOutcomeDialog(false));
        this.tabs.openSession(msg.sessionPath);
        return;
      case 'closeSession':
        await this.closeSessionInternal(msg.sessionPath);
        return;
      case 'duplicateSession':
        this.tabs.duplicateSession(msg.sessionPath);
        return;
      case 'moveSessionTab':
        this.tabs.moveSessionTab(msg.sessionPath, msg.fromIndex, msg.toIndex);
        return;
      case 'send':
        await this.handleSend(msg.sessionPath, msg.text ?? '', msg.localId);
        return;
      case 'editMessage':
        await this.handleEditMessage(msg.sessionPath, msg.messageId, msg.text ?? '');
        return;
      case 'interrupt':
        this.handleInterrupt(msg.sessionPath);
        return;
      case 'openFilePicker': {
        const sessionPath = this.activeSessionPath();
        if (!sessionPath) return;
        const readmePath = path.join(this.options.workspaceRoot, 'README.md');
        await this.messages.addComposerInput(sessionPath, { kind: 'filesystemPathRef', path: readmePath, name: 'README.md', source: 'picker' });
        store.dispatch(uiActions.setNotice('Browser dev attached README.md. Drag, paste, or drop files to inspect other attachment states.'));
        return;
      }
      case 'addComposerInput':
        await this.messages.addComposerInput(msg.sessionPath, msg.input);
        return;
      case 'removeComposerInput':
        this.messages.removeComposerInput(msg.sessionPath, msg.inputId);
        return;
      case 'loadOlderTranscript':
        await this.messages.loadOlderTranscript(msg.sessionPath);
        return;
      case 'loadNewerTranscript':
        await this.messages.loadNewerTranscript(msg.sessionPath);
        return;
      case 'jumpToLatestTranscript':
        await this.messages.jumpToLatestTranscript(msg.sessionPath);
        return;
      case 'setModel':
        await this.messages.setModel(msg.sessionPath, msg.defaultModel, msg.defaultThinkingLevel as ThinkingLevel);
        return;
      case 'setPrefs':
        this.setPrefs(msg.prefs);
        return;
      case 'setPruningSettings':
        this.setPruningSettings(msg.settings);
        return;
      case 'startEdit':
        store.dispatch(uiActions.setEditingMessageId(msg.messageId));
        return;
      case 'cancelEdit':
        store.dispatch(uiActions.setEditingMessageId(null));
        return;
      case 'dismissNotice':
        store.dispatch(uiActions.setNotice(null));
        return;
      case 'openOutcomeDialog':
        store.dispatch(uiActions.setShowOutcomeDialog(true));
        return;
      case 'closeOutcomeDialog':
        store.dispatch(uiActions.setShowOutcomeDialog(false));
        return;
      case 'recordOutcome':
        this.setOutcomeNotice(msg.outcome.resolution, msg.outcome.satisfaction);
        return;
      case 'openFile':
        if (typeof msg.path === 'string') store.dispatch(uiActions.setNotice(`Browser dev would open ${msg.path}.`));
        return;
      case 'openFileDiff':
        store.dispatch(uiActions.setNotice(`Browser dev would open a diff for ${msg.filePath}.`));
        return;
      case 'revertFile':
        this.removeFileChange(msg.sessionPath, msg.filePath);
        store.dispatch(uiActions.setNotice(`Browser dev removed ${msg.filePath} from the file-change list.`));
        return;
      case 'startNewTask':
        store.dispatch(uiActions.setNotice('Browser dev marked the next send as a new task placeholder.'));
        return;
      case 'continueTask':
        store.dispatch(uiActions.setNotice('Browser dev would continue the current task in the installed extension.'));
        return;
      case 'extensionUiResponse':
        store.dispatch(uiActions.setPendingExtensionUIRequest(null));
        await this.backend?.request('extension_ui.response', { sessionPath: msg.sessionPath, response: msg.response });
        return;
      case 'stateApplied':
        return;
    }
  }

  private async closeSessionInternal(sessionPath: string): Promise<void> {
    await this.tabs.closeSession(sessionPath);
    this.dispatchArchEvent({ kind: 'SessionClosed', sessionPath });
    this.pendingSendQueue.delete(sessionPath);
    this.pendingInterruptRequests.delete(sessionPath);
    this.messages.dropSessionLocalState(sessionPath);
    store.dispatch(uiActions.setEditingMessageId(null));
    store.dispatch(uiActions.setShowOutcomeDialog(false));
    store.dispatch(uiActions.setPendingExtensionUIRequest(null));
  }

  private async handleSend(sessionPath: string | undefined, text: string, webviewLocalId?: string): Promise<void> {
    if (!sessionPath) {
      store.dispatch(uiActions.setNotice('Protocol defect: send arrived without a sessionPath.'));
      return;
    }
    if (isPendingTabPath(sessionPath)) {
      if (!text.trim()) return;
      const queue = this.pendingSendQueue.get(sessionPath) ?? [];
      const localId = webviewLocalId ?? `local:${Date.now()}:${Math.random().toString(36).slice(2)}`;
      queue.push({ text, localId });
      this.pendingSendQueue.set(sessionPath, queue);
      store.dispatch(transcriptActions.appendLocalUserMessage({ sessionPath, id: localId, text }));
      store.dispatch(sessionsActions.setSessionRunning({ sessionPath, running: true }));
      this.maybeApplyOptimisticSessionName(sessionPath, text);
      return;
    }
    if (!store.getState().ui.backendReady) {
      if (!text.trim()) return;
      const localId = webviewLocalId ?? `local:${Date.now()}:${Math.random().toString(36).slice(2)}`;
      this.backendReadyQueue.push({ sessionPath, text, localId, queuedAt: Date.now() });
      store.dispatch(transcriptActions.appendLocalUserMessage({ sessionPath, id: localId, text }));
      this.maybeApplyOptimisticSessionName(sessionPath, text);
      return;
    }
    if (!store.getState().sessions.openTabPaths.includes(sessionPath)) {
      store.dispatch(uiActions.setNotice('Cannot send: the selected session is no longer open.'));
      return;
    }
    const inputs = [...(store.getState().sessionState.pendingComposerInputsBySession[sessionPath] ?? [])];
    if (!text.trim() && inputs.length === 0) return;

    this.state.bumpSessionDataEpoch(sessionPath);
    const composedText = buildPromptText(text, inputs);
    const userParts = buildOptimisticUserParts(text, inputs);
    const localId = webviewLocalId ?? `local:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const previousSummary = this.maybeApplyOptimisticSessionName(sessionPath, composedText);
    this.dispatchArchEvent({
      kind: 'Command',
      cmd: { kind: 'Send', corrId: crypto.randomUUID(), sessionPath, text, inputs, composedText, localId, userParts, previousSummary },
    });
  }

  private async handleEditMessage(sessionPath: string | undefined, messageId: string | undefined, text: string): Promise<void> {
    if (!sessionPath) {
      store.dispatch(uiActions.setNotice('Protocol defect: editMessage arrived without a sessionPath.'));
      return;
    }
    if (!text.trim() || !messageId) return;
    if (isPendingTabPath(sessionPath)) {
      store.dispatch(uiActions.setNotice('Cannot edit: the session is still opening.'));
      return;
    }
    if (!store.getState().sessions.openTabPaths.includes(sessionPath)) {
      store.dispatch(uiActions.setNotice('Cannot edit: the selected session is no longer open.'));
      return;
    }
    this.state.bumpSessionDataEpoch(sessionPath);
    const localId = `local:edit:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    store.dispatch(uiActions.setEditingMessageId(null));
    this.dispatchArchEvent({
      kind: 'Command',
      cmd: { kind: 'Edit', corrId: crypto.randomUUID(), sessionPath, messageId, text, localId },
    });
  }

  private handleInterrupt(sessionPath: string | undefined): void {
    if (!sessionPath) {
      store.dispatch(uiActions.setNotice('Protocol defect: interrupt arrived without a sessionPath.'));
      return;
    }
    if (isPendingTabPath(sessionPath)) {
      this.pendingInterruptRequests.add(sessionPath);
      store.dispatch(sessionsActions.setSessionRunning({ sessionPath, running: false }));
      this.state.suppressNextCompletionNotificationFor(sessionPath);
      return;
    }
    this.dispatchArchEvent({
      kind: 'Command',
      cmd: { kind: 'Interrupt', corrId: crypto.randomUUID(), sessionPath },
    });
    this.state.suppressNextCompletionNotificationFor(sessionPath);
  }

  private drainPendingSendQueue(pendingPath: string, resolvedPath: string): void {
    const queued = this.pendingSendQueue.get(pendingPath) ?? [];
    this.pendingSendQueue.delete(pendingPath);
    for (const entry of queued) void this.handleSend(resolvedPath, entry.text, entry.localId);
  }

  private drainPendingInterrupt(pendingPath: string, resolvedPath: string): void {
    if (!this.pendingInterruptRequests.delete(pendingPath)) return;
    this.handleInterrupt(resolvedPath);
  }

  private drainBackendReadyQueue(): void {
    const queued = this.backendReadyQueue.splice(0);
    for (const entry of queued) void this.handleSend(entry.sessionPath, entry.text, entry.localId);
  }

  private maybeApplyOptimisticSessionName(sessionPath: string, text: string): SessionSummary | null {
    const session = getSessionByPath(store.getState(), sessionPath);
    if (!session || session.isPlaceholder !== true) return null;
    const derived = deriveSessionNameFromText(text);
    if (derived.isPlaceholder || derived.name === session.name) return null;
    store.dispatch(sessionsActions.upsertSession({ ...session, name: derived.name, isPlaceholder: false }));
    this.state.saveOpenTabs();
    return session;
  }

  private dispatchArchEvent(event: Event): void {
    if (event.kind === 'SendResult' && event.ok && event.requestId) {
      this.state.bindRequestSessionPath(event.requestId, event.sessionPath);
    }
    const result = reducer(this.archState, event);
    this.archState = result.state;
    for (const effect of result.effects) this.effectRunner.run(effect);
  }

  private executeSyncEffect(effect: SyncEffect): void {
    switch (effect.kind) {
      case 'InsertOptimisticMessage':
        store.dispatch(transcriptActions.appendLocalUserMessage({ sessionPath: effect.sessionPath, id: effect.localId, text: effect.text, userParts: effect.userParts }));
        store.dispatch(sessionsActions.setSessionRunning({ sessionPath: effect.sessionPath, running: true }));
        break;
      case 'RemoveOptimisticMessage':
        store.dispatch(transcriptActions.removeMessage({ sessionPath: effect.sessionPath, messageId: effect.localId }));
        store.dispatch(sessionsActions.setSessionRunning({ sessionPath: effect.sessionPath, running: false }));
        break;
      case 'ClearComposerInputs':
        store.dispatch(sessionStateActions.clearPendingComposerInputs(effect.sessionPath));
        break;
      case 'RestoreComposerInputs':
        store.dispatch(sessionStateActions.setPendingComposerInputs({
          sessionPath: effect.sessionPath,
          inputs: effect.inputs,
        }));
        break;
      case 'SetNotice':
        store.dispatch(uiActions.setNotice(effect.message));
        break;
      case 'PostImperative':
        break;
      case 'SetSessionName': {
        const current = getSessionByPath(store.getState(), effect.sessionPath);
        if (current) store.dispatch(sessionsActions.upsertSession({ ...current, name: effect.name, isPlaceholder: effect.isPlaceholder }));
        break;
      }
      case 'RestoreSessionSummary':
        store.dispatch(sessionsActions.setSessionSummary(effect.summary));
        break;
      case 'AppendDelta':
        store.dispatch(transcriptActions.appendDelta({ sessionPath: effect.sessionPath, messageId: effect.messageId, delta: effect.delta }));
        break;
      case 'AppendThinking':
        store.dispatch(transcriptActions.appendThinking({ sessionPath: effect.sessionPath, messageId: effect.messageId, thinking: effect.thinking }));
        break;
      case 'UpsertToolCall':
        store.dispatch(transcriptActions.upsertToolCall({ sessionPath: effect.sessionPath, messageId: effect.messageId, toolCall: effect.toolCall }));
        break;
      case 'UpsertMessage':
        store.dispatch(transcriptActions.upsertMessage({ sessionPath: effect.sessionPath, message: effect.message, canonicalMessageId: effect.canonicalMessageId }));
        break;
      case 'EnsureAssistantMessage':
        store.dispatch(transcriptActions.ensureAssistantMessage({ sessionPath: effect.sessionPath, messageId: effect.canonicalMessageId, isAlias: effect.isAlias, modelId: effect.modelId, thinkingLevel: effect.thinkingLevel }));
        break;
      case 'SetMessageStatus':
        store.dispatch(transcriptActions.setMessageStatus({ sessionPath: effect.sessionPath, messageId: effect.messageId, status: effect.status }));
        break;
      case 'SetSessionRunning':
        store.dispatch(sessionsActions.setSessionRunning({ sessionPath: effect.sessionPath, running: effect.running }));
        break;
      case 'ScheduleRender':
        break;
    }
  }
}