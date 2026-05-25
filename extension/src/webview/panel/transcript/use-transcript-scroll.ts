import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';

import type { TranscriptWindow } from '../../../shared/protocol';
// Phase 4: auto-scroll.ts utilities kept for isNearBottom / resolveAutoFollowState.
// advanceSmoothScrollTop, captureScrollAnchor, resolveScrollAnchorDelta are no longer
// used here - candidates for deletion in Phase 8.
import { isNearBottom, resolveAutoFollowState } from '../auto-scroll';
import {
  captureMessageScrollAnchor,
  restoreMessageScrollAnchor,
  type MessageScrollAnchor,
} from './scroll-anchor';

interface UseTranscriptScrollOptions {
  sessionKey: string | null;
  transcriptWindow: TranscriptWindow;
  transcriptLength: number;
  busy: boolean;
  hasStreamingContent: boolean;
  onLoadOlder: () => void;
  onLoadNewer: () => void;
  onJumpToLatest: () => void;
}

interface UseTranscriptScrollResult {
  scrollRef: { current: HTMLDivElement | null };
  isAtBottom: boolean;
  isInitialPositioning: boolean;
  isLoadingOlder: boolean;
  isLoadingNewer: boolean;
  requestOlderPage: () => void;
  requestNewerPage: () => void;
  jumpToLatest: () => void;
}

const MANUAL_SCROLL_INTENT_GRACE_MS = 280;

