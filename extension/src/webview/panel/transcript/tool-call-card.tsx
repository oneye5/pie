/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { ToolCall } from '../../../shared/protocol';
import { cx } from '../utils/cx';
import { getToolCallPresentation } from '../tool-call-summary';

import { formatDuration } from './header';
import { StatusChip } from './status-chip';
import { useDisclosureOpen } from './use-disclosure-open';

interface ToolCallCardProps {
  toolCall: ToolCall;
  autoExpand: boolean;
  className?: string;
  workingDirectory: string | null;
  onOpenFile: (path: string) => void;
  onContextMenu: (e: MouseEvent) => void;
}

interface ToolCallHeaderProps {
  open: boolean;
  name: string;
  nameTitle?: string;
  status: ToolCall['status'];
  summary: string | null;
  summaryPath?: string;
  sizeHint?: string;
  errorDetail?: string;
  durationMs?: number;
  onOpenFile: (path: string) => void;
}

function textFromToolCallResultContent(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') {
    return undefined;
  }

  const content = (result as { content?: unknown }).content;
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return undefined;
  }

  const text = content
    .filter((part): part is { type?: string; text?: string } => Boolean(part) && typeof part === 'object')
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text ?? '')
    .join('\n\n');

  return text || undefined;
}

export function formatToolCallResultForDisplay(toolCall: Pick<ToolCall, 'name' | 'result'>): string {
  if (toolCall.result === undefined) {
    return '';
  }

  if (typeof toolCall.result === 'string') {
    return toolCall.result;
  }

  const readableText = toolCall.name === 'subagent'
    ? textFromToolCallResultContent(toolCall.result)
    : undefined;

  return readableText ?? JSON.stringify(toolCall.result, null, 2);
}

export function splitSummaryPath(summary: string): { pathSection: string | null; fileSection: string } {
  const lastSeparatorIndex = Math.max(summary.lastIndexOf('/'), summary.lastIndexOf('\\'));
  if (lastSeparatorIndex < 0 || lastSeparatorIndex >= summary.length - 1) {
    return { pathSection: null, fileSection: summary };
  }

  return {
    pathSection: summary.slice(0, lastSeparatorIndex + 1),
    fileSection: summary.slice(lastSeparatorIndex + 1),
  };
}

