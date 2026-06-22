/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { cx } from '../utils/cx';
import type { TurnActivityState } from './activity';
import type { TurnActivityTail } from './activity-tail';

interface TurnActivityTailBodyProps {
  tail: TurnActivityTail;
}

/**
 * Render the live-activity tail as a fixed-height, terminal-style block.
 *
 * The block reserves a constant row budget per kind (the configured content-row
 * count for reasoning / reply text, plus one header row for a running tool /
 * subagent) so its height never changes as content streams in — that is what
 * stops the transcript from jumping around while the agent works. Rows render
 * top-to-bottom; the blinking caret attaches to the newest row.
 *
 * Tool / subagent tails merge their label (tool / agent name) and input (the
 * command / task) onto the first row as `label ▸ input`, so the caller and its
 * command share a line instead of consuming two. Reasoning and reply text have
 * no header row — the italic / muted styling already signals reasoning and the
 * caret signals reply, so a dedicated `reasoning…` label would just waste a row.
 *
 * Truncation ("more output exists above") is conveyed by a gentle top fade on
 * the content block rather than a dedicated `…` row, so the preview reads
 * seamlessly. The fade only applies with ≥2 content lines; a single clipped line
 * already surfaces its own trailing ellipsis via `text-overflow`.
 */
export function TurnActivityTailBody({ tail }: TurnActivityTailBodyProps) {
  const { kind, label, inputLine, lines, cursor, truncated } = tail;
  const hasComposite = Boolean(label);
  const hasContent = lines.length > 0;
  // The caret sits on the composite row while no output has arrived, otherwise
  // on the newest content line (handled per-row below).
  const caretOnComposite = Boolean(cursor) && !hasContent;
  const showFade = truncated && hasContent && lines.length >= 2;

  return (
    <div class={cx('turn-activity-tail', kind)} data-kind={kind} aria-hidden="true">
      {hasComposite && label && (
        <div class="turn-activity-tail-row turn-activity-tail-composite">
          <span class="turn-activity-tail-label">{label}</span>
          {inputLine && <span class="turn-activity-tail-sep" aria-hidden="true">▸</span>}
          {inputLine && (
            <span class="turn-activity-tail-text" title={inputLine}>{inputLine}</span>
          )}
          {caretOnComposite && <span class="turn-activity-tail-cursor" aria-hidden="true" />}
        </div>
      )}
      {/*
        The content block always renders so its min-height reserves the output
        rows (2 for tools/subagents below the composite, 2 for reasoning/reply).
        Empty when a tool has no output yet; otherwise holds the tail lines with
        the caret on the newest. The lone-caret branch covers the rare case of
        a tail with no composite and no content but a live cursor.
      */}
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
          !hasComposite && cursor && (
            <div class="turn-activity-tail-row">
              <span class="turn-activity-tail-cursor" aria-hidden="true" />
            </div>
          )
        )}
      </div>
    </div>
  );
}

interface TurnActivityBlockProps {
  state: TurnActivityState;
}

/**
 * Compact live-activity block: just the terminal-style tail body in a subtle
 * framed surface. The separate header strip (label + bouncing dots) is gone
 * for tail phases — the tail's own content carries the signal (caret + streaming
 * text). No-tail phases (thinking / preparing / pruning / starting model)
 * render the bare `TurnActivityStrip` directly at the call sites.
 */
export function TurnActivityBlock({ state }: TurnActivityBlockProps) {
  const tail = state.tail;
  if (!tail) return null;
  return (
    <div class="turn-activity-block" role="status" aria-label={state.ariaLabel}>
      <TurnActivityTailBody tail={tail} />
    </div>
  );
}
