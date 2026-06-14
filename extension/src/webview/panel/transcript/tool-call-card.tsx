/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { ToolCall } from '../../../shared/protocol';
import { normalizeToolCallName } from '../../../shared/tool-call-analysis';
import { cx } from '../utils/cx';
import { getToolCallPresentation } from '../tool-call-summary';
import { looksLikePathToken, splitQuotedToken, unwrapQuotedToken } from '../utils/looks-like-path-token';

import { ClickablePathButton } from '../file-path';
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
  summaryModel?: ToolCallHeaderSummaryModel;
  sizeHint?: string;
  errorDetail?: string;
  durationMs?: number;
  onOpenFile: (path: string) => void;
}

interface ToolCallHeaderPathSummaryModel {
  kind: 'path';
  text: string;
  title?: string;
}

interface ToolCallHeaderTextSummaryModel {
  kind: 'text';
  text: string;
}

interface ToolCallHeaderCommandSummaryModel {
  kind: 'command';
  command: string;
  title: string;
  prefix?: string;
  detail?: string;
  pathLeadingQuote?: string;
  pathText?: string;
  pathTrailingQuote?: string;
  suffix?: string;
}

type ToolCallHeaderSummaryModel =
  | ToolCallHeaderPathSummaryModel
  | ToolCallHeaderTextSummaryModel
  | ToolCallHeaderCommandSummaryModel;

const SHELL_WRAPPER_TOKENS = new Set([
  'builtin',
  'command',
  'env',
  'exec',
  'nohup',
  'sudo',
  'time',
]);

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

import { isRecord } from '../../../shared/type-guards';


