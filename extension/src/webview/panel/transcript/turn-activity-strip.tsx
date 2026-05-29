/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { TurnActivityState } from './activity';

export type TurnActivityTone = 'neutral' | 'accent' | 'warning' | 'error' | 'success';

export interface TurnActivityStripProps {
  label: string;
  detail?: string;
  tone?: TurnActivityTone;
  runningDot?: boolean;
  standalone?: boolean;
  ariaLabel?: string;
}

/** Map the derived activity tone hint onto the strip's visual tone class. */
export function activityToneToStripTone(tone: TurnActivityState['tone']): TurnActivityTone {
  return tone === 'active' ? 'accent' : tone === 'processing' ? 'warning' : 'neutral';
}

/** Phases that should show the pulsing running dot. */
export function activityPhaseHasRunningDot(phase: TurnActivityState['phase']): boolean {
  return phase === 'runningTool' || phase === 'thinking';
}

export function TurnActivityStrip({
  label,
  detail,
  tone = 'neutral',
  runningDot = false,
  standalone = false,
  ariaLabel,
}: TurnActivityStripProps) {
  const className = ['turn-activity-strip', tone !== 'neutral' ? tone : '', standalone ? 'standalone' : '']
    .filter(Boolean)
    .join(' ');

  const resolvedAriaLabel = ariaLabel ?? `Activity status: ${label}${detail ? `, ${detail}` : ''}`;

  return (
    <div class={className} role="status" aria-label={resolvedAriaLabel}>
      <div class={`turn-activity-strip-dot${runningDot ? ' running' : ''}`} aria-hidden="true" />
      <span class="turn-activity-strip-label">{label}</span>
      {detail && <span class="turn-activity-strip-detail">{detail}</span>}
    </div>
  );
}
