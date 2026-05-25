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
  const streamingRef = useRef(streaming);

  // Keep refs in sync
  targetLengthRef.current = fullText.length;
  streamingRef.current = streaming;

  // When streaming stops, immediately show all text
  useEffect(() => {
    if (!streaming) {
      setVisibleLength(fullText.length);
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    }
  }, [streaming, fullText.length]);

  // Animation loop during streaming
  useEffect(() => {
    if (!streaming) return;

    const tick = () => {
      setVisibleLength((current) => {
        const target = targetLengthRef.current;
        if (current >= target) {
          // Caught up — keep the loop alive to handle future growth
          rafRef.current = requestAnimationFrame(tick);
          return current;
        }

        const remaining = target - current;
        if (remaining <= SNAP_THRESHOLD) {
          rafRef.current = requestAnimationFrame(tick);
          return target;
        }

        // Scale rate by how much buffer we have — larger buffers reveal faster
        // to prevent the visible text falling too far behind.
        const scaleFactor = Math.min(8, 1 + Math.floor(remaining / 100));
        const advance = Math.max(MIN_ADVANCE, CHARS_PER_FRAME * scaleFactor);
        const next = Math.min(target, current + advance);

        rafRef.current = requestAnimationFrame(tick);
        return next;
      });
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [streaming]);

  // If not streaming, always return full text (handles initial non-streaming render)
  if (!streaming) {
    return fullText;
  }

  return fullText.slice(0, visibleLength);
}
