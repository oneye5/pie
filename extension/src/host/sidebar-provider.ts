import * as crypto from 'node:crypto';

import * as vscode from 'vscode';

import { renderWebviewHtml, getWebviewRoots } from './webview-assets';
import type {
  HostToWebviewMessage,
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
  private revision = 0;
  private readonly hostInstanceId: string;
  private scheduleTimer?: ReturnType<typeof setTimeout>;
  private messageDisposable?: vscode.Disposable;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly getViewState: () => ViewState,
    private readonly onMessage: (msg: WebviewToHostMessage) => void,
  ) {
    this.hostInstanceId = crypto.randomUUID();
  }

  dispose(): void {
    if (this.scheduleTimer !== undefined) {
      clearTimeout(this.scheduleTimer);
      this.scheduleTimer = undefined;
    }
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
    if (!this.view) return;

    this.revision += 1;
    const msg: HostToWebviewMessage = {
      type: 'state',
      hostInstanceId: this.hostInstanceId,
      revision: this.revision,
      state: this.getViewState(),
    };

    void this.view.webview.postMessage(msg);
  }

  /**
   * Schedule a debounced state snapshot. Multiple rapid calls within the
   * debounce window are collapsed into a single post.
   */
  scheduleState(): void {
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
    if (!this.view) return;

    this.revision += 1;
    const msg: HostToWebviewMessage = {
      type: 'patch',
      hostInstanceId: this.hostInstanceId,
      revision: this.revision,
      op,
    };

    void this.view.webview.postMessage(msg);
  }

  /**
   * Post an imperative message that does not carry a revision (e.g. file picker
   * results). The webview handles these independently from the state/patch flow.
   */
  postImperative(msg: HostToWebviewMessage): void {
    if (!this.view) return;
    void this.view.webview.postMessage(msg);
  }
}
