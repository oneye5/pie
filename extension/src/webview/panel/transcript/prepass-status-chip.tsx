/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useEffect, useRef, useState } from 'preact/hooks';
import { memo } from 'preact/compat';

import { PanelChip } from '../components/panel-chip';
import type { ViewState } from '../../../shared/protocol';

/**
 * Brief F — Pruning prepass UX: live, cancelable status chip.
 *
 * Renders a compact chip while the pruning prepass runs (Brief F §8). The chip
 * is purely a VIEW over host-projected `ViewState.prepassPhase` /
 * `prepassStartedAt` / `prepassLatencyMs` — the host owns the phase transitions
 * (Brief A/B: `pending.promoted` = running, pruning-result `CustomMessage` =
 * succeeded, `PreflightFailed` = failed, commit-point `MessageStarted` = idle).
 * The webview stays passive (STATE_CONTRACT § Webview-Local State).
 *
 * The ONLY webview-local state here is the elapsed-seconds display + the
 * `setInterval` handle that ticks it — allowlisted "animation / transition
 * state" + "derived UI telemetry" (STATE_CONTRACT § Webview-Local State). It
 * holds no logic state: the interval recomputes `Date.now() - startedAt` (a
 * pure derivation) and is started when the phase becomes `'running'` and
 * cleared when it leaves (or on unmount). `prepassStartedAt` is guarded null.
 *
 * Cancel reuses Brief E's interrupt dispatch (`handleInterrupt`): the chip's
 * `onCancel` is wired to the same handler the composer Stop button uses, so
 * the host turns it into `abortInFlightSend` + `message.interrupt` (aborts the
 * prepass / turn).
 */

export interface PrepassStatusChipProps {
  phase: ViewState['prepassPhase'];
  startedAt: ViewState['prepassStartedAt'];
  latencyMs?: ViewState['prepassLatencyMs'];
  /** Abort the in-flight prepass. Wired to Brief E's interrupt handler. */
  onCancel: () => void;
}

/** Latency (ms) above which the post-hoc summary surfaces an actionable
 *  "lower `prepassTimeoutSec` / skip pruning" hint (Brief F §8). */
const HIGH_LATENCY_THRESHOLD_MS = 10_000;

/** Live-elapsed tick cadence (ms). Allowlisted webview-local animation /
 *  telemetry state — recomputes a derived display only (see file header). */
const TICK_MS = 1000;

function elapsedSeconds(startedAt: number, now: number): number {
  return Math.max(0, Math.floor((now - startedAt) / 1000));
}

function formatLatencySeconds(ms: number): string {
  return (ms / 1000).toFixed(1);
}

export const PrepassStatusChip = memo(function PrepassStatusChip({
  phase,
  startedAt,
  latencyMs,
  onCancel,
}: PrepassStatusChipProps) {
  // ── Live elapsed display (allowlisted animation / telemetry state) ───────
  // `elapsedSec` + the interval handle are the only local state. Started when
  // the phase becomes 'running' with a valid `startedAt`; cleared on unmount
  // or when the phase leaves 'running' (the effect re-runs and the cleanup +
  // early-return disarm it). Guards `startedAt` null.
  const [elapsedSec, setElapsedSec] = useState(0);
  const intervalRef = useRef<number | null>(null);

  useEffect(() => {
    if (phase !== 'running' || startedAt == null) {
      // Leaving 'running' (or never had a start time): disarm any armed tick so
      // a stale interval cannot keep re-rendering after the phase changed.
      if (intervalRef.current != null) {
        window.clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }
    // Seed immediately so the chip does not flash "0s" before the first tick.
    setElapsedSec(elapsedSeconds(startedAt, Date.now()));
    intervalRef.current = window.setInterval(() => {
      setElapsedSec(elapsedSeconds(startedAt, Date.now()));
    }, TICK_MS);
    return () => {
      if (intervalRef.current != null) {
        window.clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [phase, startedAt]);

  if (phase === 'idle') return null;

  if (phase === 'running') {
    const liveLabel = `Pruning context… ${elapsedSec}s`;
    return (
      <div class="prepass-status-row flex items-center gap-1.5 px-3 pt-1.5">
        <PanelChip
          as="div"
          variant="pruning"
          tone="accent"
          className="prepass-status-chip prepass-status-chip-running"
          role="status"
          ariaLive="polite"
          ariaLabel={liveLabel}
          title="The pruning prepass is analyzing your context before this turn starts. Cancel to abort it."
          leading={<span class="tool-call-status-spinner" />}
          label={liveLabel}
        />
        <PanelChip
          as="button"
          variant="pruning"
          tone="warning"
          className="panel-chip-interactive"
          ariaLabel="Cancel pruning prepass"
          title="Cancel the pruning prepass (interrupts this turn)"
          onClick={onCancel}
          label="Cancel"
        />
      </div>
    );
  }

  // ── Post-hoc summary: 'succeeded' (and briefly 'failed'). ────────────────
  // The host transitions succeeded/failed → idle on its own (commit-point
  // MessageStarted clears the promoted op for 'succeeded'; the next send
  // resets 'failed'), so this is naturally brief — no webview auto-dismiss
  // timer, keeping the webview passive (allowlist upheld).
  if (phase === 'succeeded') {
    const latency = typeof latencyMs === 'number' ? latencyMs : null;
    const highLatency = latency != null && latency > HIGH_LATENCY_THRESHOLD_MS;
    const latencyLabel = latency != null
      ? `Pruned in ${formatLatencySeconds(latency)}s`
      : 'Pruning complete';
    return (
      <div class="prepass-status-row flex items-center gap-1.5 px-3 pt-1.5">
        <PanelChip
          as="div"
          variant="pruning"
          tone={highLatency ? 'warning' : 'muted'}
          className="prepass-status-chip prepass-status-chip-succeeded"
          role="status"
          ariaLive="polite"
          ariaLabel={latencyLabel}
          title={
            highLatency && latency != null
              ? `This turn spent ${formatLatencySeconds(latency)}s pruning context — you can lower prepassTimeoutSec or skip pruning in settings`
              : latencyLabel
          }
          label={latencyLabel}
        />
        {highLatency && latency != null && (
          <span class="prepass-status-hint text-[10px] text-muted">
            Slow — lower <code>prepassTimeoutSec</code> or skip pruning in settings
          </span>
        )}
      </div>
    );
  }

  // phase === 'failed': minimal failure note. Brief H owns the full error copy.
  return (
    <div class="prepass-status-row flex items-center gap-1.5 px-3 pt-1.5">
      <PanelChip
        as="div"
        variant="pruning"
        tone="danger"
        className="prepass-status-chip prepass-status-chip-failed"
        role="status"
        ariaLive="polite"
        ariaLabel="Pruning prepass failed"
        title="The pruning prepass failed, so this turn was not started."
        leading="⚠"
        label="Pruning failed"
      />
    </div>
  );
});
