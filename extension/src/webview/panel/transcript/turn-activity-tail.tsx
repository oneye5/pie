/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { cx } from '../utils/cx';
import type { TurnActivityState } from './activity';
import type { TurnActivityTail } from './activity-tail';
import {
  TurnActivityStrip,
  activityPhaseHasRunningDot,
  activityToneToStripTone,
} from './turn-activity-strip';

interface TurnActivityBlockProps {
  state: TurnActivityState;
  /** Render as a standalone row (typing-indicator context) vs inline footer. */
  standalone?: boolean;
}

/**
 * Render the live-activity tail. The input line (tool command / subagent task)
 * sits on its own row, followed by a content block holding the tail lines. The
 * blinking cursor attaches inline to whichever row is last — the input row
 * when no output has arrived yet, otherwise the newest content line — so it
 * reads like a live terminal caret; if there is no row at all it gets its own.
 *
 * Truncation ("more output exists above") used to cost a dedicated `…` row
 * wedged between the strip and the content — a wasted line that broke the
 * flow. It is now conveyed by a gentle top fade on the content block (see
 * `.turn-activity-tail-content.truncated`), so the preview reads seamlessly.
 * The fade only applies with ≥2 content lines; a single clipped line already
 * surfaces its own trailing ellipsis via `text-overflow`.
 */
export function TurnActivityTailBody({ tail }: { tail: TurnActivityTail }) {
  const lines = tail.lines;
  const hasContent = lines.length > 0;
  const cursor = tail.cursor;
  const showFade = tail.truncated && hasContent && lines.length >= 2;

  return (
    <div class={cx('turn-activity-tail', tail.kind)} data-kind={tail.kind} aria-hidden="true">
      {tail.inputLine && (
        <div class="turn-activity-tail-row turn-activity-tail-input">
          <span class="turn-activity-tail-text" title={tail.inputLine}>{tail.inputLine}</span>
          {cursor && !hasContent && <span class="turn-activity-tail-cursor" aria-hidden="true" />}
        </div>
      )}
      {(hasContent || (cursor && !tail.inputLine)) && (
        <div class={cx('turn-activity-tail-content', showFade && 'truncated')}>
          {hasContent ? (
            lines.map((line, i) => {
              const last = i === lines.length - 1;
              return (
                <div class="turn-activity-tail-row turn-activity-tail-line" key={i}>
                  <span class="turn-activity-tail-text" title={line}>{line}</span>
                  {cursor && last && <span class="turn-activity-tail-cursor" aria-hidden="true" />}
                </div>
              );
            })
          ) : (
            <div class="turn-activity-tail-row">
              <span class="turn-activity-tail-cursor" aria-hidden="true" />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Compact live-activity block: the existing single-line strip (header label +
 * animated dot) followed by the terminal-style tail body. Rendered in place of
 * the bare strip whenever a tail was derived for the current phase.
 */
export function TurnActivityBlock({ state, standalone = false }: TurnActivityBlockProps) {
  const tail = state.tail;
  return (
    <div class="turn-activity-block">
      <TurnActivityStrip
        label={state.label}
        tone={activityToneToStripTone(state.tone)}
        runningDot={activityPhaseHasRunningDot(state.phase)}
        phase={state.phase}
        standalone={standalone}
        ariaLabel={state.ariaLabel}
      />
      {tail && <TurnActivityTailBody tail={tail} />}
    </div>
  );
}
