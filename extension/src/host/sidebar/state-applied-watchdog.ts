import { recordAckLatency, recordWatchdog } from '../util/stream-telemetry';
import { bootLog } from '../util/audit';

/** Max wait for the webview to acknowledge a posted state revision. */
const STATE_APPLIED_TIMEOUT_MS = 2_500;
/** Limit forced webview reloads when state acknowledgements are missing. */
export const STATE_APPLIED_RELOAD_LIMIT = 2;
/** Rolling window for missing-ack reload throttling. */
export const STATE_APPLIED_RELOAD_WINDOW_MS = 30_000;

/**
 * Dependencies injected by {@link SidebarViewProvider} so the watchdog has no
 * direct dependency on vscode or on the hot-reloader. All collaborators are
 * expressed as plain callbacks/getters, which keeps the unit testable without
 * a vscode host.
 */
export interface StateAppliedWatchdogDeps {
  getWebviewReady(): boolean;
  getViewVisible(): boolean;
  getRunningSessionCount(): number;
  getHostInstanceId(): string;
  /** Re-post the dirty snapshot (resnapshot path). */
  onResnapshot(): void;
  /** Force a webview reload (reload path). */
  onForceReload(revision: number): Promise<void>;
}

/**
 * Tracks the webview's acknowledgement of posted state revisions and forces a
 * resnapshot (then a reload) when acks go missing. Extracted verbatim from
 * {@link SidebarViewProvider}; see that class for the orchestration contract.
 */
export class StateAppliedWatchdog {
  private stateAppliedTimer?: ReturnType<typeof setTimeout>;
  private pendingStateAppliedRevision: number | null = null;
  private pendingStateAppliedArmedAt = 0;
  private lastStateAppliedRevision = -1;
  private lastStateAppliedAt = 0;
  private stateAppliedReloadWindowStartedAt = 0;
  private stateAppliedReloadAttempts = 0;
  private resnapshotAttempted = false;

  constructor(private readonly deps: StateAppliedWatchdogDeps) {}

  recordStateApplied(revision: number): void {
    this.lastStateAppliedRevision = Math.max(this.lastStateAppliedRevision, revision);
    this.lastStateAppliedAt = Date.now();

    if (this.pendingStateAppliedRevision !== null && revision >= this.pendingStateAppliedRevision) {
      if (this.pendingStateAppliedArmedAt > 0) {
        recordAckLatency(Date.now() - this.pendingStateAppliedArmedAt);
      }
      this.clear();
      this.stateAppliedReloadAttempts = 0;
      this.stateAppliedReloadWindowStartedAt = 0;
      this.resnapshotAttempted = false;
    }
  }

  clear(): void {
    if (this.stateAppliedTimer !== undefined) {
      clearTimeout(this.stateAppliedTimer);
      this.stateAppliedTimer = undefined;
    }
    this.pendingStateAppliedRevision = null;
  }

  armStateAppliedWatchdog(revision: number): void {
    if (!this.deps.getWebviewReady() || !this.deps.getViewVisible()) {
      return;
    }

    this.pendingStateAppliedRevision = revision;
    this.pendingStateAppliedArmedAt = Date.now();
    if (this.stateAppliedTimer !== undefined) {
      clearTimeout(this.stateAppliedTimer);
    }

    this.stateAppliedTimer = setTimeout(() => {
      void this.handleStateAppliedTimeout(revision);
    }, STATE_APPLIED_TIMEOUT_MS);
  }

  shouldThrottleStateAppliedReload(now: number): boolean {
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

  /** Reset the first-timeout resnapshot flag (called when the bridge becomes ready). */
  resetResnapshotFlag(): void {
    this.resnapshotAttempted = false;
  }

  getLastStateAppliedRevision(): number {
    return this.lastStateAppliedRevision;
  }

  getPendingStateAppliedRevision(): number | null {
    return this.pendingStateAppliedRevision;
  }

  private async handleStateAppliedTimeout(revision: number): Promise<void> {
    this.stateAppliedTimer = undefined;

    if (this.pendingStateAppliedRevision === null || revision !== this.pendingStateAppliedRevision) {
      return;
    }

    if (this.lastStateAppliedRevision >= revision) {
      this.clear();
      return;
    }

    if (!this.deps.getWebviewReady() || !this.deps.getViewVisible()) {
      return;
    }

    // Re-snapshot-first: before force-reloading the webview HTML, try
    // re-posting the state snapshot. Only reload if the re-snapshot also
    // goes unacked (a consecutive timeout with resnapshotAttempted=true).
    // This avoids reload storms on slow transcripts where the webview is
    // slow to ack but still functional.
    if (!this.resnapshotAttempted) {
      this.resnapshotAttempted = true;
      recordWatchdog('resnapshot');
      bootLog('sidebar-provider', 'stateApplied.timeout.resnapshot', {
        hostInstanceId: this.deps.getHostInstanceId(),
        pendingRevision: revision,
        visible: this.deps.getViewVisible(),
        webviewReady: this.deps.getWebviewReady(),
      });
      this.deps.onResnapshot();
      return;
    }

    // Never force-reload the webview while any session is actively running.
    // Mid-stream reloads discard transient streaming state and frequently
    // leave the UI frozen or split, especially during slow tool calls like
    // ask_user. The first-timeout resnapshot above gives the webview another
    // chance once the current burst of events subsides.
    const runningCount = this.deps.getRunningSessionCount();
    if (runningCount > 0) {
      bootLog('sidebar-provider', 'stateApplied.timeout.streaming.suppressed', {
        hostInstanceId: this.deps.getHostInstanceId(),
        pendingRevision: revision,
        runningCount,
        visible: this.deps.getViewVisible(),
        webviewReady: this.deps.getWebviewReady(),
      });
      return;
    }

    const now = Date.now();
    if (this.shouldThrottleStateAppliedReload(now)) {
      recordWatchdog('throttled');
      bootLog('sidebar-provider', 'stateApplied.timeout.throttled', {
        hostInstanceId: this.deps.getHostInstanceId(),
        lastStateAppliedRevision: this.lastStateAppliedRevision,
        pendingRevision: revision,
        visible: this.deps.getViewVisible(),
        webviewReady: this.deps.getWebviewReady(),
      });
      return;
    }

    recordWatchdog('reload');
    bootLog('sidebar-provider', 'stateApplied.timeout', {
      hostInstanceId: this.deps.getHostInstanceId(),
      lastStateAppliedAt: this.lastStateAppliedAt || null,
      lastStateAppliedRevision: this.lastStateAppliedRevision,
      pendingRevision: revision,
      visible: this.deps.getViewVisible(),
      webviewReady: this.deps.getWebviewReady(),
    });

    this.clear();
    await this.deps.onForceReload(revision);
  }

  dispose(): void {
    this.clear();
    this.lastStateAppliedRevision = -1;
    this.lastStateAppliedAt = 0;
    this.stateAppliedReloadWindowStartedAt = 0;
    this.stateAppliedReloadAttempts = 0;
  }
}