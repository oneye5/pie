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
import { renderWebviewHtml, getWebviewRoots } from './webview-assets';
import type {
  PatchOp,
  ViewState,
  WebviewToHostMessage,
} from '../shared/protocol';

/** Debounce window for batching rapid store changes into a single snapshot post. */
const SCHEDULE_DEBOUNCE_MS = 50;

/**
 * Implements the VS Code WebviewView for the PI Assistant sidebar.
 *
 * Responsibilities:
 * - Resolves the webview HTML once and handles incoming messages.
 * - Posts full-state snapshots (`state`) on demand or on a debounced schedule.
 * - Posts incremental `patch` messages for high-frequency streaming updates.
 * - Posts imperative messages (e.g. `filePickerResult`) outside the state flow.
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
  private messageDisposable?: vscode.Disposable;

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
    this.visibilityDisposable?.dispose();
    this.messageDisposable?.dispose();
  }

  async resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: getWebviewRoots(this.context),
    };

    webviewView.webview.html = await renderWebviewHtml(this.context, webviewView.webview);

    this.visibilityDisposable?.dispose();
    this.visibilityDisposable = webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.flushDirtyState();
      }
    });

    this.messageDisposable?.dispose();
    this.messageDisposable = webviewView.webview.onDidReceiveMessage((msg: WebviewToHostMessage) => {
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
        revision: this.syncState.revision,
        visible: this.view?.visible ?? false,
      });
      return;
    }

    if (this.scheduleTimer !== undefined) {
      clearTimeout(this.scheduleTimer);
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
   * Post an imperative message that does not carry a revision (e.g. file picker
   * results). The webview handles these independently from the state/patch flow.
   */
  postImperative(msg: HostToWebviewMessage): void {
    if (!this.view) return;
    void this.view.webview.postMessage(msg);
  }

  private canPostToView(): boolean {
    return canPostToWebview(!!this.view, this.view?.visible ?? false);
  }

  private flushDirtyState(): void {
    const result = flushDirtySnapshot(this.syncState, this.getViewState(), this.canPostToView());
    this.syncState = result.nextSyncState;

    auditLog(this.context, 'sidebar-provider', 'snapshot.flushDirty', {
      dirty: this.syncState.dirty,
      posted: !!result.message,
      revision: this.syncState.revision,
      visible: this.view?.visible ?? false,
    });

    if (result.message && this.view) {
      void this.view.webview.postMessage(result.message);
    }
  }
}
