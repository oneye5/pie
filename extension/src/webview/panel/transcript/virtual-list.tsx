/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { VirtualItem, Virtualizer, elementScroll, observeElementOffset, observeElementRect } from '@tanstack/virtual-core';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';

import { type ChatMessage, type ChatPrefs, type PruningResult, type PruningSettings, type SystemPromptEntry, type ThinkingLevel, type ToolCall, type TranscriptWindow } from '../../../shared/protocol';
import { deriveTurnActivityState } from './activity';
import { ToolCallItem } from './tool-call-item';
import { useTranscriptScroll } from './use-transcript-scroll';
import { cx } from '../utils/cx';
import type { RenderToolCall, TranscriptContextMenuHandler } from './types';
import { TranscriptVirtualRow } from './virtual-list-row';
import { buildTranscriptRows, estimateTranscriptRowSize, type TranscriptRow } from './virtual-list-rows';

interface TranscriptVirtualListProps {
  sessionKey: string | null;
  transcript: ChatMessage[];
  transcriptWindow: TranscriptWindow;
  busy: boolean;
  prefs: ChatPrefs;
  pruningSettings: PruningSettings;
  systemPrompts: SystemPromptEntry[];
  pruningResult: PruningResult | null;
  pendingAssistantModelId?: string;
  pendingAssistantThinkingLevel?: ThinkingLevel;
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

function fallbackTranscriptRow(rows: readonly TranscriptRow[]): TranscriptRow {
  return rows[rows.length - 1] ?? { kind: 'bottomGap', key: 'fallback-gap' };
}

function getRowRole(row: TranscriptRow | undefined): string | null {
  if (row?.kind === 'message') return row.message.role;
  if (row?.kind === 'systemPrompts') return 'system';
  return null;
}

function useTranscriptRows({
  transcript,
  systemPrompts,
  transcriptWindow,
  busy,
  pruningResult,
  prefs,
  pruningSettings,
  pendingAssistantModelId,
  pendingAssistantThinkingLevel,
}: {
  transcript: ChatMessage[];
  systemPrompts: SystemPromptEntry[];
  transcriptWindow: TranscriptWindow;
  busy: boolean;
  pruningResult: PruningResult | null;
  prefs: ChatPrefs;
  pruningSettings: PruningSettings;
  pendingAssistantModelId?: string;
  pendingAssistantThinkingLevel?: ThinkingLevel;
}) {
  const activityState = useMemo(() => deriveTurnActivityState({
    busy,
    transcript,
    prefs,
    pruningSettings,
    pendingAssistantModelId,
    pendingAssistantThinkingLevel,
  }), [busy, transcript, prefs, pruningSettings, pendingAssistantModelId, pendingAssistantThinkingLevel]);

  const rows = useMemo(() => buildTranscriptRows({
    transcript,
    systemPromptCount: systemPrompts.length,
    hasOlder: transcriptWindow.hasOlder,
    hasNewer: transcriptWindow.hasNewer,
    busy,
    hasPruningResult: pruningResult !== null,
    showPruningMessages: prefs.showPruningMessages,
    activityState,
    pendingAssistantModelId,
    pendingAssistantThinkingLevel,
  }), [systemPrompts.length, transcript, transcriptWindow.hasOlder, transcriptWindow.hasNewer, busy, pruningResult, prefs.showPruningMessages, activityState, pendingAssistantModelId, pendingAssistantThinkingLevel]);

  return rows;
}

function useTranscriptVirtualizer(
  rows: readonly TranscriptRow[],
  scrollRef: { current: HTMLDivElement | null },
) {
  const [, setRenderTick] = useState(0);
  const renderFrameRef = useRef<number | null>(null);

  const scheduleVirtualRender = useCallback(() => {
    if (renderFrameRef.current !== null) {
      return;
    }

    renderFrameRef.current = window.requestAnimationFrame(() => {
      renderFrameRef.current = null;
      setRenderTick((value) => value + 1);
    });
  }, []);

  const virtualizerRef = useRef<Virtualizer<HTMLDivElement, HTMLDivElement> | null>(null);
  if (!virtualizerRef.current) {
    virtualizerRef.current = new Virtualizer<HTMLDivElement, HTMLDivElement>({
      count: rows.length,
      getScrollElement: () => scrollRef.current,
      estimateSize: (index) => estimateTranscriptRowSize(rows[index] ?? fallbackTranscriptRow(rows)),
      getItemKey: (index) => rows[index]?.key ?? index,
      scrollToFn: elementScroll,
      observeElementRect,
      observeElementOffset,
      initialOffset: () => Number.MAX_SAFE_INTEGER,
      overscan: 10,
      // Batch ResizeObserver-driven re-measurements with the next animation
      // frame. Without this, content that grows after initial measurement
      // (streaming markdown, late-loading tables/images) can leave a one-paint
      // window where the cached row size is smaller than the rendered height,
      // causing the next absolute-positioned row to overlap the previous one
      // (visible as a user-message bubble painted over an earlier assistant
      // message). The animation-frame batching closes that race.
      useAnimationFrameWithResizeObserver: true,
      onChange: scheduleVirtualRender,
    });
  }

  const virtualizer = virtualizerRef.current;

  useLayoutEffect(() => {
    virtualizer.setOptions({
      ...virtualizer.options,
      count: rows.length,
      getScrollElement: () => scrollRef.current,
      estimateSize: (index) => estimateTranscriptRowSize(rows[index] ?? fallbackTranscriptRow(rows)),
      getItemKey: (index) => rows[index]?.key ?? index,
      overscan: 10,
      useAnimationFrameWithResizeObserver: true,
      onChange: scheduleVirtualRender,
    });
    virtualizer._willUpdate();
  }, [rows, scheduleVirtualRender, virtualizer]);

  useEffect(() => {
    const cleanup = virtualizer._didMount();
    return cleanup;
  }, [virtualizer]);

  useEffect(() => () => {
    if (renderFrameRef.current !== null) {
      window.cancelAnimationFrame(renderFrameRef.current);
      renderFrameRef.current = null;
    }
  }, []);

  return virtualizer;
}

function useTranscriptRenderToolCall({
  prefs,
  workingDirectory,
  onOpenFile,
}: {
  prefs: ChatPrefs;
  workingDirectory: string | null;
  onOpenFile: (path: string) => void;
}) {
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
  return renderToolCall;
}

function useTranscriptClickHandler() {
  const handlers: Record<string, (target: HTMLElement, btn: Element) => void> = {
    '.code-block-copy': (_target, btn) => {
      const code = btn.closest('.code-block')?.querySelector('code');
      const text = code?.textContent ?? '';
      if (text) {
        void navigator.clipboard?.writeText(text);
        btn.classList.add('copied');
        window.setTimeout(() => btn.classList.remove('copied'), 1200);
      }
    },
    '.code-block-toggle': (_target, btn) => {
      const block = btn.closest('.code-block');
      if (!block) return;
      // Preserve the original "Show all N lines" label for re-collapse.
      if (!btn.getAttribute('data-collapsed-label')) {
        btn.setAttribute('data-collapsed-label', btn.textContent ?? 'Show all');
      }
      const collapsed = block.classList.toggle('code-block-collapsed');
      btn.setAttribute('aria-expanded', String(!collapsed));
      btn.textContent = collapsed
        ? btn.getAttribute('data-collapsed-label') ?? 'Show all'
        : 'Show less';
    },
  };

  return useCallback((event: MouseEvent) => {
    const target = event.target as HTMLElement | null;
    if (!target) return;

    for (const [selector, handler] of Object.entries(handlers)) {
      const btn = target.closest(selector);
      if (btn) {
        handler(target, btn);
        return;
      }
    }
  }, []);
}

interface VirtualRowProps {
  virtualRow: VirtualItem;
  rows: readonly TranscriptRow[];
  lastRow: TranscriptRow | undefined;
  busy: boolean;
  prefs: ChatPrefs;
  systemPrompts: SystemPromptEntry[];
  pruningResult: PruningResult | null;
  workingDirectory: string | null;
  editingId: string | null;
  isLoadingOlder: boolean;
  isLoadingNewer: boolean;
  onEditRequest: (messageId: string) => void;
  onEditConfirm: (messageId: string, text: string) => void;
  onEditCancel: () => void;
  onOpenFile: (path: string) => void;
  onContextMenu: TranscriptContextMenuHandler;
  onRequestOlder: () => void;
  onRequestNewer: () => void;
  renderToolCall: RenderToolCall;
  transcript: ChatMessage[];
  transcriptWindow: TranscriptWindow;
  measureRowElement: (element: HTMLDivElement | null) => void;
}

function VirtualRow({
  virtualRow,
  rows,
  lastRow,
  busy,
  prefs,
  systemPrompts,
  pruningResult,
  workingDirectory,
  editingId,
  isLoadingOlder,
  isLoadingNewer,
  onEditRequest,
  onEditConfirm,
  onEditCancel,
  onOpenFile,
  onContextMenu,
  onRequestOlder,
  onRequestNewer,
  renderToolCall,
  transcript,
  transcriptWindow,
  measureRowElement,
}: VirtualRowProps) {
  const row = rows[virtualRow.index];
  if (!row) {
    return null;
  }

  const previousRole = getRowRole(rows[virtualRow.index - 1]);
  const currentRole = getRowRole(row);
  const isRoleTransition = !!previousRole && !!currentRole && previousRole !== currentRole;

  return (
    <div
      data-index={virtualRow.index}
      ref={measureRowElement}
      class={cx(
        'absolute start-0 top-0 box-border flex w-full flex-col items-start',
        isRoleTransition ? 'pb-4' : 'pb-1.5',
      )}
      style={{ transform: `translateY(${virtualRow.start}px)` }}
    >
      <TranscriptVirtualRow
        row={row}
        busy={busy}
        prefs={prefs}
        systemPrompts={systemPrompts}
        pruningResult={pruningResult}
        workingDirectory={workingDirectory}
        editingId={editingId}
        isLoadingOlder={isLoadingOlder}
        isLoadingNewer={isLoadingNewer}
        isLastRow={row === lastRow}
        onEditRequest={onEditRequest}
        onEditConfirm={onEditConfirm}
        onEditCancel={onEditCancel}
        onOpenFile={onOpenFile}
        onContextMenu={onContextMenu}
        onRequestOlder={onRequestOlder}
        onRequestNewer={onRequestNewer}
        renderToolCall={renderToolCall}
        transcript={transcript}
        transcriptIndex={row.kind === 'message' ? row.transcriptIndex : undefined}
        hasOlder={transcriptWindow.hasOlder}
      />
    </div>
  );
}

export function TranscriptVirtualList({
  sessionKey,
  transcript,
  transcriptWindow,
  busy,
  prefs,
  pruningSettings,
  systemPrompts,
  pruningResult,
  pendingAssistantModelId,
  pendingAssistantThinkingLevel,
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
  const rows = useTranscriptRows({
    transcript,
    systemPrompts,
    transcriptWindow,
    busy,
    pruningResult,
    prefs,
    pruningSettings,
    pendingAssistantModelId,
    pendingAssistantThinkingLevel,
  });

  const {
    scrollRef,
    isAtBottom,
    isInitialPositioning,
    isLoadingOlder,
    isLoadingNewer,
    requestOlderPage,
    requestNewerPage,
    jumpToLatest,
  } = useTranscriptScroll({
    sessionKey,
    transcriptWindow,
    transcriptLength: transcript.length,
    onLoadOlder,
    onLoadNewer,
    onJumpToLatest,
  });

  const virtualizer = useTranscriptVirtualizer(rows, scrollRef);

  const renderToolCall = useTranscriptRenderToolCall({
    prefs,
    workingDirectory,
    onOpenFile,
  });

  // Re-affirm the row element with the virtualizer on every render. A stable
  // useCallback ref only fires on mount/unmount, so subsequent renders never
  // re-measure — but the row's content can change height after mount (e.g.,
  // markdown tables, streaming text, images). Using an unstable ref forces
  // Preact to invoke it each render, which (a) re-binds tanstack's
  // ResizeObserver to the node and (b) synchronously re-measures, preventing
  // stale `virtualRow.start` values from causing visual row overlap.
  const measureRowElement = (element: HTMLDivElement | null) => {
    if (element) {
      virtualizer.measureElement(element);
    }
  };

  const handleTranscriptClick = useTranscriptClickHandler();

  const virtualRows = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();
  const lastRow = rows[rows.length - 1];

  return (
    <div
      class={`transcript transcript-virtual${isInitialPositioning ? ' transcript-positioning' : ''}`}
      ref={scrollRef}
      onClick={handleTranscriptClick}
    >
      <div class="transcript-virtual-inner" style={{ height: `${totalSize}px` }}>
        {virtualRows.map((virtualRow) => (
          <VirtualRow
            key={virtualRow.key}
            virtualRow={virtualRow}
            rows={rows}
            lastRow={lastRow}
            busy={busy}
            prefs={prefs}
            systemPrompts={systemPrompts}
            pruningResult={pruningResult}
            workingDirectory={workingDirectory}
            editingId={editingId}
            isLoadingOlder={isLoadingOlder}
            isLoadingNewer={isLoadingNewer}
            onEditRequest={onEditRequest}
            onEditConfirm={onEditConfirm}
            onEditCancel={onEditCancel}
            onOpenFile={onOpenFile}
            onContextMenu={onContextMenu}
            onRequestOlder={requestOlderPage}
            onRequestNewer={requestNewerPage}
            renderToolCall={renderToolCall}
            transcript={transcript}
            transcriptWindow={transcriptWindow}
            measureRowElement={measureRowElement}
          />
        ))}
      </div>

      {(!isAtBottom || transcriptWindow.hasNewer) && (
        <button
          type="button"
          class="transcript-jump-latest"
          aria-label="Jump to latest"
          title="Jump to latest"
          onClick={jumpToLatest}
        >
          <span aria-hidden="true">↓</span>
        </button>
      )}
    </div>
  );
}
