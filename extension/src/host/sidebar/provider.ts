import * as crypto from 'node:crypto';

import * as vscode from 'vscode';

import { assertInvariant, auditLog, bootLog } from '../util/audit';
import {
  buildStateEnvelope,
  canPostSnapshotToWebview,
  clearSessionSync,
  createSidebarSyncState,
  flushDirtySnapshot,
  reconcilePostedMessageDelivery,
  type SidebarSyncState,
} from './sync';
import {
  DEFAULT_WEBVIEW_VIEW_NAME,
  getWebviewAssetDir,
  isHotReloadAssetFileName,
} from '../webview/hot-reload';
import { getWebviewAssetVersion, renderWebviewHtml, getWebviewRoots } from '../webview/assets';
import type {
  HostToWebviewMessage,
  ViewState,
  WebviewToHostMessage,
} from '../../shared/protocol';
import { validateWebviewToHostMessage } from '../../shared/protocol-validation';

/** Debounce window for batching rapid store changes into a single snapshot post. */
const SCHEDULE_DEBOUNCE_MS = 50;
/** Debounce window for coalescing multiple asset writes into one webview reload. */
const HOT_RELOAD_DEBOUNCE_MS = 120;
/** Max wait for the webview to acknowledge a posted state revision. */
const STATE_APPLIED_TIMEOUT_MS = 2_500;
/** Limit forced webview reloads when state acknowledgements are missing. */
const STATE_APPLIED_RELOAD_LIMIT = 2;
/** Rolling window for missing-ack reload throttling. */
const STATE_APPLIED_RELOAD_WINDOW_MS = 30_000;

/**
 * Implements the VS Code WebviewView for the pie sidebar.
 *
 * Responsibilities:
 * - Resolves the webview HTML once and handles incoming messages.
 * - Posts full-state snapshots (`state`) on demand or on a debounced schedule.
 * - Posts incremental `patch` messages for high-frequency streaming updates.
 * - Posts imperative messages (e.g. `sendRejected`) outside the state flow.
 *
 * Each outgoing envelope carries a monotonically increasing `revision` and a
 * stable `hostInstanceId` so the webview can detect missed patches and
 * host-side counter resets.
 */
