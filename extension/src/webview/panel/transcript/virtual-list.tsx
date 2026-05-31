/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { Virtualizer, elementScroll, observeElementOffset, observeElementRect } from '@tanstack/virtual-core';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';

import { type ChatMessage, type ChatPrefs, type PruningResult, type PruningSettings, type SystemPromptEntry, type ThinkingLevel, type ToolCall, type TranscriptWindow } from '../../../shared/protocol';
import { deriveTurnActivityState, type TurnActivityState } from './activity';
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
  const [renderTick, setRenderTick] = useState(0);
  const renderFrameRef = useRef<number | null>(null);

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
    busy,
    hasStreamingContent: busy && transcript.some(m => m.status === 'streaming'),
    onLoadOlder,
    onLoadNewer,
    onJumpToLatest,
  });

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
      onChange: scheduleVirtualRender,
    });
  }

  const virtualizer = virtualizerRef.current;

  // Update virtualizer options only when relevant deps change
  useLayoutEffect(() => {
    virtualizer.setOptions({
      ...virtualizer.options,
      count: rows.length,
      getScrollElement: () => scrollRef.current,
      estimateSize: (index) => estimateTranscriptRowSize(rows[index] ?? fallbackTranscriptRow(rows)),
      getItemKey: (index) => rows[index]?.key ?? index,
      overscan: 10,
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
  const lastRow = rows[rows.length - 1];

  // Delegated handler for code-block affordances injected by renderMarkdown.
  const handleTranscriptClick = useCallback((event: MouseEvent) => {
    const target = event.target as HTMLElement | null;
    if (!target) return;

    const copyBtn = target.closest('.code-block-copy');
    if (copyBtn) {
      const code = copyBtn.closest('.code-block')?.querySelector('code');
      const text = code?.textContent ?? '';
      if (text) {
        void navigator.clipboard?.writeText(text);
        copyBtn.classList.add('copied');
        window.setTimeout(() => copyBtn.classList.remove('copied'), 1200);
      }
      return;
    }

    const toggleBtn = target.closest('.code-block-toggle');
    if (toggleBtn) {
      const block = toggleBtn.closest('.code-block');
      if (block) {
        // Preserve the original "Show all N lines" label for re-collapse.
        if (!toggleBtn.getAttribute('data-collapsed-label')) {
          toggleBtn.setAttribute('data-collapsed-label', toggleBtn.textContent ?? 'Show all');
        }
        const collapsed = block.classList.toggle('code-block-collapsed');
        toggleBtn.setAttribute('aria-expanded', String(!collapsed));
        toggleBtn.textContent = collapsed
          ? toggleBtn.getAttribute('data-collapsed-label') ?? 'Show all'
          : 'Show less';
      }
    }
  }, []);

  return (
    <div
      class={`transcript transcript-virtual${isInitialPositioning ? ' transcript-positioning' : ''}`}
      ref={scrollRef}
      onClick={handleTranscriptClick}
    >
      <div class="transcript-virtual-inner" style={{ height: `${totalSize}px` }}>
        {virtualRows.map((virtualRow) => {
          const row = rows[virtualRow.index];
          if (!row) {
            return null;
          }

          const previousRow = rows[virtualRow.index - 1];
          const previousRole = previousRow?.kind === 'message'
            ? previousRow.message.role
            : previousRow?.kind === 'systemPrompts'
              ? 'system'
              : null;
          const currentRole = row.kind === 'message'
            ? row.message.role
            : row.kind === 'systemPrompts'
              ? 'system'
              : null;
          const isRoleTransition = !!previousRole && !!currentRole && previousRole !== currentRole;

          return (
            <div
              key={row.key}
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
                onRequestOlder={requestOlderPage}
                onRequestNewer={requestNewerPage}
                renderToolCall={renderToolCall}
                transcript={transcript}
                transcriptIndex={row.kind === 'message' ? row.transcriptIndex : undefined}
                hasOlder={transcriptWindow.hasOlder}
              />
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
          onClick={jumpToLatest}
        >
          <span aria-hidden="true">↓</span>
        </button>
      )}
    </div>
  );
}
