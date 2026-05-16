import * as vscode from 'vscode';

import { BackendClient } from '../backend-client';
import { resolveChatPrefs } from '../../shared/protocol';
import {
  sessionsActions,
  store,
  uiActions,
} from '../store';
import { NOOP_RUN_OBSERVER, type RunObserver } from '../stats-service';
import { SessionServiceEvents } from './events';
import { SessionMessageActions } from './message-actions';
import { SessionServiceState } from './state';
import { startSessionBackend } from './startup';
import { SessionTabActions } from './tab-actions';
import type {
  OnSessionCompleted,
  PostImperative,
  PostPatch,
  ScheduleRender,
} from './types';
import type { ChatPrefs, ComposerInputDraft, ThinkingLevel } from '../../shared/protocol';

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
    postPatch: PostPatch,
    postImperative: PostImperative,
    onSessionCompleted?: OnSessionCompleted,
    runObserver: RunObserver = NOOP_RUN_OBSERVER,
  ) {
    this.state = new SessionServiceState(context, backend, scheduleRender);
    this.events = new SessionServiceEvents({
      context,
      scheduleRender,
      postPatch,
      onSessionCompleted,
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

  moveSessionTab(sessionPath: string | undefined, fromIndex: number, toIndex: number): void {
    this.tabs.moveSessionTab(sessionPath, fromIndex, toIndex);
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

  async send(text: string): Promise<void> {
    await this.messages.send(text);
  }

  async editMessage(messageId: string, text: string): Promise<void> {
    await this.messages.editMessage(messageId, text);
  }

  async interrupt(): Promise<void> {
    await this.messages.interrupt();
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
    }).catch(() => {
      // Non-fatal: the backend may be restarting or may not support runtime prefs yet.
    });
  }
}
