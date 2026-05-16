/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { ToolCall } from '../../../shared/protocol';
import { getToolCallPresentation } from '../tool-call-summary';

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

export function ToolCallHeader({ open, name, nameTitle, status, summary, summaryPath, sizeHint, errorDetail, onOpenFile }: ToolCallHeaderProps) {
  const statusLabel =
    status === 'running' ? 'Running'
    : status === 'failed' ? 'Failed'
    : null;
  const showSummary = !open && !!summary;
  const showSizeHint = !open && !!sizeHint;
  const pathSummary = summaryPath && summary ? splitSummaryPath(summary) : null;

  const handleStatusClick = (e: MouseEvent) => {
    e.stopPropagation();
    if (!errorDetail) return;
    const target = e.currentTarget as HTMLElement;
    navigator.clipboard.writeText(errorDetail);
    target.dataset.copied = '';
    setTimeout(() => { delete target.dataset.copied; }, 1200);
  };

  return (
    <div class="tool-call-header">
      <svg class={`thinking-block-chevron${open ? ' open' : ''}`} width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
        <polyline points="3,2 7,5 3,8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      <div class={`tool-call-heading${showSummary ? ' with-summary' : ''}${showSizeHint && !showSummary ? ' with-size-hint' : ''}`}>
        <span class={`tool-call-name${showSummary ? ' with-summary' : ''}`} title={nameTitle}>{name}</span>
        {showSummary ? (
          summaryPath ? (
            <button
              type="button"
              class="tool-call-summary-link"
              title={summaryPath}
              onMouseDown={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onOpenFile(summaryPath);
              }}
            >
              {pathSummary ? (
                <span class="tool-call-summary tool-call-summary-file">
                  <span class={`tool-call-file-path${pathSummary.pathSection ? '' : ' is-empty'}`}><span class="tool-call-file-path-text">{pathSummary.pathSection ?? ''}</span></span>
                  <span class="tool-call-file-name">{pathSummary.fileSection}</span>
                </span>
              ) : <span class="tool-call-summary">{summary}</span>}
            </button>
          ) : <span class="tool-call-summary">{summary}</span>
        ) : null}
        {showSizeHint && <span class="tool-call-size-hint">{sizeHint}</span>}
      </div>
      <span
        class={`tool-call-status${statusLabel ? ` ${status}` : ' is-empty'}${errorDetail ? ' has-error-detail' : ''}`}
        aria-hidden={statusLabel ? undefined : 'true'}
        title={errorDetail ?? undefined}
        onClick={errorDetail ? handleStatusClick : undefined}
      ><span class="tool-call-status-label">{statusLabel ?? ''}</span></span>
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
  const variantClass = presentation.variant ? ` tool-call-variant-${presentation.variant}` : '';
  const customClass = className ? ` ${className}` : '';
  const errorDetail = toolCall.status === 'failed' ? formatToolCallResultForDisplay(toolCall) || undefined : undefined;

  return (
    <div
      class={`tool-call ${toolCall.status}${variantClass}${customClass}`}
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