export class SidebarViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private readonly hostInstanceId: string;
  private syncState: SidebarSyncState;
  private visibilityDisposable?: vscode.Disposable;
  private scheduleTimer?: ReturnType<typeof setTimeout>;
  private hotReloadTimer?: ReturnType<typeof setTimeout>;
  private messageDisposable?: vscode.Disposable;
  private assetWatcher?: vscode.FileSystemWatcher;
  private webviewReady = false;
  private currentAssetVersion: string | null = null;
  private reloadingForAssetMismatch = false;
  private reloadingForStateAppliedTimeout = false;
  private stateAppliedTimer?: ReturnType<typeof setTimeout>;
  private pendingStateAppliedRevision: number | null = null;
  private lastStateAppliedRevision = -1;
  private lastStateAppliedAt = 0;
  private stateAppliedReloadWindowStartedAt = 0;
  private stateAppliedReloadAttempts = 0;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly getViewState: () => ViewState,
    private readonly onMessage: (msg: WebviewToHostMessage) => void,
  ) {
    this.hostInstanceId = crypto.randomUUID();
    this.syncState = createSidebarSyncState(this.hostInstanceId);
  }

  dispose(): void {
    if (this.scheduleTimer !== undefined) {
      clearTimeout(this.scheduleTimer);
      this.scheduleTimer = undefined;
    }
    if (this.hotReloadTimer !== undefined) {
      clearTimeout(this.hotReloadTimer);
      this.hotReloadTimer = undefined;
    }
    this.webviewReady = false;
    this.visibilityDisposable?.dispose();
    this.messageDisposable?.dispose();
    this.assetWatcher?.dispose();
    this.currentAssetVersion = null;
    this.reloadingForAssetMismatch = false;
    this.reloadingForStateAppliedTimeout = false;
    this.clearStateAppliedWatchdog();
    this.lastStateAppliedRevision = -1;
    this.lastStateAppliedAt = 0;
    this.stateAppliedReloadWindowStartedAt = 0;
    this.stateAppliedReloadAttempts = 0;
  }

  async resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    this.view = webviewView;
    this.webviewReady = false;
    this.reloadingForAssetMismatch = false;
    this.reloadingForStateAppliedTimeout = false;
    this.clearStateAppliedWatchdog();

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: getWebviewRoots(this.context),
    };

    this.currentAssetVersion = await getWebviewAssetVersion(this.context);

    bootLog('sidebar-provider', 'view.resolved', {
      hostInstanceId: this.hostInstanceId,
      visible: webviewView.visible,
      webviewReady: this.webviewReady,
    });

    this.messageDisposable?.dispose();
    this.messageDisposable = webviewView.webview.onDidReceiveMessage((msg: WebviewToHostMessage) => {
      const incomingAssetVersion = this.getIncomingAssetVersion(msg);
      if (this.shouldReloadForAssetMismatch(msg, incomingAssetVersion)) {
        bootLog('sidebar-provider', 'assetVersion.mismatch', {
          actualAssetVersion: incomingAssetVersion ?? null,
          expectedAssetVersion: this.currentAssetVersion,
          hostInstanceId: this.hostInstanceId,
          type: msg.type,
          visible: this.view?.visible ?? false,
        });
        void this.reloadForAssetMismatch();
        return;
      }

      if (msg.type === 'stateApplied') {
        const payload = msg.payload as any;
        if (payload.renderError) {
          bootLog('sidebar-provider', 'webview.renderError', { error: payload.renderError });
        }
        this.recordStateApplied(msg.payload.revision);
      }

      if (!this.webviewReady) {
        this.webviewReady = true;
        bootLog('sidebar-provider', 'message.bridgeReady', {
          hostInstanceId: this.hostInstanceId,
          type: msg.type,
          visible: this.view?.visible ?? false,
        });
      }

      // Audit-only validation: log invalid envelopes but still pass through so
      // unrecognised future additions don't break older host builds. Promote
      // to rejection once the audit log is clean.
      const validation = validateWebviewToHostMessage(msg);
      if (!validation.ok) {
        auditLog(this.context, 'sidebar-provider', 'message.invalid', {
          reason: validation.reason,
          type: (msg as { type?: unknown })?.type ?? null,
        });
      }
      if (msg.type === 'ready') {
        bootLog('sidebar-provider', 'message.ready', {
          hostInstanceId: this.hostInstanceId,
          visible: this.view?.visible ?? false,
        });
      } else if (msg.type === 'refreshState' || msg.type === 'requestSnapshot') {
        bootLog('sidebar-provider', `message.${msg.type}`, {
          hostInstanceId: this.hostInstanceId,
          visible: this.view?.visible ?? false,
          webviewReady: this.webviewReady,
        });
      }
      this.onMessage(msg);
    });

    this.visibilityDisposable?.dispose();
    this.visibilityDisposable = webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.flushDirtyState();
      }
    });

    this.ensureAssetWatcher();
    webviewView.webview.html = await renderWebviewHtml(
      this.context,
      webviewView.webview,
      this.currentAssetVersion ?? undefined,
    );

    // Cold-start restore can accumulate a fully loaded dirty snapshot before
    // the view is resolved. Flush it as soon as the HTML is assigned so the
    // fresh webview does not depend on an inbound handshake to escape the
    // initial loading shell.
    this.flushDirtyState();
  }

  /** Show the sidebar panel, preserving editor focus. */
  reveal(): void {
    if (this.view) {
      this.view.show(true);
      return;
    }

    void vscode.commands.executeCommand('workbench.view.extension.pie');
  }

  getDebugState(): {
    hasView: boolean;
    visible: boolean;
    webviewReady: boolean;
    globalDirty: boolean;
    globalRevision: number;
    lastStateAppliedRevision: number;
    pendingStateAppliedRevision: number | null;
    hostInstanceId: string;
  } {
    return {
      hasView: !!this.view,
      visible: this.view?.visible ?? false,
      webviewReady: this.webviewReady,
      globalDirty: this.syncState.globalDirty,
      globalRevision: this.syncState.globalRevision,
      lastStateAppliedRevision: this.lastStateAppliedRevision,
      pendingStateAppliedRevision: this.pendingStateAppliedRevision,
      hostInstanceId: this.hostInstanceId,
    };
  }

  /**
   * Post a full state snapshot immediately. Resets per-session revisions so
   * the webview can rebase its mirrors from the snapshot.
   */
  postState(): void {
    if (this.scheduleTimer !== undefined) {
      clearTimeout(this.scheduleTimer);
      this.scheduleTimer = undefined;
    }

    const previousRevision = this.syncState.globalRevision;
    const result = buildStateEnvelope(
      this.syncState,
      this.getViewState(),
      this.canPostSnapshotToView(),
    );
    this.syncState = result.nextSyncState;

    const viewState = this.getViewState();

    auditLog(this.context, 'sidebar-provider', 'snapshot.postState', {
      globalDirty: this.syncState.globalDirty,
      posted: !!result.message,
      ready: this.webviewReady,
      revision: this.syncState.globalRevision,
      visible: this.view?.visible ?? false,
    });

    bootLog('sidebar-provider', 'snapshot.postState', {
      activeSessionPath: viewState.activeSession?.path ?? null,
      backendReady: viewState.backendReady,
      globalDirty: this.syncState.globalDirty,
      notice: viewState.notice,
      openTabCount: viewState.openTabPaths.length,
      posted: !!result.message,
      ready: this.webviewReady,
      revision: this.syncState.globalRevision,
      transcriptLoaded: viewState.transcriptLoaded,
      visible: this.view?.visible ?? false,
    });

    assertInvariant(
      this.context,
      'sidebar-provider',
      !result.message || this.syncState.globalRevision > previousRevision,
      'State snapshots must advance revision monotonically.',
      { previousRevision, nextRevision: this.syncState.globalRevision },
    );

    if (result.message && this.view) {
      this.postToWebview(result.message);
    }
  }

  /**
   * Schedule a debounced state snapshot. Multiple rapid calls within the
   * debounce window are collapsed into a single post.
   */
  scheduleState(): void {
    if (!this.canPostSnapshotToView()) {
      this.syncState = { ...this.syncState, globalDirty: true };
      auditLog(this.context, 'sidebar-provider', 'snapshot.markDirty', {
        reason: 'scheduleState',
        ready: this.webviewReady,
        revision: this.syncState.globalRevision,
        visible: this.view?.visible ?? false,
      });
      const viewState = this.getViewState();
      bootLog('sidebar-provider', 'snapshot.markDirty', {
        activeSessionPath: viewState.activeSession?.path ?? null,
        backendReady: viewState.backendReady,
        globalDirty: this.syncState.globalDirty,
        notice: viewState.notice,
        openTabCount: viewState.openTabPaths.length,
        ready: this.webviewReady,
        revision: this.syncState.globalRevision,
        visible: this.view?.visible ?? false,
      });
      return;
    }

    if (this.scheduleTimer !== undefined) {
      return;
    }

    this.scheduleTimer = setTimeout(() => {
      this.scheduleTimer = undefined;
      this.postState();
    }, SCHEDULE_DEBOUNCE_MS);
  }

  /** Drop sync bookkeeping for a session that was closed or invalidated. */
  clearSessionSync(sessionPath: string): void {
    this.syncState = clearSessionSync(this.syncState, sessionPath);
  }

  /**
   * Post an imperative message that does not carry a revision. The webview
   * handles these independently from the state/patch flow.
   */
  postImperative(msg: HostToWebviewMessage): void {
    if (!this.view || !this.webviewReady) return;
    this.postToWebview(msg);
  }

  private canPostSnapshotToView(): boolean {
    return canPostSnapshotToWebview(!!this.view, this.webviewReady);
  }

  private flushDirtyState(): void {
    const result = flushDirtySnapshot(this.syncState, this.getViewState(), this.canPostSnapshotToView());
    this.syncState = result.nextSyncState;

    const viewState = this.getViewState();

    auditLog(this.context, 'sidebar-provider', 'snapshot.flushDirty', {
      globalDirty: this.syncState.globalDirty,
      posted: !!result.message,
      ready: this.webviewReady,
      revision: this.syncState.globalRevision,
      visible: this.view?.visible ?? false,
    });

    bootLog('sidebar-provider', 'snapshot.flushDirty', {
      activeSessionPath: viewState.activeSession?.path ?? null,
      backendReady: viewState.backendReady,
      globalDirty: this.syncState.globalDirty,
      notice: viewState.notice,
      openTabCount: viewState.openTabPaths.length,
      posted: !!result.message,
      ready: this.webviewReady,
      revision: this.syncState.globalRevision,
      transcriptLoaded: viewState.transcriptLoaded,
      visible: this.view?.visible ?? false,
    });

    if (result.message && this.view) {
      this.postToWebview(result.message);
    }
  }

  private postToWebview(message: HostToWebviewMessage): void {
    const view = this.view;
    if (!view) {
      return;
    }

    void Promise.resolve(view.webview.postMessage(message))
      .then((delivered) => {
        this.syncState = reconcilePostedMessageDelivery(this.syncState, message, delivered);
        if (delivered && message.type === 'state') {
          this.armStateAppliedWatchdog(message.revision);
        }
        if (!delivered) {
          bootLog('sidebar-provider', 'message.deliveryFailed', {
            hostInstanceId: this.hostInstanceId,
            messageType: message.type,
            revision: message.type === 'state' || message.type === 'patch' ? message.revision : null,
            sessionPath: message.type === 'patch' ? message.sessionPath : null,
            visible: this.view?.visible ?? false,
            webviewReady: this.webviewReady,
          });
        }
      })
      .catch((error: unknown) => {
        this.syncState = reconcilePostedMessageDelivery(this.syncState, message, false);
        console.warn(`[pie] Failed to post ${message.type} message to webview: ${(error as Error).message}`);
      });
  }

  private recordStateApplied(revision: number): void {
    this.lastStateAppliedRevision = Math.max(this.lastStateAppliedRevision, revision);
    this.lastStateAppliedAt = Date.now();

    if (this.pendingStateAppliedRevision !== null && revision >= this.pendingStateAppliedRevision) {
      this.clearStateAppliedWatchdog();
      this.stateAppliedReloadAttempts = 0;
      this.stateAppliedReloadWindowStartedAt = 0;
    }
  }

  private clearStateAppliedWatchdog(): void {
    if (this.stateAppliedTimer !== undefined) {
      clearTimeout(this.stateAppliedTimer);
      this.stateAppliedTimer = undefined;
    }
    this.pendingStateAppliedRevision = null;
  }

  private armStateAppliedWatchdog(revision: number): void {
    if (!this.webviewReady || !this.view?.visible) {
      return;
    }

    this.pendingStateAppliedRevision = revision;
    if (this.stateAppliedTimer !== undefined) {
      clearTimeout(this.stateAppliedTimer);
    }

    this.stateAppliedTimer = setTimeout(() => {
      void this.handleStateAppliedTimeout(revision);
    }, STATE_APPLIED_TIMEOUT_MS);
  }

  private shouldThrottleStateAppliedReload(now: number): boolean {
    if (
      this.stateAppliedReloadWindowStartedAt === 0
      || now - this.stateAppliedReloadWindowStartedAt > STATE_APPLIED_RELOAD_WINDOW_MS
    ) {
      this.stateAppliedReloadWindowStartedAt = now;
      this.stateAppliedReloadAttempts = 0;
    }

    if (this.stateAppliedReloadAttempts >= STATE_APPLIED_RELOAD_LIMIT) {
      return true;
    }

    this.stateAppliedReloadAttempts += 1;
    return false;
  }

  private async handleStateAppliedTimeout(revision: number): Promise<void> {
    this.stateAppliedTimer = undefined;

    if (this.pendingStateAppliedRevision === null || revision !== this.pendingStateAppliedRevision) {
      return;
    }

    if (this.lastStateAppliedRevision >= revision) {
      this.clearStateAppliedWatchdog();
      return;
    }

    if (!this.webviewReady || !this.view?.visible) {
      return;
    }

    const now = Date.now();
    if (this.shouldThrottleStateAppliedReload(now)) {
      bootLog('sidebar-provider', 'stateApplied.timeout.throttled', {
        hostInstanceId: this.hostInstanceId,
        lastStateAppliedRevision: this.lastStateAppliedRevision,
        pendingRevision: revision,
        visible: this.view.visible,
        webviewReady: this.webviewReady,
      });
      return;
    }

    bootLog('sidebar-provider', 'stateApplied.timeout', {
      hostInstanceId: this.hostInstanceId,
      lastStateAppliedAt: this.lastStateAppliedAt || null,
      lastStateAppliedRevision: this.lastStateAppliedRevision,
      pendingRevision: revision,
      visible: this.view.visible,
      webviewReady: this.webviewReady,
    });

    this.clearStateAppliedWatchdog();
    await this.reloadForStateAppliedTimeout(revision);
  }

  private ensureAssetWatcher(): void {
    if (this.assetWatcher) {
      return;
    }

    const assetDir = getWebviewAssetDir(this.context.extensionPath, DEFAULT_WEBVIEW_VIEW_NAME);
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(assetDir), '*'),
    );
    const onAssetEvent = (uri: vscode.Uri) => {
      if (!isHotReloadAssetFileName(uri.fsPath, DEFAULT_WEBVIEW_VIEW_NAME)) {
        return;
      }
      this.scheduleHotReload(uri.fsPath);
    };

    watcher.onDidChange(onAssetEvent);
    watcher.onDidCreate(onAssetEvent);
    watcher.onDidDelete(onAssetEvent);

    this.assetWatcher = watcher;
  }

  private scheduleHotReload(changedPath: string): void {
    if (this.hotReloadTimer !== undefined) {
      clearTimeout(this.hotReloadTimer);
    }

    auditLog(this.context, 'sidebar-provider', 'hotReload.schedule', {
      changedPath,
      visible: this.view?.visible ?? false,
    });

    this.hotReloadTimer = setTimeout(() => {
      this.hotReloadTimer = undefined;
      void this.reloadWebviewAssets(changedPath);
    }, HOT_RELOAD_DEBOUNCE_MS);
  }

  private async reloadWebviewAssets(changedPath: string): Promise<void> {
    const view = this.view;
    if (!view) {
      return;
    }

    try {
      const nextAssetVersion = await getWebviewAssetVersion(this.context);
      const nextHtml = await renderWebviewHtml(this.context, view.webview, nextAssetVersion);
      if (this.view !== view) {
        return;
      }

      this.currentAssetVersion = nextAssetVersion;
      this.webviewReady = false;
      this.syncState = { ...this.syncState, globalDirty: true };
      this.clearStateAppliedWatchdog();
      view.webview.html = nextHtml;
      this.reloadingForAssetMismatch = false;
      this.reloadingForStateAppliedTimeout = false;

      auditLog(this.context, 'sidebar-provider', 'hotReload.apply', {
        changedPath,
        revision: this.syncState.globalRevision,
        visible: view.visible,
      });
    } catch (error) {
      this.reloadingForAssetMismatch = false;
      this.reloadingForStateAppliedTimeout = false;
      console.warn(`[pie] Failed to hot reload webview assets after ${changedPath}: ${(error as Error).message}`);
    }
  }

  private getIncomingAssetVersion(msg: WebviewToHostMessage): string | null {
    if (msg.type === 'ready' || msg.type === 'refreshState' || msg.type === 'requestSnapshot') {
      return msg.assetVersion ?? null;
    }

    return null;
  }

  private shouldReloadForAssetMismatch(
    msg: WebviewToHostMessage,
    assetVersion: string | null,
  ): boolean {
    if (!this.currentAssetVersion) {
      return false;
    }

    if (msg.type !== 'ready' && msg.type !== 'refreshState' && msg.type !== 'requestSnapshot') {
      return false;
    }

    return assetVersion !== this.currentAssetVersion;
  }

  private async reloadForAssetMismatch(): Promise<void> {
    if (this.reloadingForAssetMismatch || this.reloadingForStateAppliedTimeout) {
      return;
    }

    this.reloadingForAssetMismatch = true;
    this.webviewReady = false;
    this.syncState = { ...this.syncState, globalDirty: true };
    await this.reloadWebviewAssets('assetVersionMismatch');
  }

  private async reloadForStateAppliedTimeout(revision: number): Promise<void> {
    if (this.reloadingForAssetMismatch || this.reloadingForStateAppliedTimeout) {
      return;
    }

    this.reloadingForStateAppliedTimeout = true;
    this.webviewReady = false;
    this.syncState = { ...this.syncState, globalDirty: true };
    await this.reloadWebviewAssets(`stateAppliedTimeout:${revision}`);
  }
}