export function DisclosureChevron({ open }: { open: boolean }) {
  return (
    <svg class={cx('shrink-0 text-muted transition-transform duration-150', open && 'rotate-90')} width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <polyline points="3,2 7,5 3,8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}

export function ToolCallHeader({ open, name, nameTitle, status, summary, summaryPath, sizeHint, errorDetail, durationMs, onOpenFile }: ToolCallHeaderProps) {
  const statusTone =
    status === 'running' ? 'running'
    : status === 'failed' ? 'failed'
    : null;
  const statusLabel =
    status === 'running' ? 'Running'
    : status === 'failed' ? 'Failed'
    : null;
  const showSummary = !open && !!summary;
  const showSizeHint = !open && !!sizeHint;
  const pathSummary = summaryPath && summary ? splitSummaryPath(summary) : null;
  const durationLabel =
    status !== 'running' && typeof durationMs === 'number' && durationMs >= 0
      ? formatDuration(durationMs)
      : null;

  return (
    <div class="flex items-center gap-[7px] rounded-md px-2 py-[5px]">
      <DisclosureChevron open={open} />
      <div class={cx('flex min-w-0 flex-1 items-center gap-2', (showSummary || showSizeHint) && 'gap-1.5')}>
        <span class="min-w-0 flex-auto truncate font-mono text-xs font-semibold" title={nameTitle}>{name}</span>
        {showSummary ? (
          summaryPath ? (
            <button
              type="button"
              class="group block min-w-0 max-w-[var(--tool-call-summary-column-width)] flex-[0_1_auto] cursor-pointer rounded-md border-0 bg-transparent p-0 text-left focus-visible:outline-1 focus-visible:outline-accent focus-visible:outline-offset-1"
              title={summaryPath}
              onMouseDown={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onOpenFile(summaryPath);
              }}
            >
              {pathSummary ? (
                <span class="flex min-w-0 items-center gap-1.5">
                  <span class={cx('block min-w-0 truncate text-left font-mono text-[11px] text-muted opacity-70 [direction:rtl] transition-colors duration-150 group-hover:opacity-85 group-focus-visible:opacity-85', !pathSummary.pathSection && 'opacity-0')}><span class="[direction:ltr] [unicode-bidi:isolate]">{pathSummary.pathSection ?? ''}</span></span>
                  <span class="inline-flex min-w-0 max-w-full flex-none items-center truncate rounded-sm bg-control px-[7px] py-px font-mono text-[11px] text-foreground ring-1 ring-inset ring-border-subtle transition-colors duration-150 group-hover:bg-control-hover group-hover:ring-border group-focus-visible:bg-control-hover group-focus-visible:ring-border">{pathSummary.fileSection}</span>
                </span>
              ) : <span class="block min-w-0 max-w-[var(--tool-call-summary-column-width)] flex-[0_1_auto] truncate font-mono text-[11px] text-muted">{summary}</span>}
            </button>
          ) : <span class="block min-w-0 max-w-[var(--tool-call-summary-column-width)] flex-[0_1_auto] truncate font-mono text-[11px] text-muted">{summary}</span>
        ) : null}
        {showSizeHint && <span class="ml-auto block min-w-0 max-w-[var(--tool-call-size-column-width)] flex-[0_0_var(--tool-call-size-column-width)] truncate text-right font-mono text-[10px] text-muted/50">{sizeHint}</span>}
      </div>
      {durationLabel && <span class="ml-auto flex-none whitespace-nowrap font-mono text-[10px] text-muted/60 [font-variant-numeric:tabular-nums]" title="Tool execution time">{durationLabel}</span>}
      {statusTone && statusLabel && (
        <StatusChip
          tone={statusTone}
          label={statusLabel}
          className="status-chip-fixed"
          copyText={errorDetail}
          copyAriaLabel={errorDetail ? 'Copy tool-call error detail' : undefined}
        />
      )}
    </div>
  );
}

export function ToolCallCard({
  toolCall,
  autoExpand,
  className,
  workingDirectory,
  onOpenFile,
  onContextMenu,
}: ToolCallCardProps) {
  const [open, setOpen] = useDisclosureOpen(`tool:${toolCall.id}`, autoExpand);
  const presentation = getToolCallPresentation(toolCall, { workingDirectory });
  const errorDetail = toolCall.status === 'failed' ? formatToolCallResultForDisplay(toolCall) || undefined : undefined;

  return (
    <div
      class={cx(
        'cursor-pointer select-none overflow-hidden rounded-xl border-l-2 border-l-transparent bg-card shadow-sm transition-all duration-150 hover:bg-control-hover hover:shadow-md',
        'forced-colors:border forced-colors:border-[ButtonText]',
        toolCall.status === 'running' && 'border-l-accent/40',
        toolCall.status === 'failed' && 'border-l-danger/50',
        toolCall.status === 'completed' && 'border-l-success/30',
        presentation.variant === 'skill-load' && 'bg-accent/5',
        className,
      )}
      role="button"
      aria-expanded={open}
      tabIndex={0}
      onClick={() => setOpen((v) => !v)}
      onContextMenu={(e) => { e.preventDefault(); onContextMenu(e as unknown as MouseEvent); }}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen((v) => !v); } }}
    >
      <ToolCallHeader
        open={open}
        name={presentation.name}
        status={toolCall.status}
        summary={presentation.summary}
        summaryPath={presentation.summaryPath}
        sizeHint={presentation.sizeHint}
        errorDetail={errorDetail}
        durationMs={toolCall.durationMs}
        onOpenFile={onOpenFile}
      />
      {open && (
        <div class="tool-call-body">
          <div class="tool-call-section">
            <div class="tool-call-section-label">Input</div>
            <pre class="tool-call-pre">{JSON.stringify(toolCall.input, null, 2)}</pre>
          </div>
          {toolCall.result !== undefined && (
            <div class="tool-call-section">
              <div class="tool-call-section-label">Result</div>
              <pre class="tool-call-pre">{formatToolCallResultForDisplay(toolCall)}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
