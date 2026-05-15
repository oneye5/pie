import * as crypto from 'node:crypto';

import * as vscode from 'vscode';

import { assertInvariant, auditLog } from './state-audit';
import {
  buildPatchEnvelope,
  buildStateEnvelope,
  canPostToWebview,
  createSidebarSyncState,
  flushDirtySnapshot,
  type SidebarSyncState,
} from './sidebar-sync';
import {
  DEFAULT_WEBVIEW_VIEW_NAME,
  getWebviewAssetDir,
  isHotReloadAssetFileName,
} from './webview-hot-reload';
import { renderWebviewHtml, getWebviewRoots } from './webview-assets';
import type {
  HostToWebviewMessage,
  PatchOp,
  ViewState,
  WebviewToHostMessage,
} from '../shared/protocol';
import { validateWebviewToHostMessage } from '../shared/protocol-validation';

/** Debounce window for batching rapid store changes into a single snapshot post. */
const SCHEDULE_DEBOUNCE_MS = 50;
/** Debounce window for coalescing multiple asset writes into one webview reload. */
const HOT_RELOAD_DEBOUNCE_MS = 120;

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
  }

  async resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    this.view = webviewView;
    this.webviewReady = false;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: getWebviewRoots(this.context),
    };

    this.ensureAssetWatcher();
    webviewView.webview.html = await renderWebviewHtml(this.context, webviewView.webview);

    this.visibilityDisposable?.dispose();
    this.visibilityDisposable = webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.flushDirtyState();
      }
    });

    this.messageDisposable?.dispose();
    this.messageDisposable = webviewView.webview.onDidReceiveMessage((msg: WebviewToHostMessage) => {
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
        this.webviewReady = true;
      }
      this.onMessage(msg);
    });
  }

  /** Show the sidebar panel, preserving editor focus. */
  reveal(): void {
    this.view?.show(true);
  }

  /**
   * Post a full state snapshot immediately. Resets the overlay revision so the
   * webview can rebase its gap-detection counter.
   */
  postState(): void {
    if (this.scheduleTimer !== undefined) {
      clearTimeout(this.scheduleTimer);
      this.scheduleTimer = undefined;
    }

    const previousRevision = this.syncState.revision;
    const result = buildStateEnvelope(
      this.syncState,
      this.getViewState(),
      this.canPostToView(),
    );
    this.syncState = result.nextSyncState;

    auditLog(this.context, 'sidebar-provider', 'snapshot.postState', {
      dirty: this.syncState.dirty,
      posted: !!result.message,
      ready: this.webviewReady,
      revision: this.syncState.revision,
      visible: this.view?.visible ?? false,
    });

    assertInvariant(
      this.context,
      'sidebar-provider',
      !result.message || this.syncState.revision > previousRevision,
      'State snapshots must advance revision monotonically.',
      { previousRevision, nextRevision: this.syncState.revision },
    );

    if (result.message && this.view) {
      void this.view.webview.postMessage(result.message);
    }
  }

  /**
   * Schedule a debounced state snapshot. Multiple rapid calls within the
   * debounce window are collapsed into a single post.
   */
  scheduleState(): void {
    if (!this.canPostToView()) {
      this.syncState = { ...this.syncState, dirty: true };
      auditLog(this.context, 'sidebar-provider', 'snapshot.markDirty', {
        reason: 'scheduleState',
        ready: this.webviewReady,
        revision: this.syncState.revision,
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

  /**
   * Post an incremental patch for high-frequency streaming updates (deltas,
   * thinking tokens, tool call state). Skipped when the view is not visible.
   */
  postPatch(op: PatchOp): void {
    const previousRevision = this.syncState.revision;
    const result = buildPatchEnvelope(this.syncState, op, this.canPostToView());
    this.syncState = result.nextSyncState;

    auditLog(this.context, 'sidebar-provider', 'patch.post', {
      dirty: this.syncState.dirty,
      kind: op.kind,
      posted: !!result.message,
      ready: this.webviewReady,
      revision: this.syncState.revision,
      visible: this.view?.visible ?? false,
    });

    assertInvariant(
      this.context,
      'sidebar-provider',
      !result.message || this.syncState.revision > previousRevision,
      'Patches must advance revision monotonically.',
      { previousRevision, nextRevision: this.syncState.revision, kind: op.kind },
    );

    if (result.message && this.view) {
      void this.view.webview.postMessage(result.message);
    }
  }

  /**
   * Post an imperative message that does not carry a revision. The webview
   * handles these independently from the state/patch flow.
   */
  postImperative(msg: HostToWebviewMessage): void {
    if (!this.view || !this.webviewReady) return;
    void this.view.webview.postMessage(msg);
  }

  private canPostToView(): boolean {
    return this.webviewReady && canPostToWebview(!!this.view, this.view?.visible ?? false);
  }

  private flushDirtyState(): void {
    const result = flushDirtySnapshot(this.syncState, this.getViewState(), this.canPostToView());
    this.syncState = result.nextSyncState;

    auditLog(this.context, 'sidebar-provider', 'snapshot.flushDirty', {
      dirty: this.syncState.dirty,
      posted: !!result.message,
      ready: this.webviewReady,
      revision: this.syncState.revision,
      visible: this.view?.visible ?? false,
    });

    if (result.message && this.view) {
      void this.view.webview.postMessage(result.message);
    }
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
      const nextHtml = await renderWebviewHtml(this.context, view.webview);
      if (this.view !== view) {
        return;
      }

      this.webviewReady = false;
      this.syncState = { ...this.syncState, dirty: true };
      view.webview.html = nextHtml;

      auditLog(this.context, 'sidebar-provider', 'hotReload.apply', {
        changedPath,
        revision: this.syncState.revision,
        visible: view.visible,
      });
    } catch (error) {
      console.warn(`[pie] Failed to hot reload webview assets after ${changedPath}: ${(error as Error).message}`);
    }
  }
}
