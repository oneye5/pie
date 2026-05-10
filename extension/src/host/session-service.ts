import * as path from 'node:path';

import * as vscode from 'vscode';

import { BackendClient } from './backend-client';
import {
  sessionsActions,
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
  ToolStartedPayload,
} from '../shared/protocol';

const OPEN_TABS_STORAGE_KEY = 'openTabPaths';
const PREFS_STORAGE_KEY = 'chatPrefs';

type ScheduleRender = () => void;
type PostPatch = (op: PatchOp) => void;

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

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly backend: BackendClient,
    private readonly scheduleRender: ScheduleRender,
    private readonly postPatch: PostPatch,
  ) {}

  async start(): Promise<void> {
    await this.startBackend();
  }

  async restart(): Promise<void> {
    this.detachEvents();
    await this.backend.stop();
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
    const pendingPath = `${PENDING_SESSION_PREFIX}${Date.now()}`;
    const cwd = store.getState().sessions.workspaceCwd ?? '';

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
    store.dispatch(
      sessionsActions.setActiveSession(
        store.getState().sessions.sessions.find((s) => s.path === pendingPath) ?? null,
      ),
    );
    this.saveOpenTabs();
    this.scheduleRender();

    void this.backend
      .request<{ requestId?: string }>('session.create', { cwd })
      .catch((err: unknown) => {
        store.dispatch(
          uiActions.setNotice(`Failed to create session: ${(err as Error).message}`),
        );
        store.dispatch(sessionsActions.removePendingSessions());
        this.scheduleRender();
      });
  }

  async openSession(sessionPath: string): Promise<void> {
    try {
      store.dispatch(sessionsActions.ensureOpenTab(sessionPath));
      this.saveOpenTabs();
      await this.backend.request('session.open', { sessionPath });
    } catch (err) {
      store.dispatch(
        uiActions.setNotice(`Failed to open session: ${(err as Error).message}`),
      );
      this.scheduleRender();
    }
  }

  async closeSession(sessionPath: string): Promise<void> {
    const state = store.getState();
    const nextPath = getNextVisibleTabPathOnClose({
      closingPath: sessionPath,
      openTabPaths: state.sessions.openTabPaths,
      sessions: state.sessions.sessions,
      workspaceCwd: state.sessions.workspaceCwd,
      activeSession: state.sessions.activeSession,
    });

    store.dispatch(sessionsActions.removeOpenTab(sessionPath));
    this.saveOpenTabs();

    if (state.sessions.activeSession?.path === sessionPath) {
      if (nextPath) {
        await this.openSession(nextPath);
      } else {
        store.dispatch(sessionsActions.clearActiveSession());
        store.dispatch(transcriptActions.clearTranscript(sessionPath));
        this.scheduleRender();
      }
    }
  }

  async send(text: string): Promise<void> {
    const { activeSession } = store.getState().sessions;
    if (!activeSession) return;

    // Optimistically append the user message so the UI updates immediately.
    const localId = `local:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    store.dispatch(
      transcriptActions.appendLocalUserMessage({
        sessionPath: activeSession.path,
        id: localId,
        text,
      }),
    );
    this.scheduleRender();

    try {
      await this.backend.request('message.send', {
        sessionPath: isPendingTabPath(activeSession.path) ? undefined : activeSession.path,
        text,
      });
    } catch (err) {
      store.dispatch(
        uiActions.setNotice(`Failed to send message: ${(err as Error).message}`),
      );
      this.scheduleRender();
    }
  }

  async editMessage(messageId: string, text: string): Promise<void> {
    const { activeSession } = store.getState().sessions;
    if (!activeSession) return;

    try {
      await this.backend.request('session.truncateAfter', {
        sessionPath: activeSession.path,
        entryId: messageId,
      });
      await this.backend.request('message.send', {
        sessionPath: activeSession.path,
        text,
      });
    } catch (err) {
      store.dispatch(
        uiActions.setNotice(`Failed to edit message: ${(err as Error).message}`),
      );
      this.scheduleRender();
    }
  }

  async interrupt(): Promise<void> {
    const { activeSession } = store.getState().sessions;
    try {
      await this.backend.request('message.interrupt', {
        sessionPath: activeSession?.path,
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
        await this.openSession(toOpen);
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
    const { session, transcript, systemPrompt, modelSettings, availableModels } = payload;

    // Swap any pending placeholder tab with the real session path.
    const pendingTab = store
      .getState()
      .sessions.openTabPaths.find(isPendingTabPath);

    if (pendingTab) {
      store.dispatch(
        sessionsActions.replaceOpenTabPath({ oldPath: pendingTab, newPath: session.path }),
      );
      store.dispatch(sessionsActions.removePendingSessions());
    }

    store.dispatch(sessionsActions.upsertSession(session));
    store.dispatch(sessionsActions.ensureOpenTab(session.path));
    store.dispatch(sessionsActions.setActiveSession(session));
    store.dispatch(
      transcriptActions.setTranscript({
        sessionPath: session.path,
        transcript,
        systemPrompt,
      }),
    );

    if (modelSettings) {
      store.dispatch(settingsActions.setModelSettings(modelSettings));
    }
    if (availableModels && availableModels.length > 0) {
      store.dispatch(settingsActions.setAvailableModels(availableModels));
    }

    this.saveOpenTabs();
    this.scheduleRender();
  }

  private onSessionListChanged(payload: SessionListChangedPayload): void {
    store.dispatch(sessionsActions.replaceSessionSummaries(payload.sessions));
    this.scheduleRender();
  }

  private onMessageStarted(payload: MessageStartedPayload): void {
    const sessionPath = this.resolveSessionPath(payload.sessionPath);
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
    const sessionPath = this.resolveSessionPath(payload.sessionPath);
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
    const sessionPath = this.resolveSessionPath(payload.sessionPath);
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
    const sessionPath = this.resolveSessionPath(payload.sessionPath);
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
  }

  private onToolFinished(payload: ToolFinishedPayload): void {
    const sessionPath = this.resolveSessionPath(payload.sessionPath);
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
  }

  private onMessageFinished(payload: MessageFinishedPayload): void {
    const sessionPath = this.resolveSessionPath(payload.sessionPath);
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
    const sessionPath = this.resolveSessionPath(payload.sessionPath);
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
    const sessionPath = this.resolveSessionPath(payload.sessionPath);
    if (!sessionPath) return;

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

  /** Returns the session path from the payload, falling back to the active session. */
  private resolveSessionPath(payloadPath?: string): string | undefined {
    return payloadPath ?? store.getState().sessions.activeSession?.path;
  }

  private isActiveSession(sessionPath: string): boolean {
    return store.getState().sessions.activeSession?.path === sessionPath;
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
