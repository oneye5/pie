import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';

import type { TranscriptWindow } from '../../../shared/protocol';
import {
  SMOOTH_SCROLL_SNAP_EPSILON_PX,
  advanceSmoothScrollTop,
  isNearBottom,
  resolveAutoFollowState,
} from '../auto-scroll';
import {
  captureMessageScrollAnchor,
  restoreMessageScrollAnchor,
  type MessageScrollAnchor,
} from './scroll-anchor';

interface UseTranscriptScrollOptions {
  sessionKey: string | null;
  transcriptWindow: TranscriptWindow;
  transcriptLength: number;
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

function useScrollState(scrollRef: { current: HTMLDivElement | null }) {
  const [isAtBottom, setIsAtBottom] = useState(true);
  const autoFollowRef = useRef(true);
  const lastScrollTopRef = useRef(0);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Jumps must be instant: force non-smooth behavior around the snap so an
    // in-flight CSS smooth-scroll (or any `scroll-behavior: smooth` rule) can't
    // turn this into a slow ease that the auto-follow loop would then interrupt
    // and replace with frame-by-frame easing. Restored afterwards so the loop
    // continues to own smoothness while streaming.
    const prior = el.style.scrollBehavior;
    el.style.scrollBehavior = 'auto';
    el.scrollTop = el.scrollHeight;
    el.style.scrollBehavior = prior;
    lastScrollTopRef.current = el.scrollTop;
    setIsAtBottom(true);
  }, [scrollRef]);

  return { isAtBottom, setIsAtBottom, autoFollowRef, lastScrollTopRef, scrollToBottom };
}

function useManualScrollIntent() {
  const manualScrollIntentUntilRef = useRef(0);
  const pointerScrollIntentRef = useRef(false);

  const markManual = useCallback(() => {
    manualScrollIntentUntilRef.current = Date.now() + MANUAL_SCROLL_INTENT_GRACE_MS;
  }, []);

  const clearPointer = useCallback(() => {
    pointerScrollIntentRef.current = false;
  }, []);

  return { manualScrollIntentUntilRef, pointerScrollIntentRef, markManual, clearPointer };
}

function usePaginationState(
  scrollRef: { current: HTMLDivElement | null },
  onLoadOlder: () => void,
  onLoadNewer: () => void,
) {
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const [isLoadingNewer, setIsLoadingNewer] = useState(false);
  const loadingOlderRef = useRef(false);
  const loadingNewerRef = useRef(false);
  const pendingOlderAnchorRef = useRef<MessageScrollAnchor | null>(null);

  const requestOlderPage = useCallback(() => {
    if (loadingOlderRef.current) return;
    const el = scrollRef.current;
    if (el) pendingOlderAnchorRef.current = captureMessageScrollAnchor(el);
    loadingOlderRef.current = true;
    setIsLoadingOlder(true);
    onLoadOlder();
  }, [onLoadOlder, scrollRef]);

  const requestNewerPage = useCallback(() => {
    if (loadingNewerRef.current) return;
    loadingNewerRef.current = true;
    setIsLoadingNewer(true);
    onLoadNewer();
  }, [onLoadNewer]);

  return {
    isLoadingOlder,
    setIsLoadingOlder,
    isLoadingNewer,
    setIsLoadingNewer,
    loadingOlderRef,
    loadingNewerRef,
    pendingOlderAnchorRef,
    requestOlderPage,
    requestNewerPage,
  };
}

function useJumpToLatest(
  scrollRef: { current: HTMLDivElement | null },
  autoFollowRef: { current: boolean },
  hasNewer: boolean,
  onJumpToLatest: () => void,
  scrollToBottom: () => void,
  pendingJumpToLatestSnapRef: { current: boolean },
) {
  return useCallback(() => {
    autoFollowRef.current = true;
    if (hasNewer) {
      pendingJumpToLatestSnapRef.current = true;
      onJumpToLatest();
      return;
    }
    scrollToBottom();
  }, [hasNewer, onJumpToLatest, scrollToBottom]);
}

