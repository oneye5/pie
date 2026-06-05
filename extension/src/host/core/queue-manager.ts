import type { ArchState } from './reducer';
import type { Event } from './events';
import type { SessionSummary } from '../../shared/protocol';

export interface QueueManagerDeps {
  dispatchEvent: (event: Event) => void;
  getArchState: () => ArchState;
  scheduleRender: () => void;
  isPendingTabPath: (path: string) => boolean;
  dropSessionLocalState: (sessionPath: string) => void;
  deriveSessionNameFromText: (text: string) => { name: string; isPlaceholder: boolean };
}

export interface QueuedBackendReadySend {
  sessionPath: string;
  text: string;
  localId?: string;
  queuedAt: number;
}

/**
 * Manages send queues for sessions that are not yet ready to receive messages.
 *
 * Two queues are maintained:
 * - pendingSendQueue: sends for sessions still being created (pending tabs)
 * - backendReadyQueue: sends for restored sessions before backend is ready
 */
export class QueueManager {
  private readonly pendingSendQueue = new Map<string, { text: string; localId?: string }[]>();
  private readonly backendReadyQueue: QueuedBackendReadySend[] = [];

  private static readonly BACKEND_READY_QUEUE_TIMEOUT_MS = 30_000;
  private backendReadyQueueWatchdog: NodeJS.Timeout | null = null;

  constructor(
    private readonly deps: QueueManagerDeps,
    private readonly handleMessage: (msg: { type: 'send'; sessionPath: string; text: string; localId?: string }) => Promise<void>,
  ) {}

  /**
   * Enqueue a send for a pending session. Also inserts an optimistic message
   * into the transcript and derives the session name from the first message.
   */
  enqueuePendingSend(pendingPath: string, message: { text: string; localId?: string }): void {
    const { text, localId } = message;
    const queue = this.pendingSendQueue.get(pendingPath) ?? [];
    queue.push({ text, localId });
    this.pendingSendQueue.set(pendingPath, queue);

    // Insert optimistic user message
    const resolvedLocalId = localId ?? `local:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    this.deps.dispatchEvent({
      kind: 'OptimisticMessageInserted',
      sessionPath: pendingPath,
      localId: resolvedLocalId,
      text,
      timestamp: Date.now(),
    });

    // Derive optimistic session name from the first message
    const session = this.getSessionByPath(pendingPath);
    if (session?.isPlaceholder) {
      const derived = this.deps.deriveSessionNameFromText(text);
      if (!derived.isPlaceholder && derived.name !== session.name) {
        this.deps.dispatchEvent({ kind: 'SessionNameDerived', sessionPath: pendingPath, name: derived.name });
      }
    }

    this.deps.scheduleRender();
  }

  /**
   * Drain queued sends for a pending session that has now resolved.
   * Re-dispatches each queued send through the normal message handling flow.
   */
  async drainPendingSendQueue(pendingPath: string, resolvedPath: string): Promise<void> {
    const queued = this.pendingSendQueue.get(pendingPath);
    this.pendingSendQueue.delete(pendingPath);
    if (!queued || queued.length === 0) return;

    for (const entry of queued) {
      await this.handleMessage({ type: 'send', sessionPath: resolvedPath, text: entry.text, localId: entry.localId });
    }
  }

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
    this.pendingSendQueue.delete(sessionPath);
    // Rebuild the backendReadyQueue without entries for the closing session
    for (let i = this.backendReadyQueue.length - 1; i >= 0; i--) {
      if (this.backendReadyQueue[i]?.sessionPath === sessionPath) {
        this.backendReadyQueue.splice(i, 1);
      }
    }
    if (this.backendReadyQueue.length === 0) {
      this.clearWatchdog();
    }
    // Clear per-session bookkeeping held by the session service
    this.deps.dropSessionLocalState(sessionPath);
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