export function useTranscriptScroll({
  sessionKey,
  transcriptWindow,
  transcriptLength,
  busy,
  hasStreamingContent,
  onLoadOlder,
  onLoadNewer,
  onJumpToLatest,
}: UseTranscriptScrollOptions): UseTranscriptScrollResult {
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [isInitialPositioning, setIsInitialPositioning] = useState(true);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const [isLoadingNewer, setIsLoadingNewer] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const autoFollowRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  const manualScrollIntentUntilRef = useRef(0);
  const pointerScrollIntentRef = useRef(false);
  const pendingJumpToLatestSnapRef = useRef(false);
  const pendingOlderAnchorRef = useRef<MessageScrollAnchor | null>(null);
  const loadingOlderRef = useRef(false);
  const loadingNewerRef = useRef(false);
  const previousLoadedStartRef = useRef(transcriptWindow.loadedStart);
  const previousLoadedEndRef = useRef(transcriptWindow.loadedEnd);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    lastScrollTopRef.current = el.scrollTop;
    setIsAtBottom(true);
  }, []);

  const requestOlderPage = useCallback(() => {
    if (loadingOlderRef.current) return;
    const el = scrollRef.current;
    if (el) pendingOlderAnchorRef.current = captureMessageScrollAnchor(el);
    loadingOlderRef.current = true;
    setIsLoadingOlder(true);
    onLoadOlder();
  }, [onLoadOlder]);

  const requestNewerPage = useCallback(() => {
    if (loadingNewerRef.current) return;
    loadingNewerRef.current = true;
    setIsLoadingNewer(true);
    onLoadNewer();
  }, [onLoadNewer]);

  const jumpToLatest = useCallback(() => {
    autoFollowRef.current = true;
    if (transcriptWindow.hasNewer) {
      pendingJumpToLatestSnapRef.current = true;
      onJumpToLatest();
      return;
    }
    scrollToBottom();
  }, [onJumpToLatest, scrollToBottom, transcriptWindow.hasNewer]);

  // Session switch: reset
  useLayoutEffect(() => {
    autoFollowRef.current = true;
    lastScrollTopRef.current = 0;
    manualScrollIntentUntilRef.current = 0;
    pointerScrollIntentRef.current = false;
    pendingJumpToLatestSnapRef.current = false;
    pendingOlderAnchorRef.current = null;
    loadingOlderRef.current = false;
    loadingNewerRef.current = false;
    setIsLoadingOlder(false);
    setIsLoadingNewer(false);
    setIsInitialPositioning(true);
    previousLoadedStartRef.current = transcriptWindow.loadedStart;
    previousLoadedEndRef.current = transcriptWindow.loadedEnd;
    scrollToBottom();
    // Clear positioning after one frame — virtualizer measures synchronously
    // during _willUpdate, so by next frame sizes are known.
    let frame: number | null = requestAnimationFrame(() => {
      frame = null;
      scrollToBottom();
      setIsInitialPositioning(false);
    });
    return () => { if (frame !== null) cancelAnimationFrame(frame); };
  }, [sessionKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Scroll event handling
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const markManual = () => { manualScrollIntentUntilRef.current = Date.now() + MANUAL_SCROLL_INTENT_GRACE_MS; };
    const clearPointer = () => { pointerScrollIntentRef.current = false; };

    const onScroll = () => {
      const next = el.scrollTop;
      const metrics = { scrollHeight: el.scrollHeight, scrollTop: next, clientHeight: el.clientHeight };
      const hasManual = pointerScrollIntentRef.current || Date.now() <= manualScrollIntentUntilRef.current;
      const follow = resolveAutoFollowState({
        previousAutoFollow: autoFollowRef.current,
        previousScrollTop: lastScrollTopRef.current,
        nextScrollTop: next,
        metrics,
        hasManualScrollIntent: hasManual,
      });
      autoFollowRef.current = follow;
      lastScrollTopRef.current = next;
      setIsAtBottom(follow || isNearBottom(metrics));
      if (el.scrollTop <= 120 && transcriptWindow.hasOlder) requestOlderPage();
    };

    const onWheel = () => markManual();
    const onTouchStart = () => markManual();
    const onTouchMove = () => markManual();
    const onPointerDown = (e: PointerEvent) => { if (e.target === el) { pointerScrollIntentRef.current = true; markManual(); } };

    el.addEventListener('wheel', onWheel, { passive: true });
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: true });
    el.addEventListener('pointerdown', onPointerDown, { passive: true });
    el.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('pointerup', clearPointer, { passive: true });
    window.addEventListener('pointercancel', clearPointer, { passive: true });
    window.addEventListener('blur', clearPointer);

    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('scroll', onScroll);
      window.removeEventListener('pointerup', clearPointer);
      window.removeEventListener('pointercancel', clearPointer);
      window.removeEventListener('blur', clearPointer);
    };
  }, [requestOlderPage, sessionKey, transcriptWindow.hasOlder]);

  // Pagination window tracking
  useLayoutEffect(() => {
    const prevStart = previousLoadedStartRef.current;
    const prevEnd = previousLoadedEndRef.current;
    previousLoadedStartRef.current = transcriptWindow.loadedStart;
    previousLoadedEndRef.current = transcriptWindow.loadedEnd;

    const el = scrollRef.current;
    if (!el) return;

    if (loadingOlderRef.current && transcriptWindow.loadedStart < prevStart) {
      restoreMessageScrollAnchor(el, pendingOlderAnchorRef.current);
      loadingOlderRef.current = false;
      setIsLoadingOlder(false);
      pendingOlderAnchorRef.current = null;
    }
    if (loadingNewerRef.current && transcriptWindow.loadedEnd > prevEnd) {
      loadingNewerRef.current = false;
      setIsLoadingNewer(false);
    }
    if (!transcriptWindow.hasOlder) { loadingOlderRef.current = false; setIsLoadingOlder(false); pendingOlderAnchorRef.current = null; }
    if (!transcriptWindow.hasNewer) { loadingNewerRef.current = false; setIsLoadingNewer(false); }

    if (pendingJumpToLatestSnapRef.current && !transcriptWindow.hasNewer) {
      pendingJumpToLatestSnapRef.current = false;
      autoFollowRef.current = true;
      scrollToBottom();
    }
  }, [scrollToBottom, transcriptLength, transcriptWindow.hasNewer, transcriptWindow.hasOlder, transcriptWindow.loadedEnd, transcriptWindow.loadedStart]);

  // Auto-follow: instant scroll to bottom when content changes
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !autoFollowRef.current || transcriptWindow.hasNewer) return;
    el.scrollTop = el.scrollHeight;
    lastScrollTopRef.current = el.scrollTop;
    setIsAtBottom(true);
  }, [busy, hasStreamingContent, transcriptLength, transcriptWindow.hasNewer]);

  // Auto-follow during buffered text streaming: ResizeObserver keeps scroll pinned
  // to bottom as content height grows incrementally from the buffered reveal.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !hasStreamingContent) return;

    const ro = new ResizeObserver(() => {
      if (!autoFollowRef.current) return;
      el.scrollTop = el.scrollHeight;
      lastScrollTopRef.current = el.scrollTop;
    });

    // Observe the inner content wrapper (first child) or the container itself
    const target = el.firstElementChild ?? el;
    ro.observe(target);

    return () => ro.disconnect();
  }, [hasStreamingContent]);

  return { scrollRef, isAtBottom, isInitialPositioning, isLoadingOlder, isLoadingNewer, requestOlderPage, requestNewerPage, jumpToLatest };
}
