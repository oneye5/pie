/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { Virtualizer, elementScroll, observeElementOffset, observeElementRect } from '@tanstack/virtual-core';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';

import { type ChatMessage, type ChatPrefs, type SystemPromptEntry, type ToolCall, type TranscriptWindow } from '../../shared/protocol';
import type { Overlay } from './overlay';
import { advanceSmoothScrollTop, isNearBottom, resolveAutoFollowState } from './auto-scroll';
import { SystemPromptMessage } from './system-prompts';
import { MessageItem } from './transcript/message-item';
import { ToolCallItem } from './transcript/tool-call-item';
import type { RenderToolCall, TranscriptContextMenuHandler } from './transcript/types';

interface TranscriptVirtualListProps {
  sessionKey: string | null;
  transcript: ChatMessage[];
  transcriptWindow: TranscriptWindow;
  busy: boolean;
  overlay: Overlay;
  prefs: ChatPrefs;
  systemPrompts: SystemPromptEntry[];
  workingDirectory: string | null;
  editingId: string | null;
  onEditRequest: (messageId: string) => void;
  onEditConfirm: (messageId: string, text: string) => void;
  onEditCancel: () => void;
  onOpenFile: (path: string) => void;
  onContextMenu: TranscriptContextMenuHandler;
  onLoadOlder: () => void;
  onLoadNewer: () => void;
  onJumpToLatest: () => void;
}

type TranscriptRow =
  | { kind: 'systemPrompts'; key: string }
  | { kind: 'topGap'; key: string }
  | { kind: 'message'; key: string; message: ChatMessage }
  | { kind: 'bottomGap'; key: string };

interface ScrollAnchor {
  messageId: string;
  offsetTop: number;
}

const MANUAL_SCROLL_INTENT_GRACE_MS = 280;
const INITIAL_BOTTOM_SNAP_FRAMES = 3;

function getEstimateSize(row: TranscriptRow): number {
  if (row.kind === 'systemPrompts') {
    return 140;
  }
  if (row.kind === 'topGap' || row.kind === 'bottomGap') {
    return 56;
  }
  return row.message.role === 'user' ? 120 : 180;
}

function captureTopAnchor(container: HTMLDivElement): ScrollAnchor | null {
  const containerTop = container.getBoundingClientRect().top;
  const candidates = Array.from(container.querySelectorAll<HTMLElement>('[data-message-id]'));
  for (const candidate of candidates) {
    const rect = candidate.getBoundingClientRect();
    if (rect.bottom <= containerTop) {
      continue;
    }

    const messageId = candidate.dataset.messageId;
    if (!messageId) {
      continue;
    }

    return {
      messageId,
      offsetTop: rect.top - containerTop,
    };
  }

  return null;
}

function restoreTopAnchor(container: HTMLDivElement, anchor: ScrollAnchor | null): void {
  if (!anchor) {
    return;
  }

  const containerTop = container.getBoundingClientRect().top;
  const candidates = Array.from(container.querySelectorAll<HTMLElement>('[data-message-id]'));
  const match = candidates.find((candidate) => candidate.dataset.messageId === anchor.messageId);
  if (!match) {
    return;
  }

  const delta = match.getBoundingClientRect().top - containerTop - anchor.offsetTop;
  if (Math.abs(delta) < 1) {
    return;
  }

  container.scrollTop += delta;
}