function normalizeInlineText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function tokenizeShellSnippet(value: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;

  for (const char of value) {
    if (quote) {
      current += char;
      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}

function isCommandSummaryTool(name: string): boolean {
  const normalizedName = normalizeToolCallName(name);
  return normalizedName === 'bash'
    || normalizedName === 'cmd'
    || normalizedName === 'powershell'
    || normalizedName === 'shell'
    || normalizedName === 'sh';
}

function isShellAssignmentToken(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(unwrapQuotedToken(value));
}


function createCommandSummaryModel(commandText: string): ToolCallHeaderCommandSummaryModel | null {
  const normalized = normalizeInlineText(commandText);
  if (!normalized) {
    return null;
  }

  const tokens = tokenizeShellSnippet(normalized);
  if (tokens.length === 0) {
    return null;
  }

  let commandIndex = 0;
  while (commandIndex < tokens.length - 1) {
    const token = unwrapQuotedToken(tokens[commandIndex] ?? '');
    if (SHELL_WRAPPER_TOKENS.has(token) || isShellAssignmentToken(token)) {
      commandIndex += 1;
      continue;
    }
    break;
  }

  const prefix = tokens.slice(0, commandIndex).join(' ');
  const command = tokens[commandIndex] ?? tokens[0];
  const remainder = tokens.slice(commandIndex + 1);
  const pathIndex = remainder.findIndex(looksLikePathToken);
  const detail = (pathIndex >= 0 ? remainder.slice(0, pathIndex) : remainder).join(' ');
  const pathToken = pathIndex >= 0 ? remainder[pathIndex] : undefined;
  const splitPath = pathToken ? splitQuotedToken(pathToken) : null;
  const suffix = pathIndex >= 0 ? remainder.slice(pathIndex + 1).join(' ') : undefined;

  return {
    kind: 'command',
    command,
    title: normalized,
    ...(prefix ? { prefix } : {}),
    ...(detail ? { detail } : {}),
    ...(splitPath?.leadingQuote ? { pathLeadingQuote: splitPath.leadingQuote } : {}),
    ...(splitPath?.text ? { pathText: splitPath.text } : {}),
    ...(splitPath?.trailingQuote ? { pathTrailingQuote: splitPath.trailingQuote } : {}),
    ...(suffix ? { suffix } : {}),
  };
}

function extractCommandText(toolCall: ToolCall | undefined): string | null {
  if (!toolCall || !isCommandSummaryTool(toolCall.name) || !isRecord(toolCall.input)) {
    return null;
  }

  return typeof toolCall.input.command === 'string'
    ? normalizeInlineText(toolCall.input.command) || null
    : null;
}

function buildToolCallHeaderSummaryModel(
  name: string,
  summary: string | null,
  summaryPath?: string,
  toolCall?: ToolCall,
): ToolCallHeaderSummaryModel | null {
  const commandText = extractCommandText(toolCall);
  const commandSummary = commandText && isCommandSummaryTool(toolCall?.name ?? name)
    ? createCommandSummaryModel(commandText)
    : (!commandText && summary && isCommandSummaryTool(name)
      ? createCommandSummaryModel(summary)
      : null);

  if (commandSummary) {
    return commandSummary;
  }

  if (summary && (summaryPath || looksLikePathToken(summary))) {
    return {
      kind: 'path',
      text: summary,
      ...(summaryPath ? { title: summaryPath } : {}),
    };
  }

  return summary
    ? { kind: 'text', text: summary }
    : null;
}

function CollapsedSummary({
  model,
  summaryPath,
  onOpenFile,
}: {
  model: ToolCallHeaderSummaryModel;
  summaryPath?: string;
  onOpenFile: (path: string) => void;
}) {
  if (model.kind === 'text') {
    return (
      <span class="transcript-header-summary-mono block min-w-0 max-w-full flex-1 truncate" title={model.text}>
        {model.text}
      </span>
    );
  }

  if (model.kind === 'path') {
    return (
      <span class="block min-w-0 max-w-full flex-1" title={summaryPath ?? model.title ?? model.text}>
        <ClickablePathButton path={summaryPath ?? model.title ?? model.text} displayText={model.text} onOpenFile={onOpenFile} />
      </span>
    );
  }

  return (
    <span class="transcript-header-command-preview" title={model.title}>
      {model.prefix && <span class="transcript-header-command-prefix transcript-header-summary-subtle">{model.prefix}</span>}
      <span class="transcript-header-command-verb transcript-header-summary-command">{model.command}</span>
      {(model.detail || model.pathText || model.suffix) && (
        <span class="transcript-header-command-details">
          {model.detail && <span class="transcript-header-command-tail transcript-header-summary-mono">{model.detail}</span>}
          {model.pathLeadingQuote && <span class="transcript-header-command-tail transcript-header-summary-subtle">{model.pathLeadingQuote}</span>}
          {model.pathText && <ClickablePathButton path={model.pathText} displayText={model.pathText} />}
          {model.pathTrailingQuote && <span class="transcript-header-command-tail transcript-header-summary-subtle">{model.pathTrailingQuote}</span>}
          {model.suffix && <span class="transcript-header-command-tail transcript-header-summary-subtle">{model.suffix}</span>}
        </span>
      )}
    </span>
  );
}

export function DisclosureChevron({ open }: { open: boolean }) {
  return (
    <svg class={cx('shrink-0 text-muted transition-transform duration-150', open && 'rotate-90')} width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <polyline points="3,2 7,5 3,8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}

export function ToolCallHeader({ open, name, nameTitle, status, summary, summaryPath, summaryModel, sizeHint, errorDetail, durationMs, onOpenFile }: ToolCallHeaderProps) {
  const statusTone =
    status === 'failed' ? 'failed'
    : null;
  const statusLabel =
    status === 'failed' ? 'Failed'
    : null;
  const collapsedSummaryModel = summaryModel ?? buildToolCallHeaderSummaryModel(name, summary, summaryPath);
  const showSummary = !open && !!collapsedSummaryModel;
  const showSizeHint = !open && !!sizeHint;
  const durationLabel =
    status !== 'running' && typeof durationMs === 'number' && durationMs >= 0
      ? formatDuration(durationMs)
      : null;

  return (
    <div class="flex items-center gap-[7px] rounded-md px-2 py-[5px]">
      <DisclosureChevron open={open} />
      <div class={cx('flex min-w-0 flex-1 items-center gap-2', (showSummary || showSizeHint) && 'gap-1.5')}>
        <span class="transcript-header-title-mono min-w-0 flex-[0_1_auto] truncate" title={nameTitle}>{name}</span>
        {showSummary && collapsedSummaryModel ? (
          <CollapsedSummary model={collapsedSummaryModel} summaryPath={summaryPath} onOpenFile={onOpenFile} />
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
  const summaryModel = buildToolCallHeaderSummaryModel(
    toolCall.name,
    presentation.summary,
    presentation.summaryPath,
    toolCall,
  );

  return (
    <div
      class={cx(
        'cursor-pointer select-none overflow-hidden rounded-xl border-l-2 border-l-transparent bg-card shadow-sm transition-all duration-150 hover:bg-control-hover hover:shadow-md',
        'forced-colors:border forced-colors:border-[ButtonText]',
        toolCall.status === 'failed' && 'border-l-danger/50',
        toolCall.status === 'completed' && 'border-l-success/30',
        presentation.variant === 'skill-load' && 'bg-accent/5 skill-load-glow',
        className,
      )}
      role="button"
      aria-expanded={open}
      aria-label="Toggle tool call details"
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
        summaryModel={summaryModel ?? undefined}
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