function useSessionResetEffect(
  sessionKey: string | null,
  scrollToBottom: () => void,
  setIsInitialPositioning: (v: boolean) => void,
  setIsLoadingOlder: (v: boolean) => void,
  setIsLoadingNewer: (v: boolean) => void,
  loadedStart: number,
  loadedEnd: number,
  autoFollowRef: { current: boolean },
  lastScrollTopRef: { current: number },
  manualScrollIntentUntilRef: { current: number },
  pointerScrollIntentRef: { current: boolean },
  pendingJumpToLatestSnapRef: { current: boolean },
  pendingOlderAnchorRef: { current: MessageScrollAnchor | null },
  loadingOlderRef: { current: boolean },
  loadingNewerRef: { current: boolean },
  previousLoadedStartRef: { current: number },
  previousLoadedEndRef: { current: number },
) {
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
    previousLoadedStartRef.current = loadedStart;
    previousLoadedEndRef.current = loadedEnd;
    scrollToBottom();
    let frame: number | null = requestAnimationFrame(() => {
      frame = null;
      scrollToBottom();
      setIsInitialPositioning(false);
    });
    return () => { if (frame !== null) cancelAnimationFrame(frame); };
  }, [sessionKey]);
}

function useScrollEventsEffect(
  scrollRef: { current: HTMLDivElement | null },
  autoFollowRef: { current: boolean },
  lastScrollTopRef: { current: number },
  setIsAtBottom: (v: boolean) => void,
  manualScrollIntentUntilRef: { current: number },
  pointerScrollIntentRef: { current: boolean },
  hasOlder: boolean,
  requestOlderPage: () => void,
  markManual: () => void,
  clearPointer: () => void,
  sessionKey: string | null,
) {
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

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
      if (el.scrollTop <= 120 && hasOlder) requestOlderPage();
    };

    const onWheel = () => markManual();
    const onTouchStart = () => markManual();
    const onTouchMove = () => markManual();
    const onPointerDown = (e: PointerEvent) => {
      if (e.target === el) {
        pointerScrollIntentRef.current = true;
        markManual();
      }
    };

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
  }, [scrollRef, requestOlderPage, sessionKey, hasOlder, autoFollowRef, lastScrollTopRef, setIsAtBottom, manualScrollIntentUntilRef, pointerScrollIntentRef, markManual, clearPointer]);
}

function usePaginationTrackingEffect(
  scrollRef: { current: HTMLDivElement | null },
  scrollToBottom: () => void,
  transcriptLength: number,
  loadedStart: number,
  loadedEnd: number,
  hasNewer: boolean,
  hasOlder: boolean,
  loadingOlderRef: { current: boolean },
  loadingNewerRef: { current: boolean },
  pendingOlderAnchorRef: { current: MessageScrollAnchor | null },
  setIsLoadingOlder: (v: boolean) => void,
  setIsLoadingNewer: (v: boolean) => void,
  previousLoadedStartRef: { current: number },
  previousLoadedEndRef: { current: number },
  pendingJumpToLatestSnapRef: { current: boolean },
  autoFollowRef: { current: boolean },
) {
  useLayoutEffect(() => {
    const prevStart = previousLoadedStartRef.current;
    const prevEnd = previousLoadedEndRef.current;
    previousLoadedStartRef.current = loadedStart;
    previousLoadedEndRef.current = loadedEnd;

    const el = scrollRef.current;
    if (!el) return;

    if (loadingOlderRef.current && loadedStart < prevStart) {
      restoreMessageScrollAnchor(el, pendingOlderAnchorRef.current);
      loadingOlderRef.current = false;
      setIsLoadingOlder(false);
      pendingOlderAnchorRef.current = null;
    }
    if (loadingNewerRef.current && loadedEnd > prevEnd) {
      loadingNewerRef.current = false;
      setIsLoadingNewer(false);
    }
    if (!hasOlder) {
      loadingOlderRef.current = false;
      setIsLoadingOlder(false);
      pendingOlderAnchorRef.current = null;
    }
    if (!hasNewer) {
      loadingNewerRef.current = false;
      setIsLoadingNewer(false);
    }

    if (pendingJumpToLatestSnapRef.current && !hasNewer) {
      pendingJumpToLatestSnapRef.current = false;
      autoFollowRef.current = true;
      scrollToBottom();
    }
  }, [scrollToBottom, transcriptLength, hasNewer, hasOlder, loadedEnd, loadedStart]);
}

/**
 * Persistent rAF loop that eases the transcript toward its bottom whenever
 * auto-follow is active, replacing the previous hard `scrollTop = scrollHeight`
 * snaps that produced visible jumps as streaming content grew. Each frame
 * advances scrollTop a bounded step toward the target (see
 * `advanceSmoothScrollTop`), so following feels continuous instead of snapping.
 * CSS `scroll-behavior` is bypassed while auto-following (each frame's set is
 * instant) and restored when idle so manual scrolling keeps its smooth feel.
 */
