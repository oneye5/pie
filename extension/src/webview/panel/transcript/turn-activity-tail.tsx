/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useLayoutEffect, useRef, useState } from 'preact/hooks';

import { cx } from '../utils/cx';
import type { TurnActivityState } from './activity';
import {
  ACTIVITY_TAIL_MAX_CHARS,
  ACTIVITY_TAIL_ROW_HEIGHT_PX,
  collapseSpaces,
  takeLastChars,
  type TurnActivityTail,
} from './activity-tail';

interface TurnActivityTailBodyProps {
  tail: TurnActivityTail;
}

/**
 * Render the live-activity tail as a fixed-height, terminal-style block.
 *
 * The block reserves a constant row budget per kind (the configured content-row
 * count for reasoning / reply text, plus one header row for a running tool /
 * subagent) so its height never changes as content streams in - that is what
 * stops the transcript from jumping around while the agent works. Rows render
 * top-to-bottom; the blinking caret attaches to the newest row.
 *
 * Tool / subagent tails merge their label (tool / agent name) and input (the
 * command / task) onto the first row as `label ▸ input`, so the caller and its
 * command share a line instead of consuming two. Reasoning and reply text have
 * no header row - the italic / muted styling already signals reasoning and the
 * caret signals reply, so a dedicated `reasoning...` label would just waste a row.
 *
 * Truncation ("more output exists above") is conveyed by a gentle top fade on
 * the content block rather than a dedicated `...` row, so the preview reads
 * seamlessly. The fade is driven by the actual rendered overflow: any time the
 * wrapped content is taller than the reserved block, the oldest (top) content
 * fades out. This catches both "many short source lines" and "one long line
 * that wraps across several rows".
 *
 * The body wraps to fill the reserved width and collapses source newlines
 * (joined with a space) so the limited preview rows carry as much of the recent
 * tail as possible, instead of one clipped row per source line. The block keeps
 * its fixed reserved height; the text is rendered directly from its source (no
 * per-character buffering) and scrolled like a console: it stays top-anchored
 * while it fits, then jumps up in whole-row increments so the newest row + caret
 * stay pinned to the bottom and the oldest row scrolls off the top on a row
 * boundary (see `useTailScroll`). Because wrapped height only grows by a whole
 * row when a line wraps, the view moves in discrete row steps — never a
 * sub-character slide — which keeps the small preview readable while the agent
 * works. Each row step is animated by the CSS `transform` transition on the
 * text so the scroll glides instead of snapping.
 */
export function TurnActivityTailBody({ tail }: TurnActivityTailBodyProps) {
  const { kind, label, inputLine, lines, cursor, sourceText } = tail;
  const hasComposite = Boolean(label);
  const hasContent = lines.length > 0;
  // The caret sits on the composite row while no output has arrived, otherwise
  // at the end of the flowing body text.
  const caretOnComposite = Boolean(cursor) && !hasContent;
  // Render the tail directly from its source — no per-character buffering. The
  // preview reads like a console that wraps and scrolls a whole row at a time
  // (see `useTailScroll`) rather than typing in character-by-character, which
  // kept the small block perpetually sliding and hard to read.
  const rawJoined = lines.filter((l) => l.length > 0).join(' ');
  const source = sourceText ?? rawJoined;
  const joined = sourceText
    ? collapseSpaces(takeLastChars(source, ACTIVITY_TAIL_MAX_CHARS))
    : rawJoined;
  const { overflows, scrollY, refs } = useTailScroll(hasContent, lines.length >= 2);
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
  /** Row-snapped vertical translate (px) that scrolls wrapped overflow up out
   *  of view in whole-row increments — console-style. While the text fits it is
   *  0 (top-anchored); once it overflows it jumps up by whole rows so the
   *  newest row + caret stay pinned to the bottom. Applied as a `transform`
   *  and animated via CSS so each row step glides instead of snapping. */
  scrollY: number;
  refs: TailScrollRefs;
}

function useTailScroll(hasContent: boolean, initialOverflow: boolean): TailScroll {
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

    // `joined` is intentionally NOT a dependency: the body re-renders per
    // snapshot as the source grows, and depending on the text here would tear
    // down and recreate this ResizeObserver (plus a sync forced reflow via
    // measure()) every snapshot. The observer already fires when the text
    // element resizes — i.e. when a wrapped row is added — and its callback runs
    // before paint, so the scroll stays correct without the churn. This effect
    // only re-runs when content appears/disappears (hasContent).
    const measure = () => {
      const textH = textEl.scrollHeight;
      const contentH = content.clientHeight;
      const overflow = textH - contentH;
      // Console-style row scrolling. While the wrapped text fits the reserved
      // block it stays top-anchored (content fills downward like a terminal).
      // The moment it overflows it jumps up in whole-row increments so the
      // newest row + caret stay pinned to the bottom and the oldest row scrolls
      // off the top on a row boundary — never a sub-character slide. Because
      // wrapped height only grows by a whole row when a line wraps, the
      // translate changes in row steps (not per character); the CSS `transform`
      // transition animates each step as a discrete row scroll.
      const nextY = overflow <= 0.5
        ? 0
        : -Math.ceil(overflow / ACTIVITY_TAIL_ROW_HEIGHT_PX) * ACTIVITY_TAIL_ROW_HEIGHT_PX;
      setScrollY((prev) => (prev === nextY ? prev : nextY));
      const nextOverflow = nextY < 0;
      setOverflows((prev) => (prev !== nextOverflow ? nextOverflow : prev));
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(content);
    ro.observe(textEl);
    return () => ro.disconnect();
  }, [hasContent]);

  return { overflows, scrollY, refs: { containerRef, textRef } };
}

interface TurnActivityBlockProps {
  state: TurnActivityState;
}

/**
 * Compact live-activity block: just the terminal-style tail body in a subtle
 * framed surface. The separate header strip (label + bouncing dots) is gone
 * for tail phases - the tail's own content carries the signal (caret + streaming
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
