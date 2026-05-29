import * as vscode from 'vscode';

import { BackendClient } from '../backend/client';
import { resolveChatPrefs } from '../../shared/protocol';
import type { ChatPrefs, ComposerInputDraft, PruningSettings, ThinkingLevel } from '../../shared/protocol';
import {
  sessionsActions,
  settingsActions,
  store,
  uiActions,
} from '../store';
import { readPruningSettings, writePruningSettings } from './pruning-settings';
import { NOOP_RUN_OBSERVER, type RunObserver } from '../stats-service';
import { SessionServiceEvents } from './events';
import { SessionMessageActions } from './message-actions';
import { SessionServiceState } from './state';
import { startSessionBackend } from './startup';
import { SessionTabActions } from './tab-actions';
import type {
  DispatchArchEvent,
  OnSessionCompleted,
  OnSessionPathResolved,
  PostImperative,
  ScheduleRender,
} from './types';

const PREFS_STORAGE_KEY = 'chatPrefs';

/**
 * Owns the PI backend process lifecycle and wires backend events to the Redux
 * store. All session commands (create, open, close, send, interrupt, etc.) go
 * through this service.
 */
export class SessionService implements vscode.Disposable {
  private readonly state: SessionServiceState;
  private readonly events: SessionServiceEvents;
  private readonly tabs: SessionTabActions;
  private readonly messages: SessionMessageActions;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly backend: BackendClient,
    private readonly scheduleRender: ScheduleRender,
    postImperative: PostImperative,
    onSessionCompleted?: OnSessionCompleted,
    runObserver: RunObserver = NOOP_RUN_OBSERVER,
    onSessionPathResolved?: OnSessionPathResolved,
  ) {
    this.state = new SessionServiceState(context, backend, scheduleRender);
    this.events = new SessionServiceEvents({
      context,
      scheduleRender,
      onSessionCompleted,
      onSessionPathResolved,
      runObserver,
      state: this.state,
    });
    this.tabs = new SessionTabActions({
      context,
      backend,
      scheduleRender,
      runObserver,
      state: this.state,
    });
    this.messages = new SessionMessageActions({
      context,
      backend,
      scheduleRender,
      postImperative,
      runObserver,
      state: this.state,
      createNewSession: () => this.tabs.createNewSession(),
    });
    this.state.setPreloadedSessionOpenedHandler((payload) => {
      this.events.applySessionOpened(payload);
    });
  }

  async start(): Promise<void> {
    await startSessionBackend({
      context: this.context,
      backend: this.backend,
      scheduleRender: this.scheduleRender,
      events: this.events,
      state: this.state,
      openSession: (sessionPath) => this.tabs.openSession(sessionPath),
    });
  }

  /** Expose queue routing for the Phase 3 EffectRunner. */
  get queues(): { enqueueLifecycle: SessionServiceState['enqueueLifecycle']; enqueueSessionOperation: SessionServiceState['enqueueSessionOperation'] } {
    return {
      enqueueLifecycle: (task) => this.state.enqueueLifecycle(task),
      enqueueSessionOperation: (sessionPath, task) => this.state.enqueueSessionOperation(sessionPath, task),
    };
  }

  /** Wire the arch-reducer dispatch path for backend events (Phase 5). */
  setArchDispatch(dispatch: DispatchArchEvent): void {
    this.events.setArchDispatch(dispatch);
  }

  /** Expose completion-notification suppression for interrupt (Phase 3). */
  suppressNextCompletionNotificationFor(sessionPath: string): void {
    this.state.suppressNextCompletionNotificationFor(sessionPath);
  }

  /** Bind a backend request ID to a session path (Phase 4). */
  bindRequestSessionPath(requestId: string, sessionPath: string): void {
    this.state.bindRequestSessionPath(requestId, sessionPath);
  }

  /** Bump the data epoch for a session (Phase 4, pre-send/edit). */
  bumpSessionDataEpoch(sessionPath: string): void {
    this.state.bumpSessionDataEpoch(sessionPath);
  }

  async restart(): Promise<void> {
    this.events.detach();
    await this.backend.stop();
    this.state.resetRuntimeState();
    store.dispatch(sessionsActions.clearRunningPaths());
    store.dispatch(uiActions.setBackendReady(false));
    store.dispatch(uiActions.setNotice(null));
    this.scheduleRender();
    await this.start();
  }

  dispose(): void {
    this.events.detach();
  }

  createNewSession(): string {
    return this.tabs.createNewSession();
  }

  openSession(sessionPath: string): void {
    this.tabs.openSession(sessionPath);
  }

  async closeSession(sessionPath: string): Promise<void> {
    await this.tabs.closeSession(sessionPath);
  }

  /** Drop per-session state held inside the service (called after closeSession). */
  dropSessionLocalState(sessionPath: string): void {
    this.messages.dropSessionLocalState(sessionPath);
  }

  moveSessionTab(sessionPath: string | undefined, fromIndex: number, toIndex: number): void {
    this.tabs.moveSessionTab(sessionPath, fromIndex, toIndex);
  }

  duplicateSession(sessionPath: string): void {
    this.tabs.duplicateSession(sessionPath);
  }

  async addFilesystemPaths(
    requestedSessionPath: string | undefined,
    paths: string[],
    source: 'picker' | 'drop',
  ): Promise<void> {
    await this.messages.addFilesystemPaths(requestedSessionPath, paths, source);
  }

  async addComposerInput(
    requestedSessionPath: string | undefined,
    inputDraft: ComposerInputDraft,
  ): Promise<void> {
    await this.messages.addComposerInput(requestedSessionPath, inputDraft);
  }

  removeComposerInput(requestedSessionPath: string | undefined, inputId: string): void {
    this.messages.removeComposerInput(requestedSessionPath, inputId);
  }

  /** @deprecated Phase 4: send now routes through the CQRS spine. */
  async send(sessionPath: string, text: string): Promise<void> {
    await this.messages.send(sessionPath, text);
  }

  /** @deprecated Phase 4: editMessage now routes through the CQRS spine. */
  async editMessage(sessionPath: string, messageId: string, text: string): Promise<void> {
    await this.messages.editMessage(sessionPath, messageId, text);
  }

  /**
   * @deprecated Phase 3: interrupt now routes through the CQRS spine.
   * See extension-host.ts handleWebviewMessage → dispatchArchEvent.
   */
  async interrupt(sessionPath: string): Promise<void> {
    await this.messages.interrupt(sessionPath);
  }

  async loadOlderTranscript(sessionPath?: string): Promise<void> {
    await this.messages.loadOlderTranscript(sessionPath);
  }

  async loadNewerTranscript(sessionPath?: string): Promise<void> {
    await this.messages.loadNewerTranscript(sessionPath);
  }

  async jumpToLatestTranscript(sessionPath?: string): Promise<void> {
    await this.messages.jumpToLatestTranscript(sessionPath);
  }

  async setModel(
    requestedSessionPath: string | undefined,
    defaultModel: string,
    defaultThinkingLevel: ThinkingLevel,
  ): Promise<void> {
    await this.messages.setModel(requestedSessionPath, defaultModel, defaultThinkingLevel);
  }

  async hydrateModelState(sessionPath: string): Promise<void> {
    await this.messages.hydrateModelState(sessionPath);
  }

  normalizeAttachUris(uris: vscode.Uri[]): vscode.Uri[] {
    return this.messages.normalizeAttachUris(uris);
  }

  setPrefs(prefs: Partial<ChatPrefs>): void {
    const current = store.getState().ui.prefs;
    // Deep-merge toggle maps so partial patches don't discard existing entries.
    const deepMerged: Partial<ChatPrefs> = {
      ...prefs,
      ...(prefs.extensionToggles && {
        extensionToggles: { ...current.extensionToggles, ...prefs.extensionToggles },
      }),
      ...(prefs.providerToggles && {
        providerToggles: { ...current.providerToggles, ...prefs.providerToggles },
      }),
    };
    const merged = resolveChatPrefs({ ...current, ...deepMerged });
    store.dispatch(uiActions.setPrefs(merged));
    if (merged.suppressCompletionNotifications) {
      store.dispatch(sessionsActions.clearUnreadFinishedSessions());
    }
    void this.context.globalState.update(PREFS_STORAGE_KEY, merged);
    void this.backend.request('runtimePrefs.set', {
      providerToggles: merged.providerToggles,
      extensionToggles: merged.extensionToggles,
    }).catch(() => {
      // Non-fatal: the backend may be restarting or may not support runtime prefs yet.
    });
  }

  async setPruningSettings(updates: Partial<PruningSettings>): Promise<void> {
    try {
      const result = await writePruningSettings(updates);
      store.dispatch(settingsActions.setPruningSettings(result));
    } catch (error) {
      const message = `Failed to update pruning settings: ${(error as Error).message}`;
      console.warn(`[pie] ${message}`);
      // Surface the failure in the UI — a silent console.warn after a user
      // action makes the GUI look broken ("I flipped the toggle and nothing
      // happened"). The notice gives the user something to debug from.
      store.dispatch(uiActions.setNotice(message));
    }
  }

  async loadPruningSettings(): Promise<void> {
    try {
      const settings = await readPruningSettings();
      store.dispatch(settingsActions.setPruningSettings(settings));
    } catch {
      // Non-fatal; defaults already in store.
    }
  }
}
