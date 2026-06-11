import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { produce } from 'immer';

import { EffectRunner } from '../host/core/effect-runner';
import type { Event } from '../host/core/events';
import { initialArchState, reducer, type ArchState } from '../host/core/reducer';
import { selectViewState } from '../host/core/projection';
import { NOOP_RUN_OBSERVER } from '../host/stats-service';
import { buildOptimisticUserParts, buildPromptText } from '../host/core/composer';
import { SessionServiceEvents } from '../host/session-service/events';
import { SessionMessageActions } from '../host/session-service/message-actions';
import { SessionServiceState } from '../host/session-service/state';
import { SessionTabActions } from '../host/session-service/tab-actions';
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

    this.state = new SessionServiceState(this.context, backendAdapter as any, scheduleRender, () => this.archState, (recipe) => { this.archState = produce(this.archState, recipe); });
    this.events = new SessionServiceEvents({
      context: this.context,
      scheduleRender,
      onSessionPathResolved: (pendingPath, resolvedPath) => {
        this.drainPendingSendQueue(pendingPath, resolvedPath);
        this.drainPendingInterrupt(pendingPath, resolvedPath);
      },
      runObserver: NOOP_RUN_OBSERVER,
      state: this.state,
      dispatchArch: (event) => this.dispatchArchEvent(event),
      getArchState: () => this.archState,
      mutateArchState: (recipe) => {
        this.archState = produce(this.archState, recipe);
      },
    });
    this.tabs = new SessionTabActions({
      context: this.context,
      backend: backendAdapter as any,
      scheduleRender,
      runObserver: NOOP_RUN_OBSERVER,
      state: this.state,
      getArchState: () => this.archState,
      mutateArchState: (recipe) => {
        this.archState = produce(this.archState, recipe);
      },
    });
    this.messages = new SessionMessageActions({
      context: this.context,
      backend: backendAdapter as any,
      scheduleRender,
      runObserver: NOOP_RUN_OBSERVER,
      state: this.state,
      createNewSession: () => this.tabs.createNewSession(),
      getArchState: () => this.archState,
      mutateArchState: (recipe) => {
        this.archState = produce(this.archState, recipe);
      },
    });
    this.effectRunner = new EffectRunner({
      backend: backendAdapter,
      queues: {
        enqueueLifecycle: (task) => this.state.enqueueLifecycle(task),
        enqueueSessionOperation: (sessionPath, task) => this.state.enqueueSessionOperation(sessionPath, task),
      },
      tabs: { persistTabs: async () => undefined },
      log: { log: (level, message, data) => level === 'error' ? console.error('[arch]', message, data) : undefined },
      postImperative: { postImperative: () => undefined },
      dispatch: (event) => this.dispatchArchEvent(event),
    });

    // Initialise archState with startup values.
    this.archState = produce(this.archState, draft => {
      draft.sessions.workspaceCwd = options.workspaceRoot;
      draft.settings.prefs = options.initialPrefs;
      draft.settings.availableExtensions = options.knownExtensions;
      draft.settings.pruningSettings = options.initialPruningSettings;
      draft.settings.notice = 'Starting PI backend...';
    });
  }

  connectBackend(backend: BackendLike): void {
    this.backend = backend;
  }

  viewState(): ViewState {
    return selectViewState(this.archState);
  }

  activeSessionPath(): string | null {
    return this.archState.sessions.activeSessionPath;
  }

  setBackendReady(ready: boolean): void {
    this.archState = produce(this.archState, draft => {
      draft.settings.backendReady = ready;
    });
    if (ready) this.drainBackendReadyQueue();
  }

  setNotice(notice: string | null): void {
    this.archState = produce(this.archState, draft => {
      draft.settings.notice = notice;
    });
  }

  setModelSettings(settings: ModelSettings): void {
    this.archState = produce(this.archState, draft => {
      draft.settings.modelSettings = settings;
    });
  }

  setSessions(sessions: SessionSummary[]): void {
    this.archState = produce(this.archState, draft => {
      // Preserve open-tab sessions not in the incoming list, and
      // preserve non-placeholder names over incoming placeholder names.
      const openTabs = new Set(draft.sessions.openTabPaths);
      const existingByName = new Map(
        draft.sessions.sessions
          .filter(s => s.isPlaceholder !== true)
          .map(s => [s.path, s.name]),
      );
      const merged: SessionSummary[] = [];
      const seen = new Set<string>();
      for (const s of sessions) {
        const prevName = existingByName.get(s.path);
        const entry = prevName && (s.isPlaceholder === true)
          ? { ...s, name: prevName, isPlaceholder: false }
          : s;
        merged.push(entry);
        seen.add(s.path);
      }
      // Preserve active and open-tab sessions not in the incoming list.
      for (const s of draft.sessions.sessions) {
        if (!seen.has(s.path) && (openTabs.has(s.path) || s.path === draft.sessions.activeSessionPath)) {
          merged.push(s);
        }
      }
      draft.sessions.sessions = merged;
    });
  }

  createPendingSession(): PendingSessionRequest {
    const pendingPath = this.tabs.createNewSession();
    return { pendingPath, selectionToken: pendingPath };
  }

  createPendingDuplicate(sourceSessionPath: string): PendingSessionRequest | null {
    const before = new Set(this.archState.sessions.openTabPaths);
    this.tabs.duplicateSession(sourceSessionPath);
    const pendingPath = this.archState.sessions.openTabPaths.find((sessionPath) => !before.has(sessionPath) && isPendingTabPath(sessionPath));
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
    this.archState = produce(this.archState, draft => {
      draft.transcript.bySession[sessionPath] = payload.transcript ?? [];
      if (payload.transcriptWindow) {
        draft.transcript.windowBySession[sessionPath] = payload.transcriptWindow;
      }
    });
  }

  setModels(sessionPath: string, models: ModelInfo[]): void {
    this.archState = produce(this.archState, draft => {
      draft.settings.availableModelsBySession[sessionPath] = models;
    });
  }

  setPrefs(prefs: Partial<ChatPrefs>): void {
    const current = this.archState.settings.prefs;
    const deepMerged: Partial<ChatPrefs> = {
      ...prefs,
      ...(prefs.extensionToggles && { extensionToggles: { ...current.extensionToggles, ...prefs.extensionToggles } }),
      ...(prefs.providerToggles && { providerToggles: { ...current.providerToggles, ...prefs.providerToggles } }),
    };
    const merged = resolveChatPrefs({ ...current, ...deepMerged });
    this.archState = produce(this.archState, draft => {
      draft.settings.prefs = merged;
    });
    if (merged.suppressCompletionNotifications) {
      this.archState = produce(this.archState, draft => {
        draft.sessions.unreadFinishedSessionPaths = [];
      });
    }
    void this.context.globalState.update(PREFS_STORAGE_KEY, merged);
    void this.backend?.request('runtimePrefs.set', {
      providerToggles: merged.providerToggles,
      extensionToggles: merged.extensionToggles,
    }).catch(() => undefined);
  }

  setPruningSettings(settings: Partial<PruningSettings>): void {
    this.archState = produce(this.archState, draft => {
      draft.settings.pruningSettings = {
        ...draft.settings.pruningSettings,
        ...settings,
      };
    });
  }

  setEditingMessageId(messageId: string | null): void {
    this.archState = produce(this.archState, draft => {
      draft.transcript.editingMessageId = messageId;
    });
  }

  setShowOutcomeDialog(show: boolean): void {
    this.archState = produce(this.archState, draft => {
      draft.settings.showOutcomeDialog = show;
    });
  }

  setModelSettingsForSession(sessionPath: string | undefined, defaultModel: string, defaultThinkingLevel: ModelSettings['defaultThinkingLevel']): void {
    const current = this.archState.settings.modelSettings;
    this.archState = produce(this.archState, draft => {
      draft.settings.modelSettings = {
        ...(current ?? {}),
        defaultModel,
        defaultThinkingLevel,
      } as ModelSettings;
    });
    if (!sessionPath) return;
    const session = this.archState.sessions.sessions.find(s => s.path === sessionPath);
    if (session) {
      this.archState = produce(this.archState, draft => {
        const s = draft.sessions.sessions.find(x => x.path === sessionPath);
        if (s) {
          s.modelId = defaultModel;
          s.thinkingLevel = defaultThinkingLevel;
        }
      });
    }
  }

  removeFileChange(sessionPath: string, filePath: string): void {
    this.archState = produce(this.archState, draft => {
      const changes = draft.fileChanges.bySession[sessionPath];
      if (changes) {
        draft.fileChanges.bySession[sessionPath] = changes.filter(c => c.path !== filePath);
      }
    });
  }

  setOutcomeNotice(resolution: string, satisfaction: number): void {
    this.archState = produce(this.archState, draft => {
      draft.settings.showOutcomeDialog = false;
      draft.settings.notice = `Recorded outcome: ${resolution}, satisfaction ${satisfaction}`;
    });
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
        const sessionPath = this.activeSessionPath();
        if (sessionPath) await this.messages.hydrateModelState(sessionPath);
        return;
      }
      case 'newSession':
        this.tabs.createNewSession();
        return;
      case 'openSession':
        this.archState = produce(this.archState, draft => {
          draft.transcript.editingMessageId = null;
          draft.settings.showOutcomeDialog = false;
        });
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
        this.archState = produce(this.archState, draft => {
          draft.settings.notice = 'Browser dev attached README.md. Drag, paste, or drop files to inspect other attachment states.';
        });
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
        this.archState = produce(this.archState, draft => {
          draft.transcript.editingMessageId = msg.messageId;
        });
        return;
      case 'cancelEdit':
        this.archState = produce(this.archState, draft => {
          draft.transcript.editingMessageId = null;
        });
        return;
      case 'dismissNotice':
        this.archState = produce(this.archState, draft => {
          draft.settings.notice = null;
        });
        return;
      case 'openOutcomeDialog':
        this.archState = produce(this.archState, draft => {
          draft.settings.showOutcomeDialog = true;
        });
        return;
      case 'closeOutcomeDialog':
        this.archState = produce(this.archState, draft => {
          draft.settings.showOutcomeDialog = false;
        });
        return;
      case 'recordOutcome':
        this.setOutcomeNotice(msg.outcome.resolution, msg.outcome.satisfaction);
        return;
      case 'openFile':
        if (typeof msg.path === 'string') {
          this.archState = produce(this.archState, draft => {
            draft.settings.notice = `Browser dev would open ${msg.path}.`;
          });
        }
        return;
      case 'openFileDiff':
        this.archState = produce(this.archState, draft => {
          draft.settings.notice = `Browser dev would open a diff for ${msg.filePath}.`;
        });
        return;
      case 'revertFile':
        this.removeFileChange(msg.sessionPath, msg.filePath);
        this.archState = produce(this.archState, draft => {
          draft.settings.notice = `Browser dev removed ${msg.filePath} from the file-change list.`;
        });
        return;
      case 'startNewTask':
        this.archState = produce(this.archState, draft => {
          draft.settings.notice = 'Browser dev marked the next send as a new task placeholder.';
        });
        return;
      case 'continueTask':
        this.archState = produce(this.archState, draft => {
          draft.settings.notice = 'Browser dev would continue the current task in the installed extension.';
        });
        return;
      case 'extensionUiResponse':
        this.archState = produce(this.archState, draft => {
          delete draft.settings.pendingExtensionUIRequestsBySession[msg.sessionPath];
        });
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
    this.archState = produce(this.archState, draft => {
      draft.transcript.editingMessageId = null;
      draft.settings.showOutcomeDialog = false;
      delete draft.settings.pendingExtensionUIRequestsBySession[sessionPath];
    });
  }

  private async handleSend(sessionPath: string | undefined, text: string, webviewLocalId?: string): Promise<void> {
    if (!sessionPath) {
      this.archState = produce(this.archState, draft => {
        draft.settings.notice = 'Protocol defect: send arrived without a sessionPath.';
      });
      return;
    }
    if (isPendingTabPath(sessionPath)) {
      if (!text.trim()) return;
      const queue = this.pendingSendQueue.get(sessionPath) ?? [];
      const localId = webviewLocalId ?? `local:${Date.now()}:${Math.random().toString(36).slice(2)}`;
      queue.push({ text, localId });
      this.pendingSendQueue.set(sessionPath, queue);
      this.archState = produce(this.archState, draft => {
        if (!draft.transcript.bySession[sessionPath]) {
          draft.transcript.bySession[sessionPath] = [];
        }
        draft.transcript.bySession[sessionPath]!.push({
          id: localId,
          role: 'user' as const,
          createdAt: new Date().toISOString(),
          markdown: text,
          status: 'completed' as const,
        });
        if (!draft.sessions.runningSessionPaths.includes(sessionPath)) {
          draft.sessions.runningSessionPaths.push(sessionPath);
        }
      });
      this.maybeApplyOptimisticSessionName(sessionPath, text);
      return;
    }
    if (!this.archState.settings.backendReady) {
      if (!text.trim()) return;
      const localId = webviewLocalId ?? `local:${Date.now()}:${Math.random().toString(36).slice(2)}`;
      this.backendReadyQueue.push({ sessionPath, text, localId, queuedAt: Date.now() });
      this.archState = produce(this.archState, draft => {
        if (!draft.transcript.bySession[sessionPath]) {
          draft.transcript.bySession[sessionPath] = [];
        }
        draft.transcript.bySession[sessionPath]!.push({
          id: localId,
          role: 'user' as const,
          createdAt: new Date().toISOString(),
          markdown: text,
          status: 'completed' as const,
        });
      });
      this.maybeApplyOptimisticSessionName(sessionPath, text);
      return;
    }
    if (!this.archState.sessions.openTabPaths.includes(sessionPath)) {
      this.archState = produce(this.archState, draft => {
        draft.settings.notice = 'Cannot send: the selected session is no longer open.';
      });
      return;
    }
    const inputs = [...(this.archState.composer.pendingComposerInputsBySession[sessionPath] ?? [])];
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
      this.archState = produce(this.archState, draft => {
        draft.settings.notice = 'Protocol defect: editMessage arrived without a sessionPath.';
      });
      return;
    }
    if (!text.trim() || !messageId) return;
    if (isPendingTabPath(sessionPath)) {
      this.archState = produce(this.archState, draft => {
        draft.settings.notice = 'Cannot edit: the session is still opening.';
      });
      return;
    }
    if (!this.archState.sessions.openTabPaths.includes(sessionPath)) {
      this.archState = produce(this.archState, draft => {
        draft.settings.notice = 'Cannot edit: the selected session is no longer open.';
      });
      return;
    }
    this.state.bumpSessionDataEpoch(sessionPath);
    const localId = `local:edit:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    this.archState = produce(this.archState, draft => {
      draft.transcript.editingMessageId = null;
    });
    this.dispatchArchEvent({
      kind: 'Command',
      cmd: { kind: 'Edit', corrId: crypto.randomUUID(), sessionPath, messageId, text, localId },
    });
  }

  private handleInterrupt(sessionPath: string | undefined): void {
    if (!sessionPath) {
      this.archState = produce(this.archState, draft => {
        draft.settings.notice = 'Protocol defect: interrupt arrived without a sessionPath.';
      });
      return;
    }
    if (isPendingTabPath(sessionPath)) {
      this.pendingInterruptRequests.add(sessionPath);
      this.archState = produce(this.archState, draft => {
        draft.sessions.runningSessionPaths = draft.sessions.runningSessionPaths.filter(p => p !== sessionPath);
      });
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
    const session = this.archState.sessions.sessions.find(s => s.path === sessionPath) ?? null;
    if (!session || session.isPlaceholder !== true) return null;
    const derived = deriveSessionNameFromText(text);
    if (derived.isPlaceholder || derived.name === session.name) return null;
    this.archState = produce(this.archState, draft => {
      const s = draft.sessions.sessions.find(x => x.path === sessionPath);
      if (s) {
        s.name = derived.name;
        s.isPlaceholder = false;
      }
    });
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
}
