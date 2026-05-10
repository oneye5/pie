import * as path from 'node:path';

import * as vscode from 'vscode';

import { BackendClient } from './backend-client';
import { assertInvariant, auditLog } from './state-audit';
import {
  getSessionByPath,
  sessionsActions,
  selectActiveSessionPath,
  settingsActions,
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
import { resolveNodePath, resolveSdkPath } from '../shared/runtime-resolution';
import { createCommandExecutor } from '../shared/exec-command';
import type {
  BusyChangedPayload,
  ChatPrefs,
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
} from '../shared/protocol';

const OPEN_TABS_STORAGE_KEY = 'openTabPaths';
const PREFS_STORAGE_KEY = 'chatPrefs';

type ScheduleRender = () => void;
type PostPatch = (op: PatchOp) => void;
type PostImperative = (message: HostToWebviewMessage) => void;

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
  private pendingSessionCounter = 0;
  private selectionRequestCounter = 0;
  private currentSelectionToken: string | null = null;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly backend: BackendClient,
    private readonly scheduleRender: ScheduleRender,
    private readonly postPatch: PostPatch,
    private readonly postImperative: PostImperative,
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
  createNewSession(): void {
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
  }

  openSession(sessionPath: string): void {
    const existing = getSessionByPath(store.getState(), sessionPath);
    const wasOpenTab = store.getState().sessions.openTabPaths.includes(sessionPath);
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

  async send(text: string, pendingPaths: string[] = []): Promise<void> {
    const attemptedSessionPath = selectActiveSessionPath(store.getState()) ?? '__unknown__';
    const sessionPath = this.requireActiveOpenSessionPath('send');
    if (!sessionPath) {
      this.postImperative({ type: 'sendRejected', sessionPath: attemptedSessionPath, text, pendingPaths });
      return;
    }

    const composedText = pendingPaths.length > 0
      ? `${pendingPaths.map((path) => `@${path}`).join('\n')}\n\n${text}`
      : text;

    auditLog(this.context, 'session-service', 'message.send.requested', {
      attachedPathCount: pendingPaths.length,
      sessionPath,
      textLength: text.length,
    });

    // Optimistically append the user message so the UI updates immediately.
    const localId = `local:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    store.dispatch(
      transcriptActions.appendLocalUserMessage({
        sessionPath,
        id: localId,
        text: composedText,
      }),
    );
    this.scheduleRender();

    try {
      await this.enqueueSessionOperation(sessionPath, async () => {
        await this.backend.request('message.send', {
          sessionPath,
          text: composedText,
        });
      });
    } catch (err) {
      store.dispatch(transcriptActions.removeMessage({ sessionPath, messageId: localId }));
      this.postImperative({ type: 'sendRejected', sessionPath, text, pendingPaths });
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
      await this.enqueueSessionOperation(sessionPath, async () => {
        await this.backend.request('session.truncateAfter', {
          sessionPath,
          entryId: messageId,
        });

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

        await this.backend.request('message.send', {
          sessionPath,
          text,
        });
      });
    } catch (err) {
      if (localId) {
        store.dispatch(transcriptActions.removeMessage({ sessionPath, messageId: localId }));
      }
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
      await this.enqueueSessionOperation(activeSessionPath, async () => {
        await this.backend.request('message.interrupt', {
          sessionPath: activeSessionPath,
        });
      });
    } catch (err) {
      store.dispatch(
        uiActions.setNotice(`Failed to interrupt: ${(err as Error).message}`),
      );
      this.scheduleRender();
    }
  }

  async setModel(defaultModel: string, defaultThinkingLevel: ThinkingLevel): Promise<void> {
    try {
      const result = await this.backend.request<ModelSettings>('settings.set', {
        defaultModel,
        defaultThinkingLevel,
      });
      store.dispatch(settingsActions.setModelSettings(result));
      this.scheduleRender();
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

  setPrefs(prefs: Partial<ChatPrefs>): void {
    store.dispatch(uiActions.setPrefs(prefs));
    const merged = { ...store.getState().ui.prefs, ...prefs };
    void this.context.globalState.update(PREFS_STORAGE_KEY, merged);
    // Intentionally no scheduleRender() here — the caller posts a snapshot immediately.
  }

  // ─── Backend startup ─────────────────────────────────────────────────────────

  private async startBackend(): Promise<void> {
    this.busySeqMap.clear();
    this.sessionOperationQueues.clear();
    this.selectionRequests.clear();
    this.currentSelectionToken = null;

    const workspaceCwd = this.resolveWorkspaceCwd();
    store.dispatch(sessionsActions.setWorkspaceCwd(workspaceCwd));

    // Restore persisted prefs.
    const storedPrefs = this.context.globalState.get<Partial<ChatPrefs>>(PREFS_STORAGE_KEY);
    if (storedPrefs) {
      store.dispatch(uiActions.setPrefs(storedPrefs));
    }

    // Restore previously open tabs.
    const rawTabs = this.context.globalState.get<unknown[]>(OPEN_TABS_STORAGE_KEY) ?? [];
    const restoredTabs = normalizeStoredOpenTabPaths(rawTabs);
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
      const config = vscode.workspace.getConfiguration('piAssistant');
      nodePath = resolveNodePath({
        configuredPath: config.get<string>('nodePath'),
        env: process.env as NodeJS.ProcessEnv,
      });
      sdkPath = await resolveSdkPath({
        configuredPath: config.get<string>('sdkPath'),
        env: process.env as NodeJS.ProcessEnv,
      exec: createCommandExecutor(),
      });
    } catch (err) {
      store.dispatch(
        uiActions.setNotice(
          `PI Assistant setup error: ${(err as Error).message}. ` +
            'Set piAssistant.nodePath and piAssistant.sdkPath in settings.',
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

    store.dispatch(uiActions.setBackendReady(true));
    this.scheduleRender();

    // Load initial session list and restore the most-recently open tab.
    try {
      const sessions = await this.backend.request<SessionSummary[]>('session.list');
      store.dispatch(sessionsActions.replaceSessionSummaries(sessions));
      this.scheduleRender();

      const toOpen = restoredTabs.length > 0
        ? restoredTabs[0]
        : sessions[0]?.path;

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
      this.clearSessionScope(selectionRequest.pendingPath, true);
    }

    store.dispatch(sessionsActions.upsertSession(session));
    if (shouldOpenTab) {
      store.dispatch(sessionsActions.ensureOpenTab(session.path));
    }

    if (shouldActivate) {
      store.dispatch(sessionsActions.setActiveSessionPath(session.path));
    }
    store.dispatch(
      transcriptActions.setTranscript({
        sessionPath: session.path,
        transcript,
        systemPrompts,
      }),
    );

    if (modelSettings) {
      store.dispatch(settingsActions.setModelSettings(modelSettings));
    }
    if (availableModels && availableModels.length > 0) {
      store.dispatch(settingsActions.setAvailableModels(availableModels));
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
      }),
    );
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
      status: 'completed' as const,
    };

    store.dispatch(
      transcriptActions.upsertToolCall({ sessionPath, messageId: canonicalId, toolCall }),
    );

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
    if (!sessionPath || !payload.messageId) return;

    store.dispatch(
      transcriptActions.setMessageStatus({
        sessionPath,
        messageId: payload.messageId,
        status: 'interrupted',
      }),
    );
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

    store.dispatch(
      sessionsActions.setSessionRunning({ sessionPath, running: payload.busy }),
    );
    this.scheduleRender();
  }

  private onError(payload: ErrorPayload): void {
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

  private enqueueLifecycle(task: () => Promise<void>): Promise<void> {
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

  private requireActiveOpenSessionPath(actionName: string): string | null {
    const sessionPath = selectActiveSessionPath(store.getState());
    if (!sessionPath) {
      store.dispatch(uiActions.setNotice(`Cannot ${actionName}: no active session.`));
      this.scheduleRender();
      return null;
    }
    if (isPendingTabPath(sessionPath)) {
      store.dispatch(uiActions.setNotice(`Cannot ${actionName}: the session is still opening.`));
      this.scheduleRender();
      return null;
    }
    if (!store.getState().sessions.openTabPaths.includes(sessionPath)) {
      store.dispatch(uiActions.setNotice(`Cannot ${actionName}: the active session is no longer open.`));
      this.scheduleRender();
      return null;
    }
    return sessionPath;
  }

  private clearSessionScope(sessionPath: string, removeSessionSummary = false): void {
    this.busySeqMap.delete(sessionPath);
    this.sessionOperationQueues.delete(sessionPath);
    store.dispatch(transcriptActions.clearSessionState(sessionPath));
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
    const { openTabPaths, sessions } = store.getState().sessions;

    const tabObjects = openTabPaths
      .filter((p) => !isPendingTabPath(p))
      .map((p) => {
        const session = sessions.find((s) => s.path === p);
        return session ? { path: p, name: session.name } : { path: p };
      });

    void this.context.globalState.update(OPEN_TABS_STORAGE_KEY, tabObjects);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
