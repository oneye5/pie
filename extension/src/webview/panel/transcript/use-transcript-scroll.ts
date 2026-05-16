import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';

import type { TranscriptWindow } from '../../../shared/protocol';
import type { Overlay } from '../overlay';
import { advanceSmoothScrollTop, isNearBottom, resolveAutoFollowState } from '../auto-scroll';
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
  overlay: Overlay;
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
const INITIAL_BOTTOM_SNAP_FRAMES = 3;
const PAGE_REQUEST_TIMEOUT_MS = 1500;

export function useTranscriptScroll({
  sessionKey,
  transcriptWindow,
  transcriptLength,
  busy,
  overlay,
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
  const followFrameRef = useRef<number | null>(null);
  const initialBottomFrameRef = useRef<number | null>(null);
  const smoothFollowTargetRef = useRef<number | null>(null);
  const initialBottomFramesRemainingRef = useRef(0);
  const lastScrollTopRef = useRef(0);
  const manualScrollIntentUntilRef = useRef(0);
  const pointerScrollIntentRef = useRef(false);
  const pendingJumpToLatestSnapRef = useRef(false);
  const pendingOlderAnchorRef = useRef<MessageScrollAnchor | null>(null);
  const loadingOlderRef = useRef(false);
  const loadingNewerRef = useRef(false);
  const loadingOlderTimeoutRef = useRef<number | null>(null);
  const loadingNewerTimeoutRef = useRef<number | null>(null);
  const previousLoadedStartRef = useRef(transcriptWindow.loadedStart);
  const previousLoadedEndRef = useRef(transcriptWindow.loadedEnd);

  const stopSmoothFollow = useCallback(() => {
    smoothFollowTargetRef.current = null;
    if (followFrameRef.current !== null) {
      window.cancelAnimationFrame(followFrameRef.current);
      followFrameRef.current = null;
    }
  }, []);

  const scrollToBottom = useCallback(() => {
    stopSmoothFollow();

    const element = scrollRef.current;
    if (!element) {
      return;
    }

    element.scrollTop = element.scrollHeight;
    lastScrollTopRef.current = element.scrollTop;
    setIsAtBottom(true);
  }, [stopSmoothFollow]);

  const stopInitialBottomSnap = useCallback(() => {
    initialBottomFramesRemainingRef.current = 0;
    if (initialBottomFrameRef.current !== null) {
      window.cancelAnimationFrame(initialBottomFrameRef.current);
      initialBottomFrameRef.current = null;
    }
  }, []);

  const runInitialBottomSnap = useCallback(() => {
    initialBottomFrameRef.current = null;

    const element = scrollRef.current;
    if (!element || !autoFollowRef.current || initialBottomFramesRemainingRef.current <= 0) {
      initialBottomFramesRemainingRef.current = 0;
      setIsInitialPositioning(false);
      return;
    }

    element.scrollTop = element.scrollHeight;
    lastScrollTopRef.current = element.scrollTop;
    setIsAtBottom(true);

    initialBottomFramesRemainingRef.current -= 1;
    if (initialBottomFramesRemainingRef.current > 0) {
      initialBottomFrameRef.current = window.requestAnimationFrame(runInitialBottomSnap);
      return;
    }

    setIsInitialPositioning(false);
  }, []);

  const startInitialBottomSnap = useCallback((hideUntilStable = false) => {
    stopInitialBottomSnap();
    stopSmoothFollow();
    if (hideUntilStable) {
      setIsInitialPositioning(true);
    }
    initialBottomFramesRemainingRef.current = INITIAL_BOTTOM_SNAP_FRAMES;
    initialBottomFrameRef.current = window.requestAnimationFrame(runInitialBottomSnap);
  }, [runInitialBottomSnap, stopInitialBottomSnap, stopSmoothFollow]);

  const runSmoothFollow = useCallback(() => {
    followFrameRef.current = null;

    const element = scrollRef.current;
    const requestedTargetScrollTop = smoothFollowTargetRef.current;
    if (!element || requestedTargetScrollTop === null || !autoFollowRef.current) {
      return;
    }

    const targetScrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
    smoothFollowTargetRef.current = targetScrollTop;

    const nextScrollTop = advanceSmoothScrollTop(element.scrollTop, targetScrollTop);
    if (Math.abs(nextScrollTop - element.scrollTop) >= 0.5) {
      element.scrollTop = nextScrollTop;
      lastScrollTopRef.current = element.scrollTop;
    }

    if (Math.abs(targetScrollTop - element.scrollTop) <= 1) {
      smoothFollowTargetRef.current = null;
      setIsAtBottom(true);
      return;
    }

    followFrameRef.current = window.requestAnimationFrame(runSmoothFollow);
  }, []);

  const scheduleScrollToBottom = useCallback(() => {
    const element = scrollRef.current;
    if (!element || !autoFollowRef.current) {
      return;
    }

    const targetScrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
    if (initialBottomFramesRemainingRef.current > 0) {
      element.scrollTop = element.scrollHeight;
      lastScrollTopRef.current = element.scrollTop;
      setIsAtBottom(true);
      return;
    }

    if (Math.abs(targetScrollTop - element.scrollTop) <= 1) {
      smoothFollowTargetRef.current = null;
      setIsAtBottom(true);
      return;
    }

    smoothFollowTargetRef.current = targetScrollTop;
    if (followFrameRef.current === null) {
      followFrameRef.current = window.requestAnimationFrame(runSmoothFollow);
    }
  }, [runSmoothFollow]);

  const clearLoadingOlderTimeout = useCallback(() => {
    if (loadingOlderTimeoutRef.current === null) {
      return;
    }

    window.clearTimeout(loadingOlderTimeoutRef.current);
    loadingOlderTimeoutRef.current = null;
  }, []);

  const requestOlderPage = useCallback(() => {
    if (loadingOlderRef.current) {
      return;
    }

    const element = scrollRef.current;
    if (element) {
      pendingOlderAnchorRef.current = captureMessageScrollAnchor(element);
    }

    loadingOlderRef.current = true;
    setIsLoadingOlder(true);
    onLoadOlder();

    clearLoadingOlderTimeout();
    loadingOlderTimeoutRef.current = window.setTimeout(() => {
      if (loadingOlderRef.current) {
        loadingOlderRef.current = false;
        setIsLoadingOlder(false);
      }
      loadingOlderTimeoutRef.current = null;
    }, PAGE_REQUEST_TIMEOUT_MS);
  }, [clearLoadingOlderTimeout, onLoadOlder]);

  const clearLoadingNewerTimeout = useCallback(() => {
    if (loadingNewerTimeoutRef.current === null) {
      return;
    }

    window.clearTimeout(loadingNewerTimeoutRef.current);
    loadingNewerTimeoutRef.current = null;
  }, []);

  const requestNewerPage = useCallback(() => {
    if (loadingNewerRef.current) {
      return;
    }

    loadingNewerRef.current = true;
    setIsLoadingNewer(true);
    onLoadNewer();

    clearLoadingNewerTimeout();
    loadingNewerTimeoutRef.current = window.setTimeout(() => {
      if (loadingNewerRef.current) {
        loadingNewerRef.current = false;
        setIsLoadingNewer(false);
      }
      loadingNewerTimeoutRef.current = null;
    }, PAGE_REQUEST_TIMEOUT_MS);
  }, [clearLoadingNewerTimeout, onLoadNewer]);

  const jumpToLatest = useCallback(() => {
    autoFollowRef.current = true;
    if (transcriptWindow.hasNewer) {
      pendingJumpToLatestSnapRef.current = true;
      onJumpToLatest();
      return;
    }

    scrollToBottom();
    startInitialBottomSnap(false);
  }, [onJumpToLatest, scrollToBottom, startInitialBottomSnap, transcriptWindow.hasNewer]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) {
      return;
    }

    autoFollowRef.current = true;
    lastScrollTopRef.current = 0;
    manualScrollIntentUntilRef.current = 0;
    pointerScrollIntentRef.current = false;
    pendingJumpToLatestSnapRef.current = false;
    stopInitialBottomSnap();
    loadingOlderRef.current = false;
    loadingNewerRef.current = false;
    setIsLoadingOlder(false);
    setIsLoadingNewer(false);
    clearLoadingOlderTimeout();
    clearLoadingNewerTimeout();
    pendingOlderAnchorRef.current = null;
    previousLoadedStartRef.current = transcriptWindow.loadedStart;
    previousLoadedEndRef.current = transcriptWindow.loadedEnd;

    scrollToBottom();
    startInitialBottomSnap(true);
  }, [
    clearLoadingNewerTimeout,
    clearLoadingOlderTimeout,
    scrollToBottom,
    sessionKey,
    startInitialBottomSnap,
    stopInitialBottomSnap,
  ]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) {
      return;
    }

    const markManualScrollIntent = () => {
      manualScrollIntentUntilRef.current = Date.now() + MANUAL_SCROLL_INTENT_GRACE_MS;
    };

    const clearPointerScrollIntent = () => {
      pointerScrollIntentRef.current = false;
    };

    const updateScrollState = () => {
      const nextScrollTop = element.scrollTop;
      const metrics = {
        scrollHeight: element.scrollHeight,
        scrollTop: nextScrollTop,
        clientHeight: element.clientHeight,
      };
      const hasManualScrollIntent = pointerScrollIntentRef.current
        || Date.now() <= manualScrollIntentUntilRef.current;
      const nextAutoFollow = resolveAutoFollowState({
        previousAutoFollow: autoFollowRef.current,
        previousScrollTop: lastScrollTopRef.current,
        nextScrollTop,
        metrics,
        hasManualScrollIntent,
      });
      const nearBottom = isNearBottom(metrics);
      autoFollowRef.current = nextAutoFollow;
      lastScrollTopRef.current = nextScrollTop;
      setIsAtBottom(nextAutoFollow || nearBottom);
      if (!nextAutoFollow) {
        stopSmoothFollow();
        stopInitialBottomSnap();
        setIsInitialPositioning(false);
      }

      if (element.scrollTop <= 120 && transcriptWindow.hasOlder) {
        requestOlderPage();
      }
    };

    const handleWheel = () => {
      markManualScrollIntent();
    };

    const handleTouchStart = () => {
      markManualScrollIntent();
    };

    const handleTouchMove = () => {
      markManualScrollIntent();
    };

    const handlePointerDown = (event: PointerEvent) => {
      if (event.target !== element) {
        return;
      }
      pointerScrollIntentRef.current = true;
      markManualScrollIntent();
    };

    element.addEventListener('wheel', handleWheel, { passive: true });
    element.addEventListener('touchstart', handleTouchStart, { passive: true });
    element.addEventListener('touchmove', handleTouchMove, { passive: true });
    element.addEventListener('pointerdown', handlePointerDown, { passive: true });
    element.addEventListener('scroll', updateScrollState, { passive: true });
    window.addEventListener('pointerup', clearPointerScrollIntent, { passive: true });
    window.addEventListener('pointercancel', clearPointerScrollIntent, { passive: true });
    window.addEventListener('blur', clearPointerScrollIntent);
    updateScrollState();

    return () => {
      element.removeEventListener('wheel', handleWheel);
      element.removeEventListener('touchstart', handleTouchStart);
      element.removeEventListener('touchmove', handleTouchMove);
      element.removeEventListener('pointerdown', handlePointerDown);
      element.removeEventListener('scroll', updateScrollState);
      window.removeEventListener('pointerup', clearPointerScrollIntent);
      window.removeEventListener('pointercancel', clearPointerScrollIntent);
      window.removeEventListener('blur', clearPointerScrollIntent);
      clearPointerScrollIntent();
    };
  }, [requestOlderPage, sessionKey, stopInitialBottomSnap, stopSmoothFollow, transcriptWindow.hasOlder]);

  useLayoutEffect(() => {
    const previousLoadedStart = previousLoadedStartRef.current;
    const previousLoadedEnd = previousLoadedEndRef.current;
    previousLoadedStartRef.current = transcriptWindow.loadedStart;
    previousLoadedEndRef.current = transcriptWindow.loadedEnd;

    const element = scrollRef.current;
    if (!element) {
      return;
    }

    if (loadingOlderRef.current && transcriptWindow.loadedStart < previousLoadedStart) {
      restoreMessageScrollAnchor(element, pendingOlderAnchorRef.current);
      loadingOlderRef.current = false;
      setIsLoadingOlder(false);
      clearLoadingOlderTimeout();
      pendingOlderAnchorRef.current = null;
    }

    if (loadingNewerRef.current && transcriptWindow.loadedEnd > previousLoadedEnd) {
      loadingNewerRef.current = false;
      setIsLoadingNewer(false);
      clearLoadingNewerTimeout();
    }

    if (!transcriptWindow.hasOlder) {
      loadingOlderRef.current = false;
      setIsLoadingOlder(false);
      clearLoadingOlderTimeout();
      pendingOlderAnchorRef.current = null;
    }

    if (!transcriptWindow.hasNewer) {
      loadingNewerRef.current = false;
      setIsLoadingNewer(false);
      clearLoadingNewerTimeout();
    }

    if (pendingJumpToLatestSnapRef.current && !transcriptWindow.hasNewer) {
      pendingJumpToLatestSnapRef.current = false;
      autoFollowRef.current = true;
      scrollToBottom();
      startInitialBottomSnap();
    }
  }, [
    clearLoadingNewerTimeout,
    clearLoadingOlderTimeout,
    scrollToBottom,
    startInitialBottomSnap,
    transcriptLength,
    transcriptWindow.hasNewer,
    transcriptWindow.hasOlder,
    transcriptWindow.loadedEnd,
    transcriptWindow.loadedStart,
  ]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) {
      return;
    }

    if (!autoFollowRef.current || transcriptWindow.hasNewer) {
      return;
    }

    scheduleScrollToBottom();
  }, [busy, overlay, scheduleScrollToBottom, transcriptLength, transcriptWindow.hasNewer]);

  useEffect(() => () => {
    clearLoadingOlderTimeout();
    clearLoadingNewerTimeout();
    stopSmoothFollow();
    stopInitialBottomSnap();
  }, [clearLoadingNewerTimeout, clearLoadingOlderTimeout, stopInitialBottomSnap, stopSmoothFollow]);

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
