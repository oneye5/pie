import type { ArchState } from './reducer';
import type { Event } from './events';
import type { SessionSummary } from '../../shared/protocol';

export interface QueueManagerDeps {
  dispatchEvent: (event: Event) => void;
  getArchState: () => ArchState;
  scheduleRender: () => void;
  deriveSessionNameFromText: (text: string) => { name: string; isPlaceholder: boolean };
}

export interface QueuedBackendReadySend {
  sessionPath: string;
  text: string;
  localId?: string;
  queuedAt: number;
}

/**
 * Manages the backend-ready send queue for sessions whose backend is not yet
 * ready. (The pending-send queue was collapsed into ArchState in Phase 3 —
 * the reducer owns `pending.sendQueueBySession` and emits a
 * `DrainPendingSendQueue` effect on `PendingPathReplaced`.)
 */
export class QueueManager {
  private readonly backendReadyQueue: QueuedBackendReadySend[] = [];

  private static readonly BACKEND_READY_QUEUE_TIMEOUT_MS = 30_000;
  private backendReadyQueueWatchdog: NodeJS.Timeout | null = null;

  constructor(
    private readonly deps: QueueManagerDeps,
    private readonly handleMessage: (msg: { type: 'send'; sessionPath: string; text: string; localId?: string }) => Promise<void>,
  ) {}

  /**
   * Enqueue a send for a session before the backend is ready.
   * Also inserts an optimistic message and derives session name.
   */
  enqueueBackendReadySend(sessionPath: string, message: { text: string; localId?: string }): void {
    const { text, localId } = message;
    const resolvedLocalId = localId ?? `local:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    this.backendReadyQueue.push({ sessionPath, text, localId: resolvedLocalId, queuedAt: Date.now() });
    this.startWatchdog();

    // Insert optimistic user message
    this.deps.dispatchEvent({
      kind: 'OptimisticMessageInserted',
      sessionPath,
      localId: resolvedLocalId,
      text,
      timestamp: Date.now(),
    });

    // Derive optimistic session name
    const session = this.getSessionByPath(sessionPath);
    if (session?.isPlaceholder) {
      const derived = this.deps.deriveSessionNameFromText(text);
      if (!derived.isPlaceholder && derived.name !== session.name) {
        this.deps.dispatchEvent({ kind: 'SessionNameDerived', sessionPath, name: derived.name });
      }
    }

    this.deps.scheduleRender();
  }

  /**
   * Drain all queued sends waiting for backend readiness.
   * Re-dispatches each through the normal message handling flow.
   */
  async drainBackendReadyQueue(): Promise<void> {
    const queued = this.backendReadyQueue.splice(0);
    this.clearWatchdog();
    if (queued.length === 0) return;

    for (const entry of queued) {
      await this.handleMessage({ type: 'send', sessionPath: entry.sessionPath, text: entry.text, localId: entry.localId });
    }
  }

  /**
   * Remove all queued sends for a session from both queues.
   */
  purgeHostStateForSession(sessionPath: string): void {
    // Rebuild the backendReadyQueue without entries for the closing session
    for (let i = this.backendReadyQueue.length - 1; i >= 0; i--) {
      if (this.backendReadyQueue[i]?.sessionPath === sessionPath) {
        this.backendReadyQueue.splice(i, 1);
      }
    }
    if (this.backendReadyQueue.length === 0) {
      this.clearWatchdog();
    }
  }

  /**
   * Check if there are any queued sends waiting for backend readiness.
   */
  hasBackendReadyQueue(): boolean {
    return this.backendReadyQueue.length > 0;
  }

  /**
   * Start the watchdog timer that will drop queued messages if the backend
   * does not become ready within the timeout.
   */
  startWatchdog(): void {
    if (this.backendReadyQueueWatchdog) return;
    this.backendReadyQueueWatchdog = setTimeout(() => {
      this.backendReadyQueueWatchdog = null;
      const queued = this.backendReadyQueue.splice(0);
      if (queued.length === 0) return;
      for (const entry of queued) {
        if (entry.localId) {
          this.deps.dispatchEvent({
            kind: 'OptimisticMessageRemoved',
            sessionPath: entry.sessionPath,
            localId: entry.localId,
          });
        }
      }
      this.deps.dispatchEvent({
        kind: 'NoticeShown',
        notice: `Backend did not become ready within ${QueueManager.BACKEND_READY_QUEUE_TIMEOUT_MS / 1000}s. ${queued.length} queued message${queued.length === 1 ? '' : 's'} dropped — please retry.`,
      });
    }, QueueManager.BACKEND_READY_QUEUE_TIMEOUT_MS);
  }

  /**
   * Clear the watchdog timer.
   */
  clearWatchdog(): void {
    if (this.backendReadyQueueWatchdog) {
      clearTimeout(this.backendReadyQueueWatchdog);
      this.backendReadyQueueWatchdog = null;
    }
  }

  /**
   * Cleanup: clear the watchdog timer to prevent callbacks after disposal.
   */
  dispose(): void {
    this.clearWatchdog();
  }

  private getSessionByPath(path: string | null | undefined): SessionSummary | null {
    if (!path) return null;
    return this.deps.getArchState().sessions.sessions.find(s => s.path === path) ?? null;
  }
}
