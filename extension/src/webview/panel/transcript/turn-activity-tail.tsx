/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useLayoutEffect, useRef, useState } from 'preact/hooks';

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
 * seamlessly. The fade is driven by the actual rendered overflow: any time the
 * wrapped content is taller than the reserved block, the oldest (top) content
 * fades out. This catches both "many short source lines" and "one long line
 * that wraps across several rows".
 *
 * The body wraps to fill the reserved width and collapses source newlines
 * (joined with a space) so the limited preview rows carry as much of the recent
 * tail as possible, instead of one clipped row per source line. The block keeps
 * its fixed reserved height; the text is top-anchored and a JS-computed
 * `translateY` bottom-aligns it and scrolls wrapped overflow up out of view, so
 * the newest text and the caret stay visible. That translate is animated via a
 * CSS `transform` transition, so as tokens stream in the body slides smoothly
 * instead of snapping — making it easy to follow words mid-block.
 */
export function TurnActivityTailBody({ tail }: TurnActivityTailBodyProps) {
  const { kind, label, inputLine, lines, cursor } = tail;
  const hasComposite = Boolean(label);
  const hasContent = lines.length > 0;
  // The caret sits on the composite row while no output has arrived, otherwise
  // at the end of the flowing body text.
  const caretOnComposite = Boolean(cursor) && !hasContent;
  // Collapse source newlines into spaces so the body flows as a single wrapping
  // run that fills the reserved width, instead of one clipped row per source line.
  // Blank source lines are dropped (they would only add stray gaps in a wrap).
  const joined = lines.filter((l) => l.length > 0).join(' ');
  const { overflows, scrollY, refs } = useTailScroll(hasContent, joined, lines.length >= 2);
  const showFade = hasContent && overflows;

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
        The content block always renders so its reserved height holds the output
        rows (2 for tools/subagents below the composite, 2 for reasoning/reply).
        Empty when a tool has no output yet; otherwise holds the joined tail text
        (source newlines collapsed) which wraps to fill the width, with the caret
        at the end. The lone-caret branch covers the rare case of a tail with no
        composite and no content but a live cursor.
      */}
      <div
        ref={refs.containerRef}
        class={cx('turn-activity-tail-content', showFade && 'truncated')}
      >
        {hasContent ? (
          <span
            ref={refs.textRef}
            class="turn-activity-tail-text"
            title={joined}
            style={{ transform: `translateY(${scrollY}px)` }}
          >
            {joined}
            {cursor && <span class="turn-activity-tail-cursor" aria-hidden="true" />}
          </span>
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

interface TailScrollRefs {
  containerRef: { current: HTMLDivElement | null };
  textRef: { current: HTMLSpanElement | null };
}

interface TailScroll {
  overflows: boolean;
  /** Vertical translate (px) that bottom-aligns the text and scrolls overflow
   *  up out of view. Measured from real rendered heights and applied as a
   *  `transform` (animated via CSS) so reflow slides smoothly instead of
   *  snapping as tokens stream in. */
  scrollY: number;
  refs: TailScrollRefs;
}

function useTailScroll(hasContent: boolean, text: string, initialOverflow: boolean): TailScroll {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const textRef = useRef<HTMLSpanElement | null>(null);
  // Seed the fade for static renders / first paint (before the ResizeObserver
  // measures real overflow). Collapsed streaming/tool tails emit a single line
  // so this stays false for them and the observer is authoritative; subagent /
  // multi-tool tails can still seed true from multiple item lines.
  const [overflows, setOverflows] = useState(initialOverflow);
  const [scrollY, setScrollY] = useState(0);

  useLayoutEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;
    const content = containerRef.current;
    const textEl = textRef.current;
    if (!content || !textEl || !hasContent) return;

    const measure = () => {
      const textH = textEl.clientHeight;
      const contentH = content.clientHeight;
      const nextOverflow = textH > contentH + 0.5;
      setOverflows((prev) => (prev !== nextOverflow ? nextOverflow : prev));
      // contentH - textH: positive (slack) pushes the text down to bottom-align
      // when it's shorter than the block; negative (overflow) scrolls it up so
      // the newest content + caret stay pinned to the bottom and the top clips.
      const nextY = contentH - textH;
      setScrollY((prev) => (prev === nextY ? prev : nextY));
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(content);
    ro.observe(textEl);
    return () => ro.disconnect();
  }, [hasContent, text]);

  return { overflows, scrollY, refs: { containerRef, textRef } };
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
