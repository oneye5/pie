import * as path from 'node:path';

import * as vscode from 'vscode';

import { BackendClient } from './backend-client';
import { buildRestoredSessionPlan } from './restored-session-plan';
import {
  shouldFlashFinishedTab,
  type SessionCompletionEvent,
} from './completion-notification';
import { assertInvariant, auditLog } from './state-audit';
import { resolveSessionOpenedTranscript } from './session-opened-transcript';
import {
  getSessionByPath,
  sessionsActions,
  selectActiveSessionPath,
  settingsActions,
  sessionStateActions,
  transcriptActions,
  uiActions,
  store,
  getCanonicalMessageId,
} from './store';
import {
  normalizeStoredOpenTabPaths,
  PENDING_SESSION_PREFIX,
  getNextVisibleTabPathOnClose,
  isPendingTabPath,
} from '../shared/tab-behavior';
import { NOOP_RUN_OBSERVER, type RunObserver } from './stats-service';
import { deriveSessionNameFromText } from '../shared/session-name';
import { resolveNodePath, resolveSdkPath } from '../shared/runtime-resolution';
import { createCommandExecutor } from '../shared/exec-command';
import { resolveChatPrefs } from '../shared/protocol';
import type {
  BusyChangedPayload,
  ChatPrefs,
  ComposerInput,
  ComposerInputDraft,
  ContextUsageChangedPayload,
  ErrorPayload,
  EventEnvelope,
  HostToWebviewMessage,
  MessageAbortedPayload,
  MessageDeltaPayload,
  MessageFinishedPayload,
  MessageStartedPayload,
  MessageThinkingPayload,
  ModelInfo,
  ModelSettings,
  PatchOp,
  SessionListChangedPayload,
  SessionOpenedPayload,
  SessionSummary,
  ThinkingLevel,
  ToolFinishedPayload,
  ToolProgressPayload,
  ToolStartedPayload,
  UserContentPart,
} from '../shared/protocol';

const OPEN_TABS_STORAGE_KEY = 'openTabPaths';
const ACTIVE_SESSION_STORAGE_KEY = 'activeSessionPath';
const PREFS_STORAGE_KEY = 'chatPrefs';
const SDK_PATH_CACHE_KEY = 'resolvedSdkPath';
const MAX_IMAGE_INPUT_BYTES = 10 * 1024 * 1024;
const ALLOWED_IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/gif',
]);

type ScheduleRender = () => void;
type PostPatch = (op: PatchOp) => void;
type PostImperative = (message: HostToWebviewMessage) => void;
type OnSessionCompleted = (event: SessionCompletionEvent) => void;

type SelectionRequest = {
  token: string;
  requestedPath: string;
  pendingPath?: string;
  insertedPlaceholder: boolean;
  previousActivePath: string | null;
  wasOpenTab: boolean;
};

/**
 * Owns the PI backend process lifecycle and wires backend events to the Redux
 * store. All session commands (create, open, close, send, interrupt, etc.) go
 * through this service.
 */
export class SessionService implements vscode.Disposable {
  private eventDisposable?: vscode.Disposable;
  private exitDisposable?: vscode.Disposable;

  /** Per-session monotonic sequence numbers for `busy.changed` dedup. */
  private busySeqMap = new Map<string, number>();

