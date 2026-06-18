import { useEffect, useRef, useState } from 'preact/hooks';

/**
 * Buffered text streaming hook.
 *
 * When `streaming` is true, reveals *new* text (text that arrives after mount)
 * progressively at a smooth rate to prevent jarring layout shifts from large
 * text chunks arriving at once. Text already present at mount time is shown
 * immediately. When `streaming` is false (message complete), returns the full text.
 *
 * The hook uses requestAnimationFrame to advance the visible portion of text
 * at a configurable characters-per-frame rate, producing a smooth typewriter
 * effect that keeps the chat from jumping.
 */

/** Characters revealed per animation frame (~60fps → ~6000 chars/sec). */
const CHARS_PER_FRAME = 100;
/** Minimum characters to reveal per tick (avoids single-char stuttering). */
const MIN_ADVANCE = 20;
/** When remaining buffer is small, reveal instantly to avoid trailing lag. */
const SNAP_THRESHOLD = 40;

export function useBufferedText(fullText: string, streaming: boolean): string {
  // Start at current text length — text already present at mount is visible immediately.
  const [visibleLength, setVisibleLength] = useState(() => fullText.length);
  const rafRef = useRef<number | null>(null);
  const targetLengthRef = useRef(fullText.length);
  // Latest revealed length, kept in sync so the growth effect can decide whether
  // to re-arm the rAF loop without depending on `visibleLength` state (which
  // would re-run the effect every animation frame).
  const visibleLengthRef = useRef(fullText.length);

  targetLengthRef.current = fullText.length;

  // When streaming stops, immediately show all text and stop the loop.
  useEffect(() => {
    if (!streaming) {
      visibleLengthRef.current = fullText.length;
      setVisibleLength(fullText.length);
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    }
  }, [streaming, fullText.length]);

  // Reveal loop. Advances the visible length toward the target at a bounded
  // rate, but STOPS itself once it catches up (current >= target) instead of
  // rescheduling a no-op rAF every frame for the whole streaming duration. The
  // effect re-arms the loop whenever new text arrives (fullText grows) and the
  // view has fallen behind, so each text part runs at most one rAF chain
  // rather than a never-stopping loop that no-ops every frame.
  useEffect(() => {
    if (!streaming) return;

    const tick = () => {
      rafRef.current = null;
      const current = visibleLengthRef.current;
      const target = targetLengthRef.current;
      if (current >= target) {
        return; // caught up — loop stops; re-armed on next growth
      }
      const remaining = target - current;
      let next: number;
      if (remaining <= SNAP_THRESHOLD) {
        next = target;
      } else {
        // Scale rate by how much buffer we have — larger buffers reveal faster
        // to prevent the visible text falling too far behind.
        const scaleFactor = Math.min(8, 1 + Math.floor(remaining / 100));
        const advance = Math.max(MIN_ADVANCE, CHARS_PER_FRAME * scaleFactor);
        next = Math.min(target, current + advance);
      }
      visibleLengthRef.current = next;
      setVisibleLength(next);
      if (next < targetLengthRef.current) {
        rafRef.current = requestAnimationFrame(tick); // still behind — keep going
      }
      // else caught up; loop stops here, re-armed when fullText grows.
    };

    // (Re-)arm whenever new text arrives and we're behind.
    if (visibleLengthRef.current < targetLengthRef.current && rafRef.current === null) {
      rafRef.current = requestAnimationFrame(tick);
    }

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [streaming, fullText.length]);

  // If not streaming, always return full text (handles initial non-streaming render)
  if (!streaming) {
    return fullText;
  }

  return fullText.slice(0, visibleLength);
}