export function TranscriptVirtualList({
  sessionKey,
  transcript,
  transcriptWindow,
  busy,
  overlay,
  prefs,
  systemPrompts,
  workingDirectory,
  editingId,
  onEditRequest,
  onEditConfirm,
  onEditCancel,
  onOpenFile,
  onContextMenu,
  onLoadOlder,
  onLoadNewer,
  onJumpToLatest,
}: TranscriptVirtualListProps) {
  const [renderTick, setRenderTick] = useState(0);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [isInitialPositioning, setIsInitialPositioning] = useState(true);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const [isLoadingNewer, setIsLoadingNewer] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const autoFollowRef = useRef(true);
  const renderFrameRef = useRef<number | null>(null);
  const followFrameRef = useRef<number | null>(null);
  const initialBottomFrameRef = useRef<number | null>(null);
  const smoothFollowTargetRef = useRef<number | null>(null);
  const initialBottomFramesRemainingRef = useRef(0);
  const lastScrollTopRef = useRef(0);
  const manualScrollIntentUntilRef = useRef(0);
  const pointerScrollIntentRef = useRef(false);
  const pendingJumpToLatestSnapRef = useRef(false);
  const pendingOlderAnchorRef = useRef<ScrollAnchor | null>(null);
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

  const scheduleVirtualRender = useCallback(() => {
    if (renderFrameRef.current !== null) {
      return;
    }

    renderFrameRef.current = window.requestAnimationFrame(() => {
      renderFrameRef.current = null;
      setRenderTick((value) => value + 1);
    });
  }, []);

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
      pendingOlderAnchorRef.current = captureTopAnchor(element);
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
    }, 1500);
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
    }, 1500);
  }, [clearLoadingNewerTimeout, onLoadNewer]);

  const rows = useMemo<TranscriptRow[]>(() => {
    const nextRows: TranscriptRow[] = [];
    if (systemPrompts.length > 0) {
      nextRows.push({ kind: 'systemPrompts', key: 'system-prompts' });
    }
    if (transcriptWindow.hasOlder) {
      nextRows.push({ kind: 'topGap', key: 'gap:older' });
    }
    for (const message of transcript) {
      nextRows.push({ kind: 'message', key: `message:${message.id}`, message });
    }
    if (transcriptWindow.hasNewer) {
      nextRows.push({ kind: 'bottomGap', key: 'gap:newer' });
    }
    return nextRows;
  }, [systemPrompts.length, transcript, transcriptWindow.hasOlder, transcriptWindow.hasNewer]);

  const virtualizerRef = useRef<Virtualizer<HTMLDivElement, HTMLDivElement> | null>(null);

  if (!virtualizerRef.current) {
    virtualizerRef.current = new Virtualizer<HTMLDivElement, HTMLDivElement>({
      count: rows.length,
      getScrollElement: () => scrollRef.current,
      estimateSize: (index) => getEstimateSize(rows[index] ?? { kind: 'bottomGap', key: 'fallback-gap' }),
      getItemKey: (index) => rows[index]?.key ?? index,
      scrollToFn: elementScroll,
      observeElementRect,
      observeElementOffset,
      initialOffset: () => Number.MAX_SAFE_INTEGER,
      overscan: 10,
      onChange: scheduleVirtualRender,
    });
  }

  const virtualizer = virtualizerRef.current;
  virtualizer.setOptions({
    ...virtualizer.options,
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => getEstimateSize(rows[index] ?? rows[rows.length - 1] ?? { kind: 'bottomGap', key: 'fallback-gap' }),
    getItemKey: (index) => rows[index]?.key ?? index,
    scrollToFn: elementScroll,
    observeElementRect,
    observeElementOffset,
    initialOffset: () => Number.MAX_SAFE_INTEGER,
    overscan: 10,
    onChange: scheduleVirtualRender,
  });

  useEffect(() => {
    const cleanup = virtualizer._didMount();
    return cleanup;
  }, [virtualizer]);

  useLayoutEffect(() => {
    virtualizer._willUpdate();
  }, [virtualizer, rows.length, renderTick]);

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
      restoreTopAnchor(element, pendingOlderAnchorRef.current);
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
    transcriptWindow.hasNewer,
    transcriptWindow.hasOlder,
    transcriptWindow.loadedEnd,
    transcriptWindow.loadedStart,
    transcript.length,
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
  }, [busy, overlay, scheduleScrollToBottom, transcript.length, transcriptWindow.hasNewer]);

  useEffect(() => {
    return () => {
      clearLoadingOlderTimeout();
      clearLoadingNewerTimeout();
      if (renderFrameRef.current !== null) {
        window.cancelAnimationFrame(renderFrameRef.current);
        renderFrameRef.current = null;
      }
      stopSmoothFollow();
      stopInitialBottomSnap();
    };
  }, [clearLoadingNewerTimeout, clearLoadingOlderTimeout, stopInitialBottomSnap, stopSmoothFollow]);

  const renderToolCallRef = useRef<RenderToolCall>((_toolCall, _contextMenuHandler) => null);
  const renderToolCall = useCallback<RenderToolCall>((toolCall: ToolCall, contextMenuHandler: TranscriptContextMenuHandler) => (
    <ToolCallItem
      toolCall={toolCall}
      prefs={prefs}
      workingDirectory={workingDirectory}
      onOpenFile={onOpenFile}
      onContextMenu={contextMenuHandler}
      renderToolCall={renderToolCallRef.current}
    />
  ), [onOpenFile, prefs, workingDirectory]);
  renderToolCallRef.current = renderToolCall;

  const measureRowElement = useCallback((element: HTMLDivElement | null) => {
    if (element) {
      virtualizer.measureElement(element);
    }
  }, [virtualizer]);

  const virtualRows = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();

  return (
    <div class={`transcript transcript-virtual${isInitialPositioning ? ' transcript-positioning' : ''}`} ref={scrollRef}>
      <div class="transcript-virtual-inner" style={{ height: `${totalSize}px` }}>
        {virtualRows.map((virtualRow) => {
          const row = rows[virtualRow.index];
          if (!row) {
            return null;
          }

          return (
            <div
              key={row.key}
              data-index={virtualRow.index}
              ref={measureRowElement}
              class={`transcript-virtual-row transcript-virtual-row-${row.kind}`}
              style={{ transform: `translateY(${virtualRow.start}px)` }}
            >
              {row.kind === 'systemPrompts' && (
                <SystemPromptMessage prompts={systemPrompts} />
              )}

              {row.kind === 'topGap' && (
                <div class="transcript-gap-row">
                  <button
                    type="button"
                    class="transcript-gap-btn"
                    disabled={isLoadingOlder}
                    onClick={() => {
                      requestOlderPage();
                    }}
                  >
                    {isLoadingOlder ? 'Loading older messages…' : 'Load older messages'}
                  </button>
                </div>
              )}

              {row.kind === 'message' && (() => {
                const overlayParts = overlay.partsByMessage.get(row.message.id);
                const isStreaming = busy && row.message.role === 'assistant' && row.message.status === 'streaming';
                const isLastAssistantMessage = busy
                  && row.message.role === 'assistant'
                  && rows.length > 0
                  && rows[rows.length - 1] === row;
                return (
                  <MessageItem
                    key={row.message.id}
                    message={row.message}
                    overlayParts={overlayParts}
                    isStreaming={isStreaming}
                    prefs={prefs}
                    readonly={busy}
                    workingDirectory={workingDirectory}
                    editingId={editingId}
                    onEditRequest={onEditRequest}
                    onEditConfirm={onEditConfirm}
                    onEditCancel={onEditCancel}
                    onOpenFile={onOpenFile}
                    onContextMenu={onContextMenu}
                    renderToolCall={renderToolCall}
                    isLastAssistantMessage={isLastAssistantMessage}
                  />
                );
              })()}

              {row.kind === 'bottomGap' && (
                <div class="transcript-gap-row transcript-gap-row-bottom">
                  <button
                    type="button"
                    class="transcript-gap-btn"
                    disabled={isLoadingNewer}
                    onClick={requestNewerPage}
                  >
                    {isLoadingNewer ? 'Loading newer messages…' : 'Load newer messages'}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {(!isAtBottom || transcriptWindow.hasNewer) && (
        <button
          type="button"
          class="transcript-jump-latest"
          aria-label="Jump to latest"
          title="Jump to latest"
          onClick={() => {
            autoFollowRef.current = true;
            if (transcriptWindow.hasNewer) {
              pendingJumpToLatestSnapRef.current = true;
              onJumpToLatest();
            } else {
              scrollToBottom();
              startInitialBottomSnap(false);
            }
          }}
        >
          <span aria-hidden="true">↓</span>
        </button>
      )}
    </div>
  );
}
