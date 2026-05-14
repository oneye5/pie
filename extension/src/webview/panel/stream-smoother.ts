import type { PatchOp } from '../../shared/protocol';
import { emptyOverlay, applyPatch } from './overlay';
import type { Overlay } from './overlay';

/** Configuration for stream smoothing. */
export interface StreamSmootherConfig {
  /** Characters per second to emit during smoothed streaming. Default: 30 */
  charsPerSecond: number;
  /** Minimum characters before triggering smoothing. Default: 5 */
  minCharsForSmoothing: number;
  /** Maximum characters to buffer for smooth emission at once. Default: 50 */
  maxSmoothBatch: number;
  /** Maximum characters to hold before forcing immediate emission. Default: 200 */
  maxImmediateChars: number;
  /** Minimum delay between emit batches in ms. Default: 16 (approx 60fps) */
  minEmitIntervalMs: number;
}

export const DEFAULT_STREAM_SMOOTHER_CONFIG: StreamSmootherConfig = {
  charsPerSecond: 30,
  minCharsForSmoothing: 5,
  maxSmoothBatch: 50,
  maxImmediateChars: 200,
  minEmitIntervalMs: 16,
};

interface PendingDelta {
  messageId: string;
  delta: string;
  receivedAt: number;
}

interface StreamSmootherState {
  pendingDeltas: PendingDelta[];
  emitTimer: ReturnType<typeof setTimeout> | null;
  lastEmitTime: number;
}

/**
 * StreamSmoother smooths incoming message deltas by gradually emitting characters
 * over time, creating the illusion of a character-by-character stream instead of
 * chunky bursts. This is particularly helpful for providers like Ollama that tend
 * to send text in larger, less frequent chunks.
 *
 * Features:
 * - Buffers incoming deltas and releases them at a configurable rate
 * - Bypasses smoothing for small deltas (avoids unnecessary overhead)
 * - Forces immediate emission for large/sustained throughput (edge case handling)
 * - Configurable via StreamSmootherConfig
 */
export class StreamSmoother {
  private readonly config: StreamSmootherConfig;
  private readonly state: StreamSmootherState;
  private readonly onFlush: (overlay: Overlay) => void;
  private overlay: Overlay;

  constructor(
    config: Partial<StreamSmootherConfig>,
    onFlush: (overlay: Overlay) => void,
  ) {
    this.config = { ...DEFAULT_STREAM_SMOOTHER_CONFIG, ...config };
    this.state = {
      pendingDeltas: [],
      emitTimer: null,
      lastEmitTime: 0,
    };
    this.overlay = emptyOverlay();
    this.onFlush = onFlush;
  }

  /**
   * Process an incoming patch operation. Returns the overlay to use (possibly unchanged)
   * and schedules smoothing for text deltas that meet the smoothing criteria.
   */
  processPatch(op: PatchOp): Overlay {
    if (op.kind !== 'messageDelta') {
      // Non-delta patches are applied immediately
      this.overlay = applyPatch(this.overlay, op);
      this.onFlush(this.overlay);
      return this.overlay;
    }

    const { delta } = op;
    const deltaLength = delta.length;

    // Small delta: apply immediately without smoothing
    if (deltaLength < this.config.minCharsForSmoothing) {
      this.overlay = applyPatch(this.overlay, op);
      this.onFlush(this.overlay);
      return this.overlay;
    }

    // Large delta: apply immediately (sustained high throughput)
    if (deltaLength >= this.config.maxImmediateChars) {
      this.overlay = applyPatch(this.overlay, op);
      this.onFlush(this.overlay);
      return this.overlay;
    }

    // Medium delta: buffer for smooth streaming
    const pendingDelta: PendingDelta = {
      messageId: op.messageId,
      delta,
      receivedAt: Date.now(),
    };
    this.state.pendingDeltas.push(pendingDelta);

    // Cancel any existing timer to avoid multiple timers
    if (this.state.emitTimer !== null) {
      clearTimeout(this.state.emitTimer);
    }

    // Calculate delay based on character rate
    const emitDelayMs = Math.max(
      this.config.minEmitIntervalMs,
      Math.round((deltaLength / this.config.charsPerSecond) * 1000),
    );

    // Ensure minimum time has passed since last emit
    const timeSinceLastEmit = Date.now() - this.state.lastEmitTime;
    const actualDelay = Math.max(0, emitDelayMs - timeSinceLastEmit);

    this.state.emitTimer = setTimeout(() => {
      this.state.emitTimer = null;
      this.emitSmoothedBatch();
    }, actualDelay);

    // Return current overlay without the buffered delta (will be flushed later)
    return this.overlay;
  }