function useSmoothAutoFollow(
  scrollRef: { current: HTMLDivElement | null },
  autoFollowRef: { current: boolean },
  lastScrollTopRef: { current: number },
  setIsAtBottom: (v: boolean) => void,
  hasNewer: boolean,
) {
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      if (!autoFollowRef.current || hasNewer) {
        if (el.style.scrollBehavior === 'auto') el.style.scrollBehavior = '';
        return;
      }
      if (el.style.scrollBehavior !== 'auto') el.style.scrollBehavior = 'auto';
      const target = el.scrollHeight;
      const current = el.scrollTop;
      const delta = target - current;
      if (Math.abs(delta) <= SMOOTH_SCROLL_SNAP_EPSILON_PX) {
        if (current !== target) {
          el.scrollTop = target;
          lastScrollTopRef.current = target;
        }
        return;
      }
      const next = advanceSmoothScrollTop(current, target);
      el.scrollTop = next;
      lastScrollTopRef.current = next;
      setIsAtBottom(true);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      el.style.scrollBehavior = '';
    };
  }, [scrollRef, hasNewer, autoFollowRef, lastScrollTopRef, setIsAtBottom]);
}

export function useTranscriptScroll({
  sessionKey,
  transcriptWindow,
  transcriptLength,
  onLoadOlder,
  onLoadNewer,
  onJumpToLatest,
}: UseTranscriptScrollOptions): UseTranscriptScrollResult {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [isInitialPositioning, setIsInitialPositioning] = useState(true);
  const previousLoadedStartRef = useRef(transcriptWindow.loadedStart);
  const previousLoadedEndRef = useRef(transcriptWindow.loadedEnd);
  const pendingJumpToLatestSnapRef = useRef(false);

  const { isAtBottom, setIsAtBottom, autoFollowRef, lastScrollTopRef, scrollToBottom } = useScrollState(scrollRef);
  const { manualScrollIntentUntilRef, pointerScrollIntentRef, markManual, clearPointer } = useManualScrollIntent();
  const {
    isLoadingOlder,
    setIsLoadingOlder,
    isLoadingNewer,
    setIsLoadingNewer,
    loadingOlderRef,
    loadingNewerRef,
    pendingOlderAnchorRef,
    requestOlderPage,
    requestNewerPage,
  } = usePaginationState(scrollRef, onLoadOlder, onLoadNewer);

  const jumpToLatest = useJumpToLatest(
    scrollRef,
    autoFollowRef,
    transcriptWindow.hasNewer,
    onJumpToLatest,
    scrollToBottom,
    pendingJumpToLatestSnapRef,
  );

  useSessionResetEffect(
    sessionKey,
    scrollToBottom,
    setIsInitialPositioning,
    setIsLoadingOlder,
    setIsLoadingNewer,
    transcriptWindow.loadedStart,
    transcriptWindow.loadedEnd,
    autoFollowRef,
    lastScrollTopRef,
    manualScrollIntentUntilRef,
    pointerScrollIntentRef,
    pendingJumpToLatestSnapRef,
    pendingOlderAnchorRef,
    loadingOlderRef,
    loadingNewerRef,
    previousLoadedStartRef,
    previousLoadedEndRef,
  );

  useScrollEventsEffect(
    scrollRef,
    autoFollowRef,
    lastScrollTopRef,
    setIsAtBottom,
    manualScrollIntentUntilRef,
    pointerScrollIntentRef,
    transcriptWindow.hasOlder,
    requestOlderPage,
    markManual,
    clearPointer,
    sessionKey,
  );

  usePaginationTrackingEffect(
    scrollRef,
    scrollToBottom,
    transcriptLength,
    transcriptWindow.loadedStart,
    transcriptWindow.loadedEnd,
    transcriptWindow.hasNewer,
    transcriptWindow.hasOlder,
    loadingOlderRef,
    loadingNewerRef,
    pendingOlderAnchorRef,
    setIsLoadingOlder,
    setIsLoadingNewer,
    previousLoadedStartRef,
    previousLoadedEndRef,
    pendingJumpToLatestSnapRef,
    autoFollowRef,
  );

  useSmoothAutoFollow(
    scrollRef,
    autoFollowRef,
    lastScrollTopRef,
    setIsAtBottom,
    transcriptWindow.hasNewer,
  );

  return {
    scrollRef,
    isAtBottom,
    isInitialPositioning,
    isLoadingOlder,
    isLoadingNewer,
    requestOlderPage,
    requestNewerPage,
    jumpToLatest,
  };
}