  private lifecycleQueue = Promise.resolve();
  private readonly sessionOperationQueues = new Map<string, Promise<void>>();
  private readonly selectionRequests = new Map<string, SelectionRequest>();
  private readonly sessionDataEpochs = new Map<string, number>();
  private readonly preloadingSessionPaths = new Set<string>();
  private readonly suppressNextCompletionNotification = new Set<string>();
  private readonly requestSessionPathById = new Map<string, string>();
  private pendingSessionCounter = 0;
  private composerInputCounter = 0;
  private selectionRequestCounter = 0;
  private currentSelectionToken: string | null = null;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly backend: BackendClient,
    private readonly scheduleRender: ScheduleRender,
    private readonly postPatch: PostPatch,
    private readonly postImperative: PostImperative,
    private readonly onSessionCompleted?: OnSessionCompleted,
    private readonly runObserver: RunObserver = NOOP_RUN_OBSERVER,
  ) {}

  async start(): Promise<void> {
    await this.startBackend();
  }

  async restart(): Promise<void> {
    this.detachEvents();
    await this.backend.stop();
    this.busySeqMap.clear();
    this.sessionOperationQueues.clear();
    this.selectionRequests.clear();
    this.sessionDataEpochs.clear();
    this.preloadingSessionPaths.clear();
    this.suppressNextCompletionNotification.clear();
    this.requestSessionPathById.clear();
    this.currentSelectionToken = null;
    store.dispatch(sessionsActions.clearRunningPaths());
    store.dispatch(uiActions.setBackendReady(false));
    store.dispatch(uiActions.setNotice(null));
    this.scheduleRender();
    await this.startBackend();
  }

  dispose(): void {
    this.detachEvents();
  }

  // ─── Session commands ────────────────────────────────────────────────────────

  /**
   * Optimistically insert a pending tab and request a new session from the
   * backend. The backend will emit `session.opened` which replaces the pending
   * tab with the real session path.
   */
  createNewSession(): string {
    const pendingPath = this.createPendingSessionPath();
    const cwd = store.getState().sessions.workspaceCwd ?? '';
    const selectionToken = this.beginSelectionRequest(pendingPath, pendingPath);

    auditLog(this.context, 'session-service', 'session.create.requested', {
      cwd,
      pendingPath,
      selectionToken,
    });

    store.dispatch(
      sessionsActions.upsertSession({
        path: pendingPath,
        name: 'New Session',
        cwd,
        modifiedAt: new Date().toISOString(),
        messageCount: 0,
        isPlaceholder: true,
      }),
    );
    store.dispatch(sessionsActions.ensureOpenTab(pendingPath));
    store.dispatch(sessionsActions.setActiveSessionPath(pendingPath));
    this.saveOpenTabs();
    this.scheduleRender();

    void this.enqueueLifecycle(async () => {
      try {
        await this.backend.request<{ requestId?: string }>('session.create', {
          cwd,
          selectionToken,
        });
      } catch (err) {
        this.handleSelectionFailure(
          selectionToken,
          `Failed to create session: ${(err as Error).message}`,
        );
      }
    });

    return pendingPath;
  }

  openSession(sessionPath: string): void {
    const existing = getSessionByPath(store.getState(), sessionPath);
    const wasOpenTab = store.getState().sessions.openTabPaths.includes(sessionPath);
    this.bumpSessionDataEpoch(sessionPath);
    const selectionToken = this.beginSelectionRequest(
      sessionPath,
      undefined,
      wasOpenTab,
      !existing,
    );

    auditLog(this.context, 'session-service', 'session.open.requested', {
      selectionToken,
      sessionPath,
    });

    // Optimistically select the tab immediately so the UI responds without waiting
    // for the backend round-trip. The session.opened event will refresh with full data.
    if (!existing) {
      store.dispatch(
        sessionsActions.upsertSession({
          path: sessionPath,
          name: 'Loading...',
          isPlaceholder: true,
          cwd: store.getState().sessions.workspaceCwd ?? '',
          modifiedAt: new Date().toISOString(),
          messageCount: 0,
        }),
      );
    }
    store.dispatch(sessionsActions.setActiveSessionPath(sessionPath));
    store.dispatch(sessionsActions.ensureOpenTab(sessionPath));
    this.saveOpenTabs();
    this.scheduleRender();

    void this.enqueueLifecycle(async () => {
      try {
        await this.backend.request('session.open', { sessionPath, selectionToken });
      } catch (err) {
        this.handleSelectionFailure(
          selectionToken,
          `Failed to open session: ${(err as Error).message}`,
        );
      }
    });
  }

  async closeSession(sessionPath: string): Promise<void> {
    const state = store.getState();
    const nextPath = getNextVisibleTabPathOnClose({
      closingPath: sessionPath,
      openTabPaths: state.sessions.openTabPaths,
      sessions: state.sessions.sessions,
      workspaceCwd: state.sessions.workspaceCwd,
      activeSessionPath: state.sessions.activeSessionPath,
    });

    auditLog(this.context, 'session-service', 'session.close.requested', {
      nextPath,
      sessionPath,
    });

    this.clearSelectionRequestsForPath(sessionPath);

    // Optimistically remove the tab so the UI updates immediately.
    this.runObserver.onSessionClosed(sessionPath);
    store.dispatch(sessionsActions.removeOpenTab(sessionPath));
    this.clearSessionScope(sessionPath);
    this.saveOpenTabs();

    // If the closed tab was active, select the next visible tab immediately
    // and start opening it in the background. The heavy work of requesting
    // the session from the backend runs non-blockingly so the UI stays
    // responsive.
    if (state.sessions.activeSessionPath === sessionPath) {
      if (nextPath) {
        if (isPendingTabPath(nextPath)) {
          store.dispatch(sessionsActions.setActiveSessionPath(nextPath));
        } else {
          const existing = getSessionByPath(state, nextPath);
          if (existing) {
            store.dispatch(sessionsActions.setActiveSessionPath(existing.path));
          } else {
            // Create a lightweight placeholder so the view has something to render
            // for the newly active tab while we fetch the canonical session.
            const placeholder: SessionSummary = {
              path: nextPath,
              name: 'Loading...',
              isPlaceholder: true,
              cwd: state.sessions.workspaceCwd ?? '',
              modifiedAt: new Date().toISOString(),
              messageCount: 0,
            };
            store.dispatch(sessionsActions.upsertSession(placeholder));
            store.dispatch(sessionsActions.setActiveSessionPath(placeholder.path));
          }

          // Fire-and-forget the open; openSession already handles its own errors.
          void this.openSession(nextPath);
        }
      } else {
        store.dispatch(sessionsActions.clearActiveSession());
      }
    }

    // Always re-render — the tab removal must be reflected regardless of
    // whether the closed tab was active.
    this.assertSelectionInvariant('closeSession');
    this.scheduleRender();
  }

  moveSessionTab(sessionPath: string | undefined, fromIndex: number, toIndex: number): void {
    auditLog(this.context, 'session-service', 'session.tab.reorder.requested', {
      sessionPath,
      fromIndex,
      toIndex,
    });

    store.dispatch(sessionsActions.moveOpenTab({ sessionPath, fromIndex, toIndex }));
    this.saveOpenTabs();
    this.assertSelectionInvariant('moveSessionTab');
    this.scheduleRender();
  }

  async addFilesystemPaths(
    requestedSessionPath: string | undefined,
    paths: string[],
    source: 'picker' | 'drop',
  ): Promise<void> {
    const sessionPath = this.resolveComposerTargetSessionPath(requestedSessionPath);
    const uniquePaths = [...new Set(
      paths
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    )];
    if (!sessionPath || uniquePaths.length === 0) {
      return;
    }

    for (const filesystemPath of uniquePaths) {
      const input = this.validateAndMaterializeComposerInput(sessionPath, {
        kind: 'filesystemPathRef',
        path: filesystemPath,
        name: path.basename(filesystemPath) || filesystemPath,
        source,
      });
      if (!input) {
        continue;
      }
      this.upsertPendingComposerInput(sessionPath, input);
    }

    this.scheduleRender();
  }

  async addComposerInput(
    requestedSessionPath: string | undefined,
    inputDraft: ComposerInputDraft,
  ): Promise<void> {
    const sessionPath = this.resolveComposerTargetSessionPath(requestedSessionPath);
    if (!sessionPath) {
      return;
    }

    const input = this.validateAndMaterializeComposerInput(sessionPath, inputDraft);
    if (!input) {
      return;
    }

    this.upsertPendingComposerInput(sessionPath, input);
    this.scheduleRender();
  }

  removeComposerInput(requestedSessionPath: string | undefined, inputId: string): void {
    const sessionPath = this.resolveExistingComposerTargetSessionPath(requestedSessionPath);
    if (!sessionPath || !inputId.trim()) {
      return;
    }

    store.dispatch(sessionStateActions.removePendingComposerInput({
      sessionPath,
      inputId,
    }));
    this.scheduleRender();
  }

  async send(text: string): Promise<void> {
    const attemptedSessionPath = selectActiveSessionPath(store.getState()) ?? '__unknown__';
    const sessionPath = this.requireActiveOpenSessionPath('send');
    if (!sessionPath) {
      this.postImperative({ type: 'sendRejected', sessionPath: attemptedSessionPath, text });
      return;
    }

    const inputs = [
      ...(store.getState().sessionState.pendingComposerInputsBySession[sessionPath] ?? []),
    ];
    if (!text.trim() && inputs.length === 0) {
      return;
    }

    this.runObserver.prepareForSend(sessionPath, inputs);

    const composedText = this.buildPromptText(text, inputs);
    const optimisticUserParts = this.buildOptimisticUserParts(text, inputs);

    auditLog(this.context, 'session-service', 'message.send.requested', {
      attachedInputCount: inputs.length,
      attachedPathCount: inputs.filter((input) => input.kind === 'filesystemPathRef').length,
      attachedImageCount: inputs.filter((input) => input.kind === 'imageBlob').length,
      sessionPath,
      textLength: text.length,
    });

    const previousSummary = this.maybeApplyOptimisticSessionName(sessionPath, composedText);

    // Optimistically append the user message so the UI updates immediately.
    const localId = `local:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    store.dispatch(
      transcriptActions.appendLocalUserMessage({
        sessionPath,
        id: localId,
        text: composedText,
        userParts: optimisticUserParts,
      }),
    );
    this.scheduleRender();

    try {
      await this.enqueueLifecycle(async () => {
        await this.enqueueSessionOperation(sessionPath, async () => {
          const response = await this.backend.request<{ requestId?: string }>('message.send', {
            sessionPath,
            text,
            inputs,
          });
          if (response.requestId) {
            this.requestSessionPathById.set(response.requestId, sessionPath);
          }
        });
      });
      store.dispatch(sessionStateActions.clearPendingComposerInputs(sessionPath));
      this.scheduleRender();
    } catch (err) {
      this.runObserver.onBackendError(sessionPath, 'MESSAGE_SEND_FAILED');
      store.dispatch(transcriptActions.removeMessage({ sessionPath, messageId: localId }));
      if (previousSummary) {
        store.dispatch(sessionsActions.setSessionSummary(previousSummary));
        this.saveOpenTabs();
      }
      this.postImperative({ type: 'sendRejected', sessionPath, text });
      store.dispatch(
        uiActions.setNotice(`Failed to send message: ${(err as Error).message}`),
      );
      this.scheduleRender();
    }
  }

  async editMessage(messageId: string, text: string): Promise<void> {
    const sessionPath = this.requireActiveOpenSessionPath('edit');
    if (!sessionPath) return;

    let localId: string | null = null;

    auditLog(this.context, 'session-service', 'message.edit.requested', {
      messageId,
      sessionPath,
      textLength: text.length,
    });

    try {
      await this.enqueueLifecycle(async () => {
        await this.enqueueSessionOperation(sessionPath, async () => {
          await this.backend.request('session.truncateAfter', {
            sessionPath,
            entryId: messageId,
          });
          this.runObserver.onTruncatedAfter(sessionPath, messageId);
          this.runObserver.onMessageEdited(sessionPath, messageId);

          // Keep the edited prompt visible after the truncate snapshot removes the
          // original row and before agent_end emits the authoritative transcript.
          localId = `local:edit:${Date.now()}:${Math.random().toString(36).slice(2)}`;
          store.dispatch(
            transcriptActions.appendLocalUserMessage({
              sessionPath,
              id: localId,
              text,
            }),
          );
          this.scheduleRender();

          this.runObserver.prepareForSend(sessionPath, []);
          const response = await this.backend.request<{ requestId?: string }>('message.send', {
            sessionPath,
            text,
          });
          if (response.requestId) {
            this.requestSessionPathById.set(response.requestId, sessionPath);
          }
        });
      });
    } catch (err) {
      if (localId) {
        store.dispatch(transcriptActions.removeMessage({ sessionPath, messageId: localId }));
      }
      this.runObserver.onBackendError(sessionPath, 'MESSAGE_EDIT_FAILED');
      store.dispatch(
        uiActions.setNotice(`Failed to edit message: ${(err as Error).message}`),
      );
      this.scheduleRender();
    }
  }

  async interrupt(): Promise<void> {
    const activeSessionPath = this.requireActiveOpenSessionPath('interrupt');
    if (!activeSessionPath) return;

    auditLog(this.context, 'session-service', 'message.interrupt.requested', {
      sessionPath: activeSessionPath,
    });

    try {
      await this.enqueueLifecycle(async () => {
        await this.enqueueSessionOperation(activeSessionPath, async () => {
          await this.backend.request('message.interrupt', {
            sessionPath: activeSessionPath,
          });
        });
      });
      this.suppressNextCompletionNotification.add(activeSessionPath);
    } catch (err) {
      store.dispatch(
        uiActions.setNotice(`Failed to interrupt: ${(err as Error).message}`),
      );
      this.scheduleRender();
    }
  }

  async setModel(
    requestedSessionPath: string | undefined,
    defaultModel: string,
    defaultThinkingLevel: ThinkingLevel,
  ): Promise<void> {
    const sessionPath = this.requireOpenSessionPath('set model', requestedSessionPath);
    if (!sessionPath) return;

    const pendingInputs = store.getState().sessionState.pendingComposerInputsBySession[sessionPath] ?? [];
    const hasPendingImageInputs = pendingInputs.some((input) => input.kind === 'imageBlob');
    const requestedModelSupportsImages = this.modelSupportsInputKind(sessionPath, defaultModel, 'image');
    const shouldClearPendingImages = hasPendingImageInputs && requestedModelSupportsImages === false;

    if (shouldClearPendingImages) {
      const choice = await vscode.window.showWarningMessage(
        'Switching to this model will remove pending pasted images because it does not support image inputs.',
        { modal: true },
        'Switch Model',
      );
      if (choice !== 'Switch Model') {
        return;
      }
    }

    try {
      await this.enqueueLifecycle(async () => {
        const result = await this.backend.request<ModelSettings>('settings.set', {
          sessionPath,
          defaultModel,
          defaultThinkingLevel,
        });
        store.dispatch(settingsActions.setModelSettings(result));
        store.dispatch(settingsActions.clearContextUsage(sessionPath));
        this.bumpSessionDataEpoch(sessionPath);

        const session = getSessionByPath(store.getState(), sessionPath);
        if (session) {
          store.dispatch(sessionsActions.upsertSession({
            ...session,
            modelId: defaultModel,
            thinkingLevel: defaultThinkingLevel,
          }));
        }

        if (shouldClearPendingImages) {
          this.clearPendingImageInputs(sessionPath);
        }

        this.runObserver.onModelConfigChanged(sessionPath, defaultModel, defaultThinkingLevel);
        this.scheduleRender();
      });
    } catch (err) {
      store.dispatch(
        uiActions.setNotice(`Failed to set model: ${(err as Error).message}`),
      );
      this.scheduleRender();
    }
  }

  async hydrateModelState(sessionPath: string): Promise<void> {
    try {
      const [modelSettings, models] = await Promise.all([
        this.backend.request<ModelSettings>('settings.get'),
        this.backend.request<ModelInfo[]>('models.list', { sessionPath }),
      ]);
      store.dispatch(
        settingsActions.setModelAndAvailable({
          sessionPath,
          modelSettings,
          availableModels: models,
        }),
      );
      this.scheduleRender();
    } catch {
      // Non-fatal: model hydration failure does not break the extension.
    }
  }

  /** Returns URIs with `file` scheme only; others are silently dropped. */
  normalizeAttachUris(uris: vscode.Uri[]): vscode.Uri[] {
    return uris.filter((u) => u.scheme === 'file');
  }

  private upsertPendingComposerInput(sessionPath: string, input: ComposerInput): void {
    const existingInputs = store.getState().sessionState.pendingComposerInputsBySession[sessionPath] ?? [];
    if (input.kind === 'filesystemPathRef') {
      const duplicate = existingInputs.some(
        (existing) => existing.kind === 'filesystemPathRef' && existing.path === input.path,
      );
      if (duplicate) {
        return;
      }
    }

    store.dispatch(sessionStateActions.addPendingComposerInput({ sessionPath, input }));
  }

  private validateAndMaterializeComposerInput(
    sessionPath: string,
    inputDraft: ComposerInputDraft,
  ): ComposerInput | null {
    if (inputDraft.kind === 'filesystemPathRef') {
      const filesystemPath = inputDraft.path.trim();
      if (!filesystemPath) {
        store.dispatch(uiActions.setNotice('Cannot attach file path: path is empty.'));
        this.scheduleRender();
        return null;
      }

      return {
        id: this.createComposerInputId(),
        kind: 'filesystemPathRef',
        path: filesystemPath,
        name: inputDraft.name.trim() || path.basename(filesystemPath) || filesystemPath,
        source: inputDraft.source,
      };
    }

    if (inputDraft.kind === 'imageBlob') {
      const mimeType = inputDraft.mimeType.trim().toLowerCase();
      if (!ALLOWED_IMAGE_MIME_TYPES.has(mimeType)) {
        store.dispatch(uiActions.setNotice(`Cannot attach image: unsupported type ${inputDraft.mimeType}.`));
        this.scheduleRender();
        return null;
      }
      if (!Number.isFinite(inputDraft.sizeBytes) || inputDraft.sizeBytes <= 0) {
        store.dispatch(uiActions.setNotice('Cannot attach image: invalid size.'));
        this.scheduleRender();
        return null;
      }
      if (inputDraft.sizeBytes > MAX_IMAGE_INPUT_BYTES) {
        store.dispatch(uiActions.setNotice(
          `Cannot attach image: exceeds the ${MAX_IMAGE_INPUT_BYTES} byte limit.`,
        ));
        this.scheduleRender();
        return null;
      }
      if (!inputDraft.dataBase64.trim()) {
        store.dispatch(uiActions.setNotice('Cannot attach image: missing image data.'));
        this.scheduleRender();
        return null;
      }
      if (
        inputDraft.width !== undefined
        && (!Number.isFinite(inputDraft.width) || inputDraft.width <= 0)
      ) {
        store.dispatch(uiActions.setNotice('Cannot attach image: invalid width.'));
        this.scheduleRender();
        return null;
      }
      if (
        inputDraft.height !== undefined
        && (!Number.isFinite(inputDraft.height) || inputDraft.height <= 0)
      ) {
        store.dispatch(uiActions.setNotice('Cannot attach image: invalid height.'));
        this.scheduleRender();
        return null;
      }
      if (this.modelSupportsInputKind(sessionPath, undefined, 'image') === false) {
        store.dispatch(uiActions.setNotice('The selected model does not support image inputs.'));
        this.scheduleRender();
        return null;
      }

      return {
        id: this.createComposerInputId(),
        kind: 'imageBlob',
        mimeType,
        name: inputDraft.name.trim() || 'image',
        sizeBytes: inputDraft.sizeBytes,
        dataBase64: inputDraft.dataBase64,
        width: inputDraft.width,
        height: inputDraft.height,
        source: inputDraft.source,
      };
    }

    this.runObserver.onUnsupportedInputAttempt(sessionPath);
    store.dispatch(
      uiActions.setNotice(
        'Arbitrary pasted file attachments are not supported yet. Please attach a filesystem path instead.',
      ),
    );
    this.scheduleRender();
    return null;
  }

  setPrefs(prefs: Partial<ChatPrefs>): void {
    const merged = resolveChatPrefs({ ...store.getState().ui.prefs, ...prefs });
    store.dispatch(uiActions.setPrefs(merged));
    if (merged.suppressCompletionNotifications) {
      store.dispatch(sessionsActions.clearUnreadFinishedSessions());
    }
    void this.context.globalState.update(PREFS_STORAGE_KEY, merged);
    // Intentionally no scheduleRender() here — the caller posts a snapshot immediately.
  }

  // ─── Backend startup ─────────────────────────────────────────────────────────

  private async startBackend(): Promise<void> {
    this.busySeqMap.clear();
    this.sessionOperationQueues.clear();
    this.selectionRequests.clear();
    this.sessionDataEpochs.clear();
    this.preloadingSessionPaths.clear();
    this.suppressNextCompletionNotification.clear();
    this.requestSessionPathById.clear();
    this.currentSelectionToken = null;

    const workspaceCwd = this.resolveWorkspaceCwd();
    store.dispatch(sessionsActions.setWorkspaceCwd(workspaceCwd));

    // Restore persisted prefs.
    const storedPrefs = this.context.globalState.get<Partial<ChatPrefs>>(PREFS_STORAGE_KEY);
    if (storedPrefs) {
      store.dispatch(uiActions.setPrefs(resolveChatPrefs(storedPrefs)));
    }

    // Restore previously open tabs.
    const rawTabs = this.context.globalState.get<unknown[]>(OPEN_TABS_STORAGE_KEY) ?? [];
    const restoredTabs = normalizeStoredOpenTabPaths(rawTabs);
    const preferredStartupPath = this.context.globalState.get<string>(ACTIVE_SESSION_STORAGE_KEY) ?? null;
    const restoredSessionPlan = buildRestoredSessionPlan(restoredTabs, preferredStartupPath);
    store.dispatch(sessionsActions.setOpenTabPaths(restoredTabs));

    // Seed the sessions store with cached names so tabs render with correct
    // labels immediately, before the backend responds with the full session list.
    const cachedSessions: SessionSummary[] = rawTabs.flatMap((v) => {
      if (v === null || typeof v !== 'object') return [];
      const obj = v as Record<string, unknown>;
      const p = typeof obj['path'] === 'string' ? (obj['path'] as string) : null;
      if (!p || isPendingTabPath(p)) return [];
      const name = typeof obj['name'] === 'string' ? (obj['name'] as string) : 'New Session';
      return [{
        path: p,
        name,
        isPlaceholder: name === 'New Session',
        cwd: workspaceCwd,
        modifiedAt: new Date().toISOString(),
        messageCount: 0,
      }];
    });
    if (cachedSessions.length > 0) {
      store.dispatch(sessionsActions.replaceSessionSummaries(cachedSessions));
    }

    let nodePath: string;
    let sdkPath: string;

    try {
      const config = vscode.workspace.getConfiguration('pie');
      const rootConfig = vscode.workspace.getConfiguration();
      const configuredNodePath =
        config.get<string>('nodePath')?.trim() ||
        rootConfig.get<string>('piAssistant.nodePath')?.trim() ||
        undefined;
      const configuredSdkPath =
        config.get<string>('sdkPath')?.trim() ||
        rootConfig.get<string>('piAssistant.sdkPath')?.trim() ||
        undefined;
      const envSdkPath = process.env.PI_SDK_PATH?.trim() || undefined;
      const shouldUseSdkCache = !configuredSdkPath && !envSdkPath;
      const cachedSdkPath = shouldUseSdkCache
        ? this.context.globalState.get<string>(SDK_PATH_CACHE_KEY)
        : undefined;

      nodePath = resolveNodePath({
        configuredPath: configuredNodePath,
        env: process.env as NodeJS.ProcessEnv,
      });
      sdkPath = await resolveSdkPath({
        configuredPath: configuredSdkPath,
        cachedPath: cachedSdkPath,
        env: process.env as NodeJS.ProcessEnv,
        exec: createCommandExecutor(),
      });
      if (shouldUseSdkCache) {
        void this.context.globalState.update(SDK_PATH_CACHE_KEY, sdkPath);
      }
    } catch (err) {
      store.dispatch(
        uiActions.setNotice(
          `pie setup error: ${(err as Error).message}. ` +
            'Set pie.nodePath and pie.sdkPath in settings.',
        ),
      );
      this.scheduleRender();
      return;
    }

    const backendPath = path.join(this.context.extensionPath, 'out', 'backend.js');

    this.attachEvents();

    try {
      await this.backend.start({ nodePath, sdkPath, backendPath, cwd: workspaceCwd });
    } catch (err) {
      store.dispatch(
        uiActions.setNotice(`Failed to start PI backend: ${(err as Error).message}`),
      );
      this.detachEvents();
      this.scheduleRender();
      return;
    }

    const { startupPath: restoredStartupPath, preloadPaths } = restoredSessionPlan;

    if (restoredStartupPath) {
      // Restore the last active tab first, then warm the remaining tabs in the
      // background so tab switches can reuse cached transcripts.
      this.openSession(restoredStartupPath);
      this.preloadSessions(preloadPaths);
    }

    store.dispatch(uiActions.setBackendReady(true));
    this.scheduleRender();

    if (restoredStartupPath) {
      return;
    }

    // Without a restored tab, we need the session list to know what to open.
    try {
      const sessions = await this.backend.request<SessionSummary[]>('session.list');
      store.dispatch(sessionsActions.replaceSessionSummaries(sessions));
      this.scheduleRender();

      const toOpen = sessions[0]?.path;
      if (toOpen) {
        this.openSession(toOpen);
      }
    } catch {
      // Non-fatal; session list may be empty on a fresh install.
    }
  }

  private resolveWorkspaceCwd(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  }

  // ─── Event wiring ────────────────────────────────────────────────────────────

  private attachEvents(): void {
    this.eventDisposable = this.backend.onEvent((event: EventEnvelope) => {
      this.handleBackendEvent(event);
    });

    this.exitDisposable = this.backend.onExit(({ code, stderr }) => {
      const notice =
        `PI backend stopped${code !== null ? ` (code ${code})` : ''}` +
        (stderr ? `: ${stderr.slice(0, 300)}` : '');
      store.dispatch(uiActions.setNotice(notice));
      store.dispatch(uiActions.setBackendReady(false));
      store.dispatch(sessionsActions.clearRunningPaths());
      this.scheduleRender();
    });
  }

  private detachEvents(): void {
    this.eventDisposable?.dispose();
    this.exitDisposable?.dispose();
    this.eventDisposable = undefined;
    this.exitDisposable = undefined;
  }

  private handleBackendEvent(event: EventEnvelope): void {
    switch (event.event) {
      case 'session.opened':
        this.onSessionOpened(event.payload as SessionOpenedPayload);
        return;
      case 'session.list.changed':
        this.onSessionListChanged(event.payload as SessionListChangedPayload);
        return;
      case 'message.started':
        this.onMessageStarted(event.payload as MessageStartedPayload);
        return;
      case 'message.delta':
        this.onMessageDelta(event.payload as MessageDeltaPayload);
        return;
      case 'message.thinking':
        this.onMessageThinking(event.payload as MessageThinkingPayload);
        return;
      case 'tool.started':
        this.onToolStarted(event.payload as ToolStartedPayload);
        return;
      case 'tool.finished':
        this.onToolFinished(event.payload as ToolFinishedPayload);
        return;
      case 'tool.progress':
        this.onToolProgress(event.payload as ToolProgressPayload);
        return;
      case 'message.finished':
        this.onMessageFinished(event.payload as MessageFinishedPayload);
        return;
      case 'message.aborted':
        this.onMessageAborted(event.payload as MessageAbortedPayload);
        return;
      case 'busy.changed':
        this.onBusyChanged(event.payload as BusyChangedPayload);
        return;
      case 'contextUsage.changed':
        this.onContextUsageChanged(event.payload as ContextUsageChangedPayload);
        return;
      case 'error':
        this.onError(event.payload as ErrorPayload);
        return;
    }
  }

  // ─── Backend event handlers ───────────────────────────────────────────────────

  private onSessionOpened(payload: SessionOpenedPayload): void {
    const {
      session,
      transcript,
      systemPrompts,
      modelSettings,
      availableModels,
      contextUsage,
      selectionToken,
    } = payload;
    const state = store.getState();
    const selectionRequest = selectionToken
      ? this.selectionRequests.get(selectionToken) ?? null
      : null;
    const shouldOpenTab = !!selectionRequest || state.sessions.openTabPaths.includes(session.path);
    const shouldActivate = selectionToken
      ? this.currentSelectionToken === selectionToken
      : selectActiveSessionPath(state) === session.path;

    auditLog(this.context, 'session-service', 'session.opened', {
      selectionToken: selectionToken ?? null,
      sessionPath: session.path,
      shouldActivate,
      shouldOpenTab,
    });

    if (selectionRequest?.pendingPath && selectionRequest.pendingPath !== session.path) {
      store.dispatch(
        sessionsActions.replaceOpenTabPath({
          oldPath: selectionRequest.pendingPath,
          newPath: session.path,
        }),
      );
      store.dispatch(sessionStateActions.replaceSessionPath({
        oldPath: selectionRequest.pendingPath,
        newPath: session.path,
      }));
      this.runObserver.replaceSessionPath(selectionRequest.pendingPath, session.path);
      this.clearSessionScope(selectionRequest.pendingPath, true);
    }

    store.dispatch(sessionsActions.upsertSession(session));
    if (shouldOpenTab) {
      store.dispatch(sessionsActions.ensureOpenTab(session.path));
    }

    if (shouldActivate) {
      store.dispatch(sessionsActions.setActiveSessionPath(session.path));
    }
    const transcriptResolution = resolveSessionOpenedTranscript({
      busy: payload.busy,
      incomingTranscript: transcript,
      localTranscript: store.getState().transcript.bySession[session.path] ?? [],
    });

    if (!transcriptResolution.preserveLocal) {
      store.dispatch(
        transcriptActions.setTranscript({
          sessionPath: session.path,
          transcript: transcriptResolution.transcript,
          systemPrompts,
        }),
      );
    }

    store.dispatch(sessionStateActions.setAnalyticsFactors({
      sessionPath: session.path,
      factors: payload.analyticsFactors ?? null,
    }));
    this.runObserver.onSessionAnalyticsFactorsChanged(session.path, payload.analyticsFactors ?? null);

    if (modelSettings) {
      store.dispatch(settingsActions.setModelSettings(modelSettings));
    }
    if (availableModels) {
      store.dispatch(settingsActions.setAvailableModels({
        sessionPath: session.path,
        availableModels,
      }));
    }
    store.dispatch(settingsActions.setContextUsage({
      sessionPath: session.path,
      contextUsage: contextUsage ?? null,
    }));

    this.finishSelectionRequest(selectionToken);
    this.assertSelectionInvariant('onSessionOpened');

    this.saveOpenTabs();
    this.scheduleRender();
  }

  private onSessionListChanged(payload: SessionListChangedPayload): void {
    store.dispatch(sessionsActions.replaceSessionSummaries(payload.sessions));
    this.scheduleRender();
  }

  private onMessageStarted(payload: MessageStartedPayload): void {
    const sessionPath = this.requireEventSessionPath('message.started', payload.sessionPath);
    if (!sessionPath) return;

    store.dispatch(
      transcriptActions.ensureAssistantMessage({
        sessionPath,
        messageId: payload.messageId,
        requestId: payload.requestId,
        modelId: payload.modelId,
        thinkingLevel: payload.thinkingLevel,
      }),
    );
    this.requestSessionPathById.set(payload.requestId, sessionPath);
    this.runObserver.onAssistantTurnStarted(sessionPath, payload.messageId);

    if (payload.modelId) {
      const session = getSessionByPath(store.getState(), sessionPath);
      if (session && (session.modelId !== payload.modelId || session.thinkingLevel !== payload.thinkingLevel)) {
        store.dispatch(sessionsActions.upsertSession({
          ...session,
          modelId: payload.modelId,
          thinkingLevel: payload.thinkingLevel,
        }));
      }
    }

    this.scheduleRender();
  }

  private onMessageDelta(payload: MessageDeltaPayload): void {
    const sessionPath = this.requireEventSessionPath('message.delta', payload.sessionPath);
    if (!sessionPath) return;

    store.dispatch(
      transcriptActions.appendDelta({
        sessionPath,
        messageId: payload.messageId,
        delta: payload.delta,
      }),
    );

    if (this.isActiveSession(sessionPath)) {
      const canonicalId = getCanonicalMessageId(payload.messageId, store.getState());
      this.postPatch({ kind: 'messageDelta', messageId: canonicalId, delta: payload.delta });
    }
  }

  private onMessageThinking(payload: MessageThinkingPayload): void {
    const sessionPath = this.requireEventSessionPath('message.thinking', payload.sessionPath);
    if (!sessionPath) return;

    store.dispatch(
      transcriptActions.appendThinking({
        sessionPath,
        messageId: payload.messageId,
        thinking: payload.thinking,
      }),
    );

    if (this.isActiveSession(sessionPath)) {
      const canonicalId = getCanonicalMessageId(payload.messageId, store.getState());
      this.postPatch({
        kind: 'messageThinking',
        messageId: canonicalId,
        thinking: payload.thinking,
      });
    }
  }

  private onToolStarted(payload: ToolStartedPayload): void {
    const sessionPath = this.requireEventSessionPath('tool.started', payload.sessionPath);
    if (!sessionPath) return;

    const canonicalId = getCanonicalMessageId(payload.messageId, store.getState());
    const toolCall = {
      id: payload.toolCallId,
      name: payload.name,
      input: payload.input,
      status: 'running' as const,
    };

    store.dispatch(
      transcriptActions.upsertToolCall({ sessionPath, messageId: canonicalId, toolCall }),
    );
    this.runObserver.onToolStarted(sessionPath, toolCall);

    if (this.isActiveSession(sessionPath)) {
      this.postPatch({ kind: 'toolCall', messageId: canonicalId, toolCall });
    }
    // Schedule a snapshot so the tool card appears immediately rather than
    // waiting until the message finishes.
    this.scheduleRender();
  }

  private onToolFinished(payload: ToolFinishedPayload): void {
    const sessionPath = this.requireEventSessionPath('tool.finished', payload.sessionPath);
    if (!sessionPath) return;

    const canonicalId = getCanonicalMessageId(payload.messageId, store.getState());

    // Preserve existing name/input from the tool-started event.
    const existing = store
      .getState()
      .transcript.bySession[sessionPath]
      ?.find((m) => m.id === canonicalId)
      ?.toolCalls?.find((tc) => tc.id === payload.toolCallId);

    const toolCall = {
      id: payload.toolCallId,
      name: existing?.name ?? '',
      input: existing?.input,
      result: payload.result,
      status: payload.status,
    };

    store.dispatch(
      transcriptActions.upsertToolCall({ sessionPath, messageId: canonicalId, toolCall }),
    );
    this.runObserver.onToolFinished(sessionPath, toolCall);

    if (this.isActiveSession(sessionPath)) {
      this.postPatch({ kind: 'toolCall', messageId: canonicalId, toolCall });
    }
    this.scheduleRender();
  }

  private onToolProgress(payload: ToolProgressPayload): void {
    const sessionPath = this.requireEventSessionPath('tool.progress', payload.sessionPath);
    if (!sessionPath) return;

    const canonicalId = getCanonicalMessageId(payload.messageId, store.getState());

    // Preserve existing name/input; update the result with the partial snapshot.
    const existing = store
      .getState()
      .transcript.bySession[sessionPath]
      ?.find((m) => m.id === canonicalId)
      ?.toolCalls?.find((tc) => tc.id === payload.toolCallId);

    const toolCall = {
      id: payload.toolCallId,
      name: existing?.name ?? '',
      input: existing?.input,
      result: payload.partialResult,
      status: 'running' as const,
    };

    store.dispatch(
      transcriptActions.upsertToolCall({ sessionPath, messageId: canonicalId, toolCall }),
    );

    if (this.isActiveSession(sessionPath)) {
      this.postPatch({ kind: 'toolCall', messageId: canonicalId, toolCall });
    }
    this.scheduleRender();
  }

  private onMessageFinished(payload: MessageFinishedPayload): void {
    const sessionPath = this.requireEventSessionPath('message.finished', payload.sessionPath);
    if (!sessionPath) return;

    store.dispatch(
      transcriptActions.upsertMessage({ sessionPath, message: payload.message }),
    );
    this.runObserver.onAssistantTurnEnded(
      sessionPath,
      payload.message.id,
      payload.message.durationMs ?? 0,
    );
    this.requestSessionPathById.delete(payload.requestId);

    // Ask the webview to clear streaming overlay bytes for this message now
    // that the canonical snapshot has been updated.
    if (this.isActiveSession(sessionPath)) {
      const canonicalId = getCanonicalMessageId(payload.message.id, store.getState());
      this.postPatch({ kind: 'clearOverlay', messageIds: [canonicalId] });
    }

    this.scheduleRender();
  }

  private onMessageAborted(payload: MessageAbortedPayload): void {
    const sessionPath = this.requireEventSessionPath('message.aborted', payload.sessionPath);
    if (!sessionPath) return;

    if (payload.messageId) {
      store.dispatch(
        transcriptActions.setMessageStatus({
          sessionPath,
          messageId: payload.messageId,
          status: 'interrupted',
        }),
      );
    }
    this.runObserver.onInterrupted(sessionPath);
    this.scheduleRender();
  }

  private onBusyChanged(payload: BusyChangedPayload): void {
    const sessionPath = this.requireEventSessionPath('busy.changed', payload.sessionPath);
    if (!sessionPath) return;

    auditLog(this.context, 'session-service', 'busy.changed', {
      busy: payload.busy,
      seq: payload.seq ?? null,
      sessionPath,
    });

    // Drop out-of-order events using per-session sequence numbers.
    if (typeof payload.seq === 'number') {
      const last = this.busySeqMap.get(sessionPath) ?? 0;
      if (payload.seq <= last) return;
      this.busySeqMap.set(sessionPath, payload.seq);
    }

    const state = store.getState();
    const wasRunning = state.sessions.runningSessionPaths.includes(sessionPath);

    if (payload.busy) {
      this.suppressNextCompletionNotification.delete(sessionPath);
    }

    store.dispatch(
      sessionsActions.setSessionRunning({ sessionPath, running: payload.busy }),
    );
    this.runObserver.onBusyChanged(sessionPath, payload.busy);

    if (wasRunning && !payload.busy && !this.suppressNextCompletionNotification.delete(sessionPath)) {
      if (
        state.sessions.openTabPaths.includes(sessionPath) &&
        shouldFlashFinishedTab({
          suppressNotifications: state.ui.prefs.suppressCompletionNotifications,
          sessionIsActive: state.sessions.activeSessionPath === sessionPath,
        })
      ) {
        store.dispatch(sessionsActions.markSessionFinishedUnread(sessionPath));
      }

      this.onSessionCompleted?.({
        sessionPath,
      });
    }

    this.scheduleRender();
  }

  private onContextUsageChanged(payload: ContextUsageChangedPayload): void {
    const sessionPath = this.requireEventSessionPath('contextUsage.changed', payload.sessionPath);
    if (!sessionPath) return;

    store.dispatch(settingsActions.setContextUsage({
      sessionPath,
      contextUsage: payload.contextUsage ?? null,
    }));
    if (payload.contextUsage) {
      this.runObserver.onContextUsageChanged(
        sessionPath,
        payload.contextUsage.tokens,
        payload.contextUsage.contextWindow,
      );
    }
    this.scheduleRender();
  }

  private onError(payload: ErrorPayload): void {
    this.runObserver.onBackendError(
      payload.requestId ? this.requestSessionPathById.get(payload.requestId) : undefined,
      payload.code,
    );
    store.dispatch(uiActions.setNotice(payload.message));
    this.scheduleRender();
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  private createPendingSessionPath(): string {
    this.pendingSessionCounter += 1;
    return `${PENDING_SESSION_PREFIX}${Date.now()}-${this.pendingSessionCounter}-${Math.random().toString(36).slice(2, 8)}`;
  }

  private beginSelectionRequest(
    requestedPath: string,
    pendingPath?: string,
    wasOpenTab = false,
    insertedPlaceholder = false,
  ): string {
    this.selectionRequestCounter += 1;
    const token = `selection:${this.selectionRequestCounter}`;
    this.selectionRequests.set(token, {
      insertedPlaceholder,
      token,
      requestedPath,
      pendingPath,
      previousActivePath: selectActiveSessionPath(store.getState()),
      wasOpenTab,
    });
    this.currentSelectionToken = token;
    return token;
  }

  private finishSelectionRequest(selectionToken?: string): void {
    if (!selectionToken) {
      return;
    }

    this.selectionRequests.delete(selectionToken);
    if (this.currentSelectionToken === selectionToken) {
      this.currentSelectionToken = null;
    }
  }

  private clearSelectionRequestsForPath(sessionPath: string): void {
    for (const [token, request] of this.selectionRequests) {
      if (request.pendingPath === sessionPath) {
        if (this.currentSelectionToken === token) {
          this.currentSelectionToken = null;
        }
        continue;
      }
      if (request.requestedPath === sessionPath) {
        this.selectionRequests.delete(token);
        if (this.currentSelectionToken === token) {
          this.currentSelectionToken = null;
        }
      }
    }
  }

  private handleSelectionFailure(selectionToken: string, notice: string): void {
    const request = this.selectionRequests.get(selectionToken);
    const ownsSelection = this.currentSelectionToken === selectionToken;
    this.finishSelectionRequest(selectionToken);

    if (request) {
      if (request.pendingPath) {
        this.clearSessionScope(request.pendingPath, true);
      } else if (!request.wasOpenTab) {
        store.dispatch(sessionsActions.removeOpenTab(request.requestedPath));
        this.clearSessionScope(request.requestedPath, request.insertedPlaceholder);
      }

      if (ownsSelection) {
        const fallbackPath = request.previousActivePath && store.getState().sessions.openTabPaths.includes(request.previousActivePath)
          ? request.previousActivePath
          : store.getState().sessions.openTabPaths[0] ?? null;
        store.dispatch(sessionsActions.setActiveSessionPath(fallbackPath));
      }
      this.saveOpenTabs();
    }

    store.dispatch(uiActions.setNotice(notice));
    this.assertSelectionInvariant('handleSelectionFailure');
    this.scheduleRender();
  }

  private enqueueLifecycle<T>(task: () => Promise<T>): Promise<T> {
    const next = this.lifecycleQueue.catch(() => undefined).then(task);
    this.lifecycleQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  private enqueueSessionOperation<T>(sessionPath: string, task: () => Promise<T>): Promise<T> {
    const previous = this.sessionOperationQueues.get(sessionPath) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(task);
    const barrier = result.then(() => undefined, () => undefined);

    this.sessionOperationQueues.set(sessionPath, barrier);
    void barrier.finally(() => {
      if (this.sessionOperationQueues.get(sessionPath) === barrier) {
        this.sessionOperationQueues.delete(sessionPath);
      }
    });

    return result;
  }

  private getSessionDataEpoch(sessionPath: string): number {
    return this.sessionDataEpochs.get(sessionPath) ?? 0;
  }

  private bumpSessionDataEpoch(sessionPath: string): number {
    const next = this.getSessionDataEpoch(sessionPath) + 1;
    this.sessionDataEpochs.set(sessionPath, next);
    return next;
  }

  private requireEventSessionPath(eventName: string, sessionPath: string | undefined): string | null {
    if (sessionPath) {
      return sessionPath;
    }

    auditLog(this.context, 'session-service', 'protocol.defect', {
      eventName,
      reason: 'missing sessionPath',
    });
    store.dispatch(uiActions.setNotice(`Protocol defect: ${eventName} arrived without a sessionPath.`));
    this.scheduleRender();
    return null;
  }

  private requireOpenSessionPath(actionName: string, sessionPath?: string): string | null {
    const resolvedSessionPath = sessionPath ?? selectActiveSessionPath(store.getState());
    if (!resolvedSessionPath) {
      store.dispatch(uiActions.setNotice(`Cannot ${actionName}: no active session.`));
      this.scheduleRender();
      return null;
    }
    if (isPendingTabPath(resolvedSessionPath)) {
      store.dispatch(uiActions.setNotice(`Cannot ${actionName}: the session is still opening.`));
      this.scheduleRender();
      return null;
    }
    if (!store.getState().sessions.openTabPaths.includes(resolvedSessionPath)) {
      store.dispatch(uiActions.setNotice(`Cannot ${actionName}: the selected session is no longer open.`));
      this.scheduleRender();
      return null;
    }
    return resolvedSessionPath;
  }

  private requireActiveOpenSessionPath(actionName: string): string | null {
    return this.requireOpenSessionPath(actionName);
  }

  private maybeApplyOptimisticSessionName(sessionPath: string, text: string): SessionSummary | null {
    const session = getSessionByPath(store.getState(), sessionPath);
    if (!session || session.isPlaceholder !== true) {
      return null;
    }

    const derived = deriveSessionNameFromText(text);
    if (derived.isPlaceholder || derived.name === session.name) {
      return null;
    }

    store.dispatch(sessionsActions.upsertSession({
      ...session,
      name: derived.name,
      isPlaceholder: false,
    }));
    this.saveOpenTabs();
    return session;
  }

  private resolveComposerTargetSessionPath(requestedSessionPath?: string): string | null {
    const existingPath = this.resolveExistingComposerTargetSessionPath(requestedSessionPath);
    if (existingPath) {
      return existingPath;
    }

    return this.createNewSession();
  }

  private resolveExistingComposerTargetSessionPath(requestedSessionPath?: string): string | null {
    const state = store.getState();
    const sessionPath = requestedSessionPath ?? selectActiveSessionPath(state);
    if (!sessionPath) {
      return null;
    }
    if (!state.sessions.openTabPaths.includes(sessionPath)) {
      store.dispatch(uiActions.setNotice('Cannot update composer inputs: the selected session is no longer open.'));
      this.scheduleRender();
      return null;
    }
    return sessionPath;
  }

  private createComposerInputId(): string {
    this.composerInputCounter += 1;
    return `input:${Date.now()}:${this.composerInputCounter}`;
  }

  private modelSupportsInputKind(
    sessionPath: string,
    requestedModelId: string | undefined,
    inputKind: 'text' | 'image',
  ): boolean {
    const state = store.getState();
    const modelId = requestedModelId
      ?? getSessionByPath(state, sessionPath)?.modelId
      ?? state.settings.modelSettings?.defaultModel;
    if (!modelId) {
      return inputKind === 'text';
    }

    const directModels = state.settings.availableModelsBySession[sessionPath] ?? [];
    const fallbackModels = Object.values(state.settings.availableModelsBySession)
      .flatMap((models) => models);
    const model = [...directModels, ...fallbackModels].find((candidate) => candidate.id === modelId);
    if (!model) {
      return inputKind === 'text';
    }

    return model.inputKinds.includes(inputKind);
  }

  private clearPendingImageInputs(sessionPath: string): void {
    const existingInputs = store.getState().sessionState.pendingComposerInputsBySession[sessionPath] ?? [];
    const remainingInputs = existingInputs.filter((input) => input.kind !== 'imageBlob');
    if (remainingInputs.length === existingInputs.length) {
      return;
    }
    if (remainingInputs.length === 0) {
      store.dispatch(sessionStateActions.clearPendingComposerInputs(sessionPath));
      return;
    }
    store.dispatch(sessionStateActions.setPendingComposerInputs({
      sessionPath,
      inputs: remainingInputs,
    }));
  }

  private buildPromptText(text: string, inputs: ComposerInput[]): string {
    const sections: string[] = [];
    const pathPrelude = inputs
      .filter((input): input is Extract<ComposerInput, { kind: 'filesystemPathRef' }> =>
        input.kind === 'filesystemPathRef')
      .map((input) => `@${input.path}`);
    if (pathPrelude.length > 0) {
      sections.push(pathPrelude.join('\n'));
    }
    if (text.trim()) {
      sections.push(text);
    }
    return sections.join('\n\n');
  }

  private buildOptimisticUserParts(text: string, inputs: ComposerInput[]): UserContentPart[] | undefined {
    const userParts: UserContentPart[] = [];
    const promptText = this.buildPromptText(text, inputs);
    if (promptText) {
      userParts.push({ kind: 'text', text: promptText });
    }

    for (const input of inputs) {
      if (input.kind !== 'imageBlob') {
        continue;
      }
      userParts.push({
        kind: 'image',
        mimeType: input.mimeType,
        dataBase64: input.dataBase64,
        name: input.name,
        width: input.width,
        height: input.height,
      });
    }

    return userParts.length > 0 ? userParts : undefined;
  }

  private clearSessionScope(sessionPath: string, removeSessionSummary = false): void {
    this.busySeqMap.delete(sessionPath);
    this.sessionOperationQueues.delete(sessionPath);
    this.sessionDataEpochs.delete(sessionPath);
    this.preloadingSessionPaths.delete(sessionPath);
    this.suppressNextCompletionNotification.delete(sessionPath);
    for (const [requestId, mappedSessionPath] of this.requestSessionPathById) {
      if (mappedSessionPath === sessionPath) {
        this.requestSessionPathById.delete(requestId);
      }
    }
    store.dispatch(transcriptActions.clearSessionState(sessionPath));
    store.dispatch(settingsActions.clearAvailableModels(sessionPath));
    store.dispatch(settingsActions.clearContextUsage(sessionPath));
    store.dispatch(sessionStateActions.clearSessionState(sessionPath));
    if (removeSessionSummary) {
      store.dispatch(sessionsActions.removeSession(sessionPath));
    }
  }

  private assertSelectionInvariant(source: string): void {
    const state = store.getState();
    const activeSessionPath = selectActiveSessionPath(state);
    assertInvariant(
      this.context,
      'session-service',
      !activeSessionPath || state.sessions.openTabPaths.includes(activeSessionPath),
      'Active session path must always reference an open tab.',
      {
        activeSessionPath,
        openTabPaths: state.sessions.openTabPaths,
        source,
      },
    );
  }

  private isActiveSession(sessionPath: string): boolean {
    return selectActiveSessionPath(store.getState()) === sessionPath;
  }

  private saveOpenTabs(): void {
    const { openTabPaths, sessions, activeSessionPath } = store.getState().sessions;

    const tabObjects = openTabPaths
      .filter((p) => !isPendingTabPath(p))
      .map((p) => {
        const session = sessions.find((s) => s.path === p);
        return session ? { path: p, name: session.name } : { path: p };
      });

    const persistedActiveSessionPath =
      activeSessionPath &&
      !isPendingTabPath(activeSessionPath) &&
      openTabPaths.includes(activeSessionPath)
        ? activeSessionPath
        : undefined;

    void this.context.globalState.update(OPEN_TABS_STORAGE_KEY, tabObjects);
    void this.context.globalState.update(ACTIVE_SESSION_STORAGE_KEY, persistedActiveSessionPath);
  }

  private preloadSessions(sessionPaths: readonly string[]): void {
    for (const sessionPath of sessionPaths) {
      this.preloadSession(sessionPath);
    }
  }

  private preloadSession(sessionPath: string): void {
    if (!sessionPath || isPendingTabPath(sessionPath)) {
      return;
    }

    if (this.preloadingSessionPaths.has(sessionPath)) {
      return;
    }

    if (Object.prototype.hasOwnProperty.call(store.getState().transcript.bySession, sessionPath)) {
      return;
    }

    this.preloadingSessionPaths.add(sessionPath);
    const requestEpoch = this.getSessionDataEpoch(sessionPath);
    void this.backend.request<SessionOpenedPayload>('session.preload', { sessionPath })
      .then((payload) => {
        if (this.getSessionDataEpoch(sessionPath) !== requestEpoch) {
          return;
        }
        if (!store.getState().sessions.openTabPaths.includes(sessionPath)) {
          return;
        }
        this.onSessionOpened(payload);
      })
      .catch((error) => {
        auditLog(this.context, 'session-service', 'session.preload.failed', {
          sessionPath,
          message: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        this.preloadingSessionPaths.delete(sessionPath);
      });
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
