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

interface TailRow {
  text: string;
  cls: string;
  sep?: boolean;
}

/**
 * Collect the ordered content rows for a tail: input line, the `…` truncation
 * separator, then the tail content lines. The blinking cursor is attached
 * inline to the last non-separator row so it reads like a live terminal caret;
 * if there is no content row at all it renders on its own line.
 */
function collectTailRows(tail: TurnActivityTail): TailRow[] {
  const rows: TailRow[] = [];
  if (tail.inputLine) {
    rows.push({ text: tail.inputLine, cls: 'turn-activity-tail-input' });
  }
  if (tail.truncated) {
    rows.push({ text: '…', cls: 'turn-activity-tail-sep', sep: true });
  }
  for (const line of tail.lines) {
    rows.push({ text: line, cls: 'turn-activity-tail-line' });
  }
  return rows;
}

function lastContentRowIndex(rows: readonly TailRow[]): number {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (!rows[i]!.sep) return i;
  }
  return -1;
}

export function TurnActivityTailBody({ tail }: { tail: TurnActivityTail }) {
  const rows = collectTailRows(tail);
  const cursorIdx = tail.cursor ? lastContentRowIndex(rows) : -1;

  return (
    <div class={cx('turn-activity-tail', tail.kind)} data-kind={tail.kind} aria-hidden="true">
      {rows.map((row, i) => (
        <div class={cx('turn-activity-tail-row', row.cls)} key={i}>
          <span class="turn-activity-tail-text" title={row.sep ? undefined : row.text}>
            {row.text}
          </span>
          {i === cursorIdx && <span class="turn-activity-tail-cursor" aria-hidden="true" />}
        </div>
      ))}
      {tail.cursor && cursorIdx === -1 && (
        <div class="turn-activity-tail-row">
          <span class="turn-activity-tail-cursor" aria-hidden="true" />
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
