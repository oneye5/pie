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
  /** Live ref to the auto-follow state (true while pinned to the bottom).
   *  Read by scroll-anchoring to know when NOT to pin the top visible row. */
  autoFollowRef: { current: boolean };
  isAtBottom: boolean;
  isInitialPositioning: boolean;
  isLoadingOlder: boolean;
  isLoadingNewer: boolean;
  requestOlderPage: () => void;
  requestNewerPage: () => void;
  jumpToLatest: () => void;
}

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
  scrollRef: { current: HTMLDivElement | null },
  scrollToBottom: () => void,
  setIsInitialPositioning: (v: boolean) => void,
  isInitialPositioningRef: { current: boolean },
  setIsLoadingOlder: (v: boolean) => void,
  setIsLoadingNewer: (v: boolean) => void,
  loadedStart: number,
  loadedEnd: number,
  autoFollowRef: { current: boolean },
  lastScrollTopRef: { current: number },
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
    pendingJumpToLatestSnapRef.current = false;
    pendingOlderAnchorRef.current = null;
    loadingOlderRef.current = false;
    loadingNewerRef.current = false;
    setIsLoadingOlder(false);
    setIsLoadingNewer(false);
    previousLoadedStartRef.current = loadedStart;
    previousLoadedEndRef.current = loadedEnd;
    // Keep the opacity mask (transcript-positioning) active until the
    // virtualizer's totalSize has actually settled. The virtualizer starts from
    // rough per-row estimates (estimateTranscriptRowSize) and keeps growing as
    // late ResizeObserver measurements arrive; clearing the mask after a single
    // rAF exposes a middle-then-crawl. Instead, snap to the bottom every frame
    // and only clear once `scrollHeight` stops changing — positioned-at-bottom
    // is trivially true immediately after a snap (the browser clamps scrollTop
    // to scrollHeight - clientHeight), so height stability is the real settled
    // signal. A safety timeout guarantees the mask can never hang the transcript
    // invisible (e.g. a session streaming a token every single frame).
    isInitialPositioningRef.current = true;
    setIsInitialPositioning(true);
    scrollToBottom();

    const startedAt = Date.now();
    const POSITIONING_SAFETY_TIMEOUT_MS = 600;
    const STABLE_FRAMES_REQUIRED = 2;
    let prevScrollHeight = Number.NaN;
    let stableFrames = 0;

    let frame: number | null = requestAnimationFrame(function tick() {
      frame = null;
      // If the user has taken manual scroll control during the positioning
      // window (e.g. switched to a streaming session and scrolled up within
      // the 600ms safety window), stop fighting them: clear the opacity mask at
      // their current scroll position, cancel the per-frame snap loop, and do
      // NOT scrollToBottom(). onScroll (useScrollEventsEffect ->
      // resolveAutoFollowState) flips autoFollowRef.current to false when the
      // user scrolls away from the bottom, so this reveals the transcript at
      // their position immediately instead of snapping back for up to 600ms.
      if (!autoFollowRef.current) {
        isInitialPositioningRef.current = false;
        setIsInitialPositioning(false);
        return;
      }
      scrollToBottom();
      const el = scrollRef.current;
      const scrollHeight = el ? el.scrollHeight : 0;
      if (scrollHeight > 0 && scrollHeight === prevScrollHeight) {
        stableFrames++;
      } else {
        stableFrames = 0;
      }
      prevScrollHeight = scrollHeight;
      const settled = stableFrames >= STABLE_FRAMES_REQUIRED;
      const timedOut = Date.now() - startedAt >= POSITIONING_SAFETY_TIMEOUT_MS;
      if (settled || timedOut) {
        isInitialPositioningRef.current = false;
        setIsInitialPositioning(false);
        return;
      }
      frame = requestAnimationFrame(tick);
    });

    return () => { if (frame !== null) cancelAnimationFrame(frame); };
  }, [sessionKey]);
}

function useScrollEventsEffect(
  scrollRef: { current: HTMLDivElement | null },
  autoFollowRef: { current: boolean },
  lastScrollTopRef: { current: number },
  setIsAtBottom: (v: boolean) => void,
  hasOlder: boolean,
  requestOlderPage: () => void,
  sessionKey: string | null,
) {
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const onScroll = () => {
      const next = el.scrollTop;
      const metrics = { scrollHeight: el.scrollHeight, scrollTop: next, clientHeight: el.clientHeight };
      const follow = resolveAutoFollowState({
        previousAutoFollow: autoFollowRef.current,
        previousScrollTop: lastScrollTopRef.current,
        nextScrollTop: next,
        metrics,
      });
      autoFollowRef.current = follow;
      lastScrollTopRef.current = next;
      setIsAtBottom(follow || isNearBottom(metrics));
      if (el.scrollTop <= 120 && hasOlder) requestOlderPage();
    };

    el.addEventListener('scroll', onScroll, { passive: true });

    return () => {
      el.removeEventListener('scroll', onScroll);
    };
  }, [scrollRef, requestOlderPage, sessionKey, hasOlder, autoFollowRef, lastScrollTopRef, setIsAtBottom]);
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
  isInitialPositioningRef: { current: boolean },
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
      // During the post-session-switch positioning window, snap to the bottom
      // every frame instead of easing. The virtualizer's totalSize grows in
      // sub-200px increments as late ResizeObserver measurements arrive, which
      // the easing path (advanceSmoothScrollTop) chases slowly — the visible
      // crawl. Snapping here, in tandem with useSessionResetEffect's per-frame
      // scrollToBottom, pins the transcript to the bottom while the opacity
      // mask hides the reflow. The snap-during-positioning is scoped to this
      // window only; once isInitialPositioningRef clears, normal easing resumes
      // for ongoing streaming auto-follow. hasNewer sessions return above, so
      // this never snaps a newer-not-loaded session to its partial bottom.
      if (isInitialPositioningRef.current) {
        if (el.scrollTop !== target) {
          el.scrollTop = target;
          lastScrollTopRef.current = target;
        }
        setIsAtBottom(true);
        return;
      }
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
  }, [scrollRef, hasNewer, autoFollowRef, lastScrollTopRef, setIsAtBottom, isInitialPositioningRef]);
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
  // Mirror of `isInitialPositioning` readable inside the persistent
  // useSmoothAutoFollow rAF loop without restarting it on each toggle (a state
  // dep would tear the loop down and rebuild it). Drives snap-vs-ease during the
  // post-session-switch positioning window.
  const isInitialPositioningRef = useRef(true);
  const previousLoadedStartRef = useRef(transcriptWindow.loadedStart);
  const previousLoadedEndRef = useRef(transcriptWindow.loadedEnd);
  const pendingJumpToLatestSnapRef = useRef(false);

  const { isAtBottom, setIsAtBottom, autoFollowRef, lastScrollTopRef, scrollToBottom } = useScrollState(scrollRef);
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
    scrollRef,
    scrollToBottom,
    setIsInitialPositioning,
    isInitialPositioningRef,
    setIsLoadingOlder,
    setIsLoadingNewer,
    transcriptWindow.loadedStart,
    transcriptWindow.loadedEnd,
    autoFollowRef,
    lastScrollTopRef,
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
    transcriptWindow.hasOlder,
    requestOlderPage,
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
    isInitialPositioningRef,
  );

  return {
    scrollRef,
    autoFollowRef,
    isAtBottom,
    isInitialPositioning,
    isLoadingOlder,
    isLoadingNewer,
    requestOlderPage,
    requestNewerPage,
    jumpToLatest,
  };
}