  /**
   * Emit a batch of buffered deltas with smoothing. Releases characters gradually
   * up to maxSmoothBatch, leaving larger amounts to be emitted in subsequent batches.
   */
  private emitSmoothedBatch(): void {
    if (this.state.pendingDeltas.length === 0) {
      return;
    }

    const now = Date.now();
    this.state.lastEmitTime = now;

    // Calculate how many characters we can emit in this batch
    let charsRemaining = this.config.maxSmoothBatch;
    const emittedDeltas: PendingDelta[] = [];

    // Process deltas in order, splitting as needed
    while (charsRemaining > 0 && this.state.pendingDeltas.length > 0) {
      const pending = this.state.pendingDeltas[0];

      if (pending.delta.length <= charsRemaining) {
        // Can emit the full delta
        emittedDeltas.push(this.state.pendingDeltas.shift()!);
        charsRemaining -= pending.delta.length;
      } else {
        // Split the delta: emit portion, keep remainder
        const emitPortion = pending.delta.slice(0, charsRemaining);
        const keepPortion = pending.delta.slice(charsRemaining);
        this.state.pendingDeltas[0] = {
          messageId: pending.messageId,
          delta: keepPortion,
          receivedAt: pending.receivedAt,
        };
        emittedDeltas.push({
          messageId: pending.messageId,
          delta: emitPortion,
          receivedAt: pending.receivedAt,
        });
        charsRemaining = 0;
      }
    }

    // Apply all emitted deltas
    for (const emitted of emittedDeltas) {
      this.overlay = applyPatch(this.overlay, {
        kind: 'messageDelta',
        messageId: emitted.messageId,
        delta: emitted.delta,
      });
    }
    this.onFlush(this.overlay);

    // If there's more to emit, schedule the next batch
    if (this.state.pendingDeltas.length > 0) {
      const nextBatchDelay = Math.max(
        this.config.minEmitIntervalMs,
        Math.round((this.config.maxSmoothBatch / this.config.charsPerSecond) * 1000),
      );

      this.state.emitTimer = setTimeout(() => {
        this.state.emitTimer = null;
        this.emitSmoothedBatch();
      }, nextBatchDelay);
    }
  }

  /**
   * Flush all pending deltas immediately, bypassing smoothing.
   * Useful when the stream completes or is interrupted.
   */
  flushAll(): Overlay {
    if (this.state.emitTimer !== null) {
      clearTimeout(this.state.emitTimer);
      this.state.emitTimer = null;
    }

    if (this.state.pendingDeltas.length === 0) {
      return this.overlay;
    }

    // Apply all remaining pending deltas
    for (const pending of this.state.pendingDeltas) {
      this.overlay = applyPatch(this.overlay, {
        kind: 'messageDelta',
        messageId: pending.messageId,
        delta: pending.delta,
      });
    }
    this.state.pendingDeltas = [];
    this.onFlush(this.overlay);
    return this.overlay;
  }

  /**
   * Reset the smoother state. Call when switching sessions or when a new stream begins.
   */
  reset(): void {
    if (this.state.emitTimer !== null) {
      clearTimeout(this.state.emitTimer);
      this.state.emitTimer = null;
    }
    this.state.pendingDeltas = [];
    this.state.lastEmitTime = 0;
    this.overlay = emptyOverlay();
  }

  /**
   * Get current pending character count (for debugging/metrics).
   */
  getPendingCharCount(): number {
    return this.state.pendingDeltas.reduce((sum, p) => sum + p.delta.length, 0);
  }
}